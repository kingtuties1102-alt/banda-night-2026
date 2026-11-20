const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');

// --- ZERO-DEPENDENCY .ENV LOADER ---
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (_) {}
const { sendTicketReceipt, sendTestEmail } = require('./email');
const { sendSmsReceipt, sendTestSms } = require('./sms');

// --- TWILIO CONFIGURATION (can also be set via admin dashboard) ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'tickets.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- STRIPE CONFIGURATION ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://banda-night-2026-1.onrender.com';

function getStripeConfig(db) {
  const secretKey = (db?.config?.stripe?.secretKey || process.env.STRIPE_SECRET_KEY || '').trim();
  const publishableKey = (db?.config?.stripe?.publishableKey || process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
  const webhookSecret = (db?.config?.stripe?.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  return {
    secretKey,
    publishableKey,
    webhookSecret,
    configured: Boolean(secretKey && !secretKey.includes('REPLACE')),
  };
}

/**
 * Call the Stripe REST API directly (zero npm dependencies).
 * Mirrors the stripe npm SDK pattern but via native https.
 */
function stripeRequest(method, path, body, apiVersion) {
  return new Promise((resolve, reject) => {
    const isGet = method === 'GET';
    // For GET requests with body params, append as query string
    const queryStr = (isGet && body && Object.keys(body).length)
      ? '?' + new URLSearchParams(flattenForStripe(body)).toString()
      : '';
    const payload = !isGet && body ? new URLSearchParams(flattenForStripe(body)).toString() : '';
    const req = https.request({
      hostname: 'api.stripe.com',
      path: path + queryStr,
      method,
      headers: {
        'Authorization': `Bearer ${getStripeConfig(loadDB()).secretKey}`, 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'Stripe-Version': apiVersion || '2026-02-25.preview',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.error?.message || `Stripe HTTP ${res.statusCode}`));
        } catch (e) { reject(new Error(`Stripe parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Stripe request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Ensure a Stripe Product exists for the given tier (Managed Payments flow).
 * Creates the product with tax_code txcd_10103100 (digital/event admission).
 * Caches the returned default_price ID in db.config.stripePrices[tierName].
 */
/**
 * Create or retrieve a Stripe Product for a given tier.
 * Uses inline price_data per checkout session so each tier has the correct price.
 */
async function getStripeLineItem(tierName, priceInDollars) {
  // Use inline price_data so each tier gets the correct price dynamically
  return {
    price_data: {
      currency: 'usd',
      unit_amount: Math.round(priceInDollars * 100), // Convert dollars to cents
      product_data: {
        name: `Banda Night 2026 — ${tierName} Admission`,
        description: 'Sigma Lambda Beta · Sigma Gamma Chapter · January 9th, 2026 · Doors 9:00 PM PST',
        tax_code: 'txcd_10103100',
      },
    },
    quantity: 1,
  };
}

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 * Returns the parsed event or throws on invalid signature.
 */
function constructStripeEvent(rawBody, signature, secret) {
  // Stripe signature format: t=timestamp,v1=hmac,...
  const parts = {};
  signature.split(',').forEach(p => { const [k, v] = p.split('='); parts[k] = v; });
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) throw new Error('Invalid Stripe-Signature header');

  // Replay attack prevention: reject events older than 5 minutes
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > tolerance) {
    throw new Error('Stripe webhook timestamp too old');
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  if (expected !== v1) throw new Error('Stripe webhook signature mismatch');

  return JSON.parse(rawBody);
}

/** Flatten nested objects for Stripe's form-encoded API (e.g. line_items[0][price]) */
function flattenForStripe(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenForStripe(val, fullKey));
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (typeof item === 'object') {
          Object.assign(result, flattenForStripe(item, `${fullKey}[${i}]`));
        } else {
          result[`${fullKey}[${i}]`] = item;
        }
      });
    } else if (val !== null && val !== undefined) {
      result[fullKey] = String(val);
    }
  }
  return result;
}

// --- VENMO CONFIGURATION ---
// Default Venmo username if not set in config
let VENMO_USERNAME = process.env.VENMO_USERNAME || 'Betas_UCSB';

// --- DATABASE HELPERS ---
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const initial = { tickets: [], pendingSessions: {}, config: { venmoUsername: VENMO_USERNAME } };
      fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
      return initial;
    }
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!data.tickets) data.tickets = [];
    if (!data.pendingSessions) data.pendingSessions = {};
    if (!data.config) data.config = { venmoUsername: VENMO_USERNAME };
    return data;
  } catch (err) {
    console.error('Error reading database:', err);
    return { tickets: [], pendingSessions: {}, config: { venmoUsername: VENMO_USERNAME } };
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Error saving database:', err);
  }
}

// --- TIER CONFIGURATION ---
const TIERS = [
  { id: 'early', name: 'Early Bird', limit: 100, price: 15, desc: 'First 100 tickets' },
  { id: 'standard', name: 'Standard Tier', limit: 100, price: 20, desc: 'Next 100 tickets (101–200)' },
  { id: 'late', name: 'Late Entry', limit: Infinity, price: 25, desc: 'Tickets 201+' },
];

function getCurrentTierInfo(db) {
  const activeTickets = (db.tickets || []).filter(t => t.paymentStatus !== 'REFUNDED');
  const totalSold = activeTickets.length;
  let cumulative = 0;

  for (let i = 0; i < TIERS.length; i++) {
    cumulative += TIERS[i].limit;
    if (totalSold < cumulative) {
      const remaining = TIERS[i].limit === Infinity ? 'Unlimited' : (cumulative - totalSold);
      return {
        currentTier: TIERS[i],
        tierIndex: i,
        ticketsSold: totalSold,
        remainingInTier: remaining,
        tiers: TIERS.map((t, idx) => ({
          ...t,
          isCurrent: idx === i,
          isSoldOut: idx < i,
          isUpcoming: idx > i,
        })),
      };
    }
  }

  const last = TIERS[TIERS.length - 1];
  return {
    currentTier: last,
    tierIndex: TIERS.length - 1,
    ticketsSold: totalSold,
    remainingInTier: 'Unlimited',
    tiers: TIERS.map((t, idx) => ({
      ...t,
      isCurrent: idx === TIERS.length - 1,
      isSoldOut: idx < TIERS.length - 1,
      isUpcoming: false,
    })),
  };
}

// Simple Luhn validator for card check
function isValidCardNumber(num) {
  const cleaned = (num || '').replace(/\D/g, '');
  if (cleaned.length < 13 || cleaned.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    let digit = parseInt(cleaned.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function detectCardBrand(num) {
  const cleaned = (num || '').replace(/\D/g, '');
  if (/^4/.test(cleaned)) return 'Visa';
  if (/^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/.test(cleaned)) return 'Mastercard';
  if (/^3[47]/.test(cleaned)) return 'Amex';
  if (/^6(?:011|5)/.test(cleaned)) return 'Discover';
  return 'Credit Card';
}

// MIME dictionary
const MIME = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      req.rawBody = raw;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// --- SERVER INSTANCE ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Add standard security & caching headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Helper to verify admin authorization header
  function checkAdminAuth(req) {
    const db = loadDB();
    const activePin = (process.env.ADMIN_PIN || db.config?.adminPin || 'betas1986').trim();
    const clientPin = (req.headers['x-admin-pin'] || '').trim();
    return Boolean(clientPin && clientPin === activePin);
  }

  // --- API: Tier & Status ---
  if (pathname === '/api/tier' && req.method === 'GET') {
    const db = loadDB();
    const info = getCurrentTierInfo(db);
    const venmoUser = db.config?.venmoUsername || VENMO_USERNAME;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ...info,
      venmoUsername: venmoUser,
      venmoConfigured: Boolean(venmoUser && venmoUser !== 'YOUR-VENMO-USERNAME'),
      stripeConfigured: getStripeConfig(db).configured,
      stripePublishableKey: getStripeConfig(db).publishableKey,
    }));
  }

  // --- API: Create Product (Blueprint: create-product-chapter) ---
  if ((pathname === '/api/create-product' || pathname === '/create-product') && req.method === 'POST') {
    const db_chk = loadDB();
    if (!getStripeConfig(db_chk).configured) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' }));
    }
    try {
      const product = await createOneTimeProduct();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        product,
        default_price: product.default_price,
      }));
    } catch (err) {
      console.error('[STRIPE ERROR] create-product:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'Failed to create product.' }));
    }
  }

  // --- API: Create Stripe Checkout Session ---
  if ((pathname === '/api/create-checkout-session' || pathname === '/create-checkout-session') && req.method === 'POST') {
    const db_chk = loadDB();
    if (!getStripeConfig(db_chk).configured) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' }));
    }

    const body = await parseBody(req);
    const db = loadDB();

    try {
      // 1. Get current tier info and price
      const tierInfo = getCurrentTierInfo(db);
      const currentTier = tierInfo.currentTier;
      const tierPrice = currentTier.price; // e.g. 15, 20, 25
      const tierName = currentTier.name;   // e.g. "Early Bird"

      const ticketId = body.ticketId || ('SLB-' + crypto.randomBytes(6).toString('hex').toUpperCase());
      const securityToken = crypto.randomBytes(16).toString('hex');
      const buyerName = (body.name || body.buyerName || 'Attendee').trim();
      const buyerEmail = (body.email || body.buyerEmail || body.customer_email || 'attendee@example.com').trim().toLowerCase();
      const buyerPhone = (body.phone || body.buyerPhone || '').trim();

      // 2. Build line item with correct tier name and price
      const lineItem = await getStripeLineItem(tierName, tierPrice);

      // 3. Create hosted Checkout Session
      const sessionParams = {
        mode: 'payment',
        line_items: [lineItem],
        success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BASE_URL}/#tickets`,
      };

      if (buyerEmail && buyerEmail.includes('@')) {
        sessionParams.customer_email = buyerEmail;
      }

      const session = await stripeRequest('POST', '/v1/checkout/sessions', sessionParams);

      // 4. Persist pending ticket keyed by Stripe session ID
      if (!db.pendingSessions) db.pendingSessions = {};
      db.pendingSessions[session.id] = {
        ticketId,
        securityToken,
        buyerName,
        buyerEmail,
        buyerPhone,
        tier: tierName,
        price: tierPrice,
        purchasedAt: new Date().toISOString(),
        checkedIn: false,
        checkedInAt: null,
        paymentStatus: 'STRIPE_PENDING',
        method: 'CARD',
        stripeSessionId: session.id,
      };
      saveDB(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        url: session.url,
        id: session.id,
        ticketId,
      }));
    } catch (err) {
      console.error('[STRIPE ERROR] create-checkout-session:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'Failed to create payment session.' }));
    }
  }

  // --- API: Webhook Listener (Blueprint: handle-webhooks-chapter) ---
  if ((pathname === '/api/webhook' || pathname === '/webhook') && req.method === 'POST') {
    const body = await parseBody(req);
    const signature = req.headers['stripe-signature'];
    let event;

    if (STRIPE_WEBHOOK_SECRET && signature) {
      try {
        event = constructStripeEvent(req.rawBody, signature, STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.error('[STRIPE WEBHOOK ERROR] Signature verification failed:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Webhook Error: ${err.message}` }));
      }
    } else {
      event = body;
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object || {};
      const sessionId = session.id;
      console.log(`[STRIPE WEBHOOK] checkout.session.completed for session: ${sessionId}`);

      const db = loadDB();
      if (!db.pendingSessions) db.pendingSessions = {};

      let ticket = (db.tickets || []).find(t => t.stripeSessionId === sessionId);
      if (!ticket && db.pendingSessions[sessionId]) {
        const pending = db.pendingSessions[sessionId];
        ticket = {
          ...pending,
          paymentStatus: 'PAID',
          paidAt: new Date().toISOString(),
          stripeSessionId: sessionId,
          method: 'CARD',
        };
        db.tickets.push(ticket);
        delete db.pendingSessions[sessionId];
        saveDB(db);

        // Send notifications
        const emailConfig = db.config?.email || {};
        const smsConfig = {
          twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
          twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
          twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
          venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
        };
        sendTicketReceipt(ticket, { ...emailConfig, venmoUsername: db.config?.venmoUsername || VENMO_USERNAME }, BASE_URL).catch(() => {});
        sendSmsReceipt(ticket, smsConfig, BASE_URL).catch(() => {});
      } else if (ticket) {
        ticket.paymentStatus = 'PAID';
        ticket.paidAt = ticket.paidAt || new Date().toISOString();
        saveDB(db);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ received: true }));
  }

  // --- API: Verify Payment (for success.html verification) ---
  if ((pathname === '/api/verify-payment' || pathname === '/verify-payment') && req.method === 'POST') {
    const body = await parseBody(req);
    const sessionId = body.sessionId || body.session_id;

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'sessionId required.' }));
    }

    const db = loadDB();
    if (!db.pendingSessions) db.pendingSessions = {};

    let ticket = (db.tickets || []).find(t => t.stripeSessionId === sessionId);
    if (ticket && ticket.paymentStatus === 'PAID') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ticket: { ...ticket, name: ticket.buyerName } }));
    }

    try {
      const session = await stripeRequest('GET', `/v1/checkout/sessions/${sessionId}`, {}, '2026-02-25.preview');
      if (session.payment_status === 'paid') {
        const pending = db.pendingSessions[sessionId] || {
          ticketId: 'SLB-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
          buyerName: session.customer_details?.name || 'Customer',
          buyerEmail: session.customer_details?.email || '',
          tier: 'Hamlet (e-book)',
          price: 10,
        };

        if (!ticket) {
          ticket = {
            ...pending,
            paymentStatus: 'PAID',
            paidAt: new Date().toISOString(),
            stripeSessionId: sessionId,
            method: 'CARD',
          };
          db.tickets.push(ticket);
          delete db.pendingSessions[sessionId];
          saveDB(db);
        } else {
          ticket.paymentStatus = 'PAID';
          ticket.paidAt = new Date().toISOString();
          saveDB(db);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, ticket: { ...ticket, name: ticket.buyerName } }));
      } else {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payment has not been completed.' }));
      }
    } catch (err) {
      console.error('[STRIPE ERROR] verify-payment:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'Error verifying payment.' }));
    }
  }

  // --- API: Finalize ticket after Stripe Checkout completes ---
  if (pathname === '/api/checkout-complete' && req.method === 'POST') {
    const body = await parseBody(req);
    const { session_id } = body;

    if (!session_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'session_id required.' }));
    }

    const db = loadDB();
    if (!db.pendingSessions) db.pendingSessions = {};

    // Check if already finalized (idempotent)
    const existing = db.tickets.find(t => t.stripeSessionId === session_id);
    if (existing) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ticket: existing }));
    }

    const pending = db.pendingSessions[session_id];
    if (!pending) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Session not found.' }));
    }

    try {
      // Verify payment status with Stripe
      const session = await stripeRequest('GET', `/v1/checkout/sessions/${session_id}`, {});
      if (session.payment_status !== 'paid') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payment not yet confirmed by Stripe.' }));
      }

      // Extract card details from payment intent
      let cardBrand = '';
      let cardLast4 = '';
      if (session.payment_intent) {
        try {
          const pi = await stripeRequest('GET', `/v1/payment_intents/${session.payment_intent}?expand[]=payment_method`, {});
          cardBrand = pi.payment_method?.card?.brand || '';
          cardLast4 = pi.payment_method?.card?.last4 || '';
        } catch (_) { /* non-fatal */ }
      }

      const ticket = {
        ...pending,
        paymentStatus: 'PAID',
        paidAt: new Date().toISOString(),
        cardBrand,
        cardLast4,
        stripeSessionId: session_id,
        method: 'CARD',
      };

      db.tickets.push(ticket);
      delete db.pendingSessions[session_id];
      saveDB(db);

      // Send email + SMS receipts
      const emailConfig = db.config?.email || {};
      const smsConfig = {
        twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
        twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
        twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
        venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
      };
      sendTicketReceipt(ticket, { ...emailConfig, venmoUsername: db.config?.venmoUsername || VENMO_USERNAME }, BASE_URL)
        .then(r => { ticket.emailStatus = r.simulated ? 'SIMULATED' : 'SENT'; ticket.emailSentAt = new Date().toISOString(); saveDB(db); })
        .catch(e => { ticket.emailStatus = 'FAILED'; ticket.emailError = e.message; saveDB(db); });
      sendSmsReceipt(ticket, smsConfig, BASE_URL)
        .then(r => { if (!r.skipped) { ticket.smsStatus = 'SENT'; ticket.smsSentAt = new Date().toISOString(); saveDB(db); } })
        .catch(e => { ticket.smsStatus = 'FAILED'; ticket.smsError = e.message; saveDB(db); });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ticket }));
    } catch (err) {
      console.error('[STRIPE ERROR] checkout-complete:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'Could not finalize ticket.' }));
    }
  }

  // --- API: Purchase (supports both card and Venmo) ---
  if (pathname === '/api/purchase' && req.method === 'POST') {
    const body = await parseBody(req);
    const { name, email, phone, paymentMethod, cardNumber, cardExp, cardCvc, zip } = body;

    if (!name || !name.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Please enter your full name.' }));
    }
    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Please enter a valid email address.' }));
    }

    // Determine payment method
    const method = paymentMethod || 'card';

    // Card-specific validation (only if paying by card)
    let cardBrand = '';
    let cardLast4 = '';
    if (method === 'card') {
      const rawCard = (cardNumber || '').replace(/\s+/g, '');
      if (!rawCard || rawCard.length < 13) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Please enter a valid 16-digit card number.' }));
      }
      if (!cardExp || !/^\d{2}\s*\/\s*\d{2,4}$/.test(cardExp.trim())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Please enter a valid expiration date (MM/YY).' }));
      }
      if (!cardCvc || cardCvc.length < 3) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Please enter the 3 or 4 digit security code (CVC).' }));
      }

      // Restrict test cards (4242... and 4000...) to authorized chapter admins only
      if (rawCard.startsWith('42424242') || rawCard.startsWith('400000')) {
        if (!checkAdminAuth(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Test cards are restricted to authorized chapter administrators.' }));
        }
      }

      cardBrand = detectCardBrand(rawCard);
      cardLast4 = rawCard.slice(-4);
    }

    const db = loadDB();
    const info = getCurrentTierInfo(db);
    const tier = info.currentTier;

    const ticketId = 'SLB-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const securityToken = crypto.randomBytes(16).toString('hex');

    const ticket = {
      ticketId,
      securityToken,
      buyerName: name.trim(),
      buyerEmail: email.trim().toLowerCase(),
      buyerPhone: (phone || '').trim(),
      tier: tier.name,
      price: tier.price,
      cardBrand: cardBrand || '',
      cardLast4: cardLast4 || '',
      purchasedAt: new Date().toISOString(),
      checkedIn: false,
      checkedInAt: null,
      paymentStatus: method === 'venmo' ? 'VENMO_PENDING' : 'PAID',
      method: method.toUpperCase(),
      emailStatus: 'SENDING',
      emailSentAt: null,
      emailError: null,
    };

    db.tickets.push(ticket);
    saveDB(db);

    // Asynchronously dispatch email receipt to attendee
    const emailConfig = db.config?.email || {};
    const smsConfig = {
      twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
      twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
      twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
      venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
    };

    sendTicketReceipt(ticket, {
      ...emailConfig,
      venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
    }, BASE_URL)
      .then(result => {
        ticket.emailStatus = result.simulated ? 'SIMULATED' : 'SENT';
        ticket.emailSentAt = new Date().toISOString();
        ticket.emailProvider = result.provider || 'simulated';
        saveDB(db);
        console.log(`[RECEIPT] Email dispatched to ${ticket.buyerEmail} for ticket ${ticket.ticketId}`);
      })
      .catch(emailErr => {
        console.error(`[RECEIPT ERROR] Failed to send email to ${ticket.buyerEmail}:`, emailErr.message);
        ticket.emailStatus = 'FAILED';
        ticket.emailError = emailErr.message;
        saveDB(db);
      });

    // Asynchronously dispatch SMS receipt to attendee (if phone provided + Twilio configured)
    sendSmsReceipt(ticket, smsConfig, BASE_URL)
      .then(result => {
        if (!result.skipped) {
          ticket.smsStatus = 'SENT';
          ticket.smsSentAt = new Date().toISOString();
          saveDB(db);
          console.log(`[SMS] Text receipt sent to ${ticket.buyerPhone} for ticket ${ticket.ticketId}`);
        } else {
          console.log(`[SMS] Skipped for ${ticket.ticketId}: ${result.reason}`);
        }
      })
      .catch(smsErr => {
        console.error(`[SMS ERROR] Failed to send SMS to ${ticket.buyerPhone}:`, smsErr.message);
        ticket.smsStatus = 'FAILED';
        ticket.smsError = smsErr.message;
        saveDB(db);
      });

    const venmoUser = db.config?.venmoUsername || VENMO_USERNAME;
    const venmoNote = `Banda Night - ${ticket.ticketId} - ${ticket.buyerName}`;
    const venmoDeepLink = `https://venmo.com/${venmoUser}?txn=pay&amount=${tier.price}&note=${encodeURIComponent(venmoNote)}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      venmoDeepLink: method === 'venmo' ? venmoDeepLink : null,
      venmoUsername: venmoUser,
      ticket: {
        ticketId: ticket.ticketId,
        buyerName: ticket.buyerName,
        buyerEmail: ticket.buyerEmail,
        tier: ticket.tier,
        price: ticket.price,
        cardBrand: ticket.cardBrand,
        cardLast4: ticket.cardLast4,
        paymentStatus: ticket.paymentStatus,
        method: ticket.method,
        purchasedAt: ticket.purchasedAt,
        securityToken: ticket.securityToken,
      },
    }));
  }

  // --- API: Door Check-in Verification ---
  if (pathname === '/api/checkin' && req.method === 'POST') {
    if (!checkAdminAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. Chapter passcode required.' }));
    }

    const body = await parseBody(req);
    let { ticketId, confirmVenmo } = body;

    if (!ticketId || typeof ticketId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket ID is required.' }));
    }

    ticketId = ticketId.trim().toUpperCase();
    // Allow parsing if full JSON was scanned from QR
    try {
      if (ticketId.startsWith('{')) {
        const parsed = JSON.parse(ticketId);
        if (parsed.ticketId) ticketId = parsed.ticketId.toUpperCase();
      }
    } catch (e) {
      // not JSON
    }

    const db = loadDB();
    const ticket = db.tickets.find(t => t.ticketId.toUpperCase() === ticketId);

    if (!ticket) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        valid: false,
        message: 'Invalid Ticket — Code not found in database.',
      }));
    }

    if (ticket.paymentStatus === 'REFUNDED') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        valid: false,
        isRefunded: true,
        message: '⛔ TICKET VOID / REFUNDED — Do NOT allow entry!',
        ticket,
      }));
    }

    // Door check: Is ticket paid?
    if (ticket.paymentStatus !== 'PAID') {
      if (confirmVenmo && ticket.paymentStatus === 'VENMO_PENDING') {
        // Door staff verified and confirmed payment on the spot
        ticket.paymentStatus = 'PAID';
        ticket.paidAt = new Date().toISOString();
        const emailConfig = db.config?.email || {};
        sendTicketReceipt(ticket, {
          ...emailConfig,
          venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
        }, BASE_URL).catch(e => console.error('Venmo checkin email error:', e.message));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          valid: false,
          isPending: true,
          message: '⚠️ UNPAID TICKET — Venmo payment is still pending! Verify transfer before admitting.',
          ticket,
        }));
      }
    }

    if (ticket.checkedIn) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        valid: false,
        alreadyCheckedIn: true,
        message: `⚠️ ALREADY SCANNED! Checked in on ${new Date(ticket.checkedInAt).toLocaleTimeString()}`,
        ticket,
      }));
    }

    // Mark as checked in
    ticket.checkedIn = true;
    ticket.checkedInAt = new Date().toISOString();
    saveDB(db);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      valid: true,
      message: '✅ ADMISSION GRANTED! Welcome to Banda Night.',
      ticket,
    }));
  }

  // --- API: Admin Passcode Login / Verification ---
  if (pathname === '/api/admin/verify-pin' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = loadDB();
    const activePin = (process.env.ADMIN_PIN || db.config?.adminPin || 'betas1986').trim();
    const submittedPin = (body.pin || '').trim();

    if (submittedPin && submittedPin === activePin) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Authenticated' }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Incorrect chapter passcode' }));
    }
  }

  // Intercept any other /api/admin/* endpoint and require valid PIN
  if (pathname.startsWith('/api/admin/')) {
    if (!checkAdminAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. Valid chapter passcode required.' }));
    }
  }

  // --- API: Admin Data ---
  if (pathname === '/api/admin/tickets' && req.method === 'GET') {
    const db = loadDB();
    const info = getCurrentTierInfo(db);
    const activeTickets = db.tickets.filter(t => t.paymentStatus !== 'REFUNDED');
    const totalRevenue = activeTickets.filter(t => t.paymentStatus === 'PAID').reduce((acc, t) => acc + (t.price || 0), 0);
    const checkedInCount = activeTickets.filter(t => t.checkedIn).length;
    const venmoPending = activeTickets.filter(t => t.paymentStatus === 'VENMO_PENDING').length;
    const refundedCount = db.tickets.filter(t => t.paymentStatus === 'REFUNDED').length;
    const venmoUser = db.config?.venmoUsername || VENMO_USERNAME;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      tickets: [...db.tickets].reverse(),
      totalSold: activeTickets.length,
      totalRevenue,
      checkedInCount,
      venmoPending,
      refundedCount,
      venmoUsername: venmoUser,
      currentTier: info.currentTier,
      tiers: info.tiers,
    }));
  }

  // --- API: Admin Venmo, Email & SMS Config ---
  if (pathname === '/api/admin/config' && req.method === 'GET') {
    const db = loadDB();
    const venmoUser = db.config?.venmoUsername || VENMO_USERNAME;
    const emailConfig = db.config?.email || {};
    const twilioConfig = db.config?.twilio || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      venmoUsername: venmoUser,
      adminPinConfigured: Boolean(db.config?.adminPin || process.env.ADMIN_PIN),
      email: {
        provider: emailConfig.provider || (emailConfig.resendApiKey ? (emailConfig.resendApiKey.startsWith('SG.') ? 'sendgrid' : 'resend') : (emailConfig.smtpHost ? 'smtp' : 'simulated')),
        resendApiKey: emailConfig.resendApiKey ? '••••••••' + emailConfig.resendApiKey.slice(-4) : '',
        apiKeyType: emailConfig.resendApiKey ? (emailConfig.resendApiKey.startsWith('SG.') ? 'sendgrid' : (emailConfig.resendApiKey.startsWith('re_') ? 'resend' : 'other')) : '',
        smtpHost: emailConfig.smtpHost || '',
        smtpPort: emailConfig.smtpPort || 465,
        smtpUser: emailConfig.smtpUser || '',
        hasSmtpPass: Boolean(emailConfig.smtpPass),
        fromEmail: emailConfig.fromEmail || '',
      },
      twilio: {
        accountSid: twilioConfig.accountSid ? '••••••••' + twilioConfig.accountSid.slice(-4) : (TWILIO_ACCOUNT_SID ? '••••(env)' : ''),
        hasAuthToken: Boolean(twilioConfig.authToken || TWILIO_AUTH_TOKEN),
        fromNumber: twilioConfig.fromNumber || TWILIO_FROM_NUMBER || '',
        configured: Boolean((twilioConfig.accountSid || TWILIO_ACCOUNT_SID) && (twilioConfig.authToken || TWILIO_AUTH_TOKEN) && (twilioConfig.fromNumber || TWILIO_FROM_NUMBER)),
      },
      stripe: {
        publishableKey: getStripeConfig(db).publishableKey,
        hasSecretKey: Boolean(getStripeConfig(db).secretKey),
        configured: getStripeConfig(db).configured,
      },
    }));
  }

  if (pathname === '/api/admin/config' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = loadDB();
    if (!db.config) db.config = {};
    if (typeof body.venmoUsername === 'string') {
      const clean = body.venmoUsername.trim().replace(/^@/, '');
      db.config.venmoUsername = clean;
      VENMO_USERNAME = clean;
    }
    if (typeof body.adminPin === 'string' && body.adminPin.trim().length >= 4) {
      db.config.adminPin = body.adminPin.trim();
    }
    if (body.email && typeof body.email === 'object') {
      if (!db.config.email) db.config.email = {};
      if (body.email.provider) db.config.email.provider = body.email.provider;
      if (body.email.resendApiKey && !body.email.resendApiKey.includes('••••')) {
        db.config.email.resendApiKey = body.email.resendApiKey.trim();
      }
      if (body.email.smtpHost !== undefined) db.config.email.smtpHost = body.email.smtpHost.trim();
      if (body.email.smtpPort !== undefined) db.config.email.smtpPort = parseInt(body.email.smtpPort, 10) || 465;
      if (body.email.smtpUser !== undefined) db.config.email.smtpUser = body.email.smtpUser.trim();
      if (body.email.smtpPass && !body.email.smtpPass.includes('••••')) {
        db.config.email.smtpPass = body.email.smtpPass.trim();
      }
      if (body.email.fromEmail !== undefined) db.config.email.fromEmail = body.email.fromEmail.trim();
    }
    // Save Twilio credentials from dashboard
    if (body.twilio && typeof body.twilio === 'object') {
      if (!db.config.twilio) db.config.twilio = {};
      if (body.twilio.accountSid && !body.twilio.accountSid.includes('••••')) {
        db.config.twilio.accountSid = body.twilio.accountSid.trim();
      }
      if (body.twilio.authToken && !body.twilio.authToken.includes('••••')) {
        db.config.twilio.authToken = body.twilio.authToken.trim();
      }
      if (body.twilio.fromNumber !== undefined) {
        db.config.twilio.fromNumber = body.twilio.fromNumber.trim();
      }
    }
    // Save Stripe credentials from dashboard
    if (body.stripe && typeof body.stripe === 'object') {
      if (!db.config.stripe) db.config.stripe = {};
      if (body.stripe.publishableKey !== undefined && !body.stripe.publishableKey.includes('••••')) {
        db.config.stripe.publishableKey = body.stripe.publishableKey.trim();
      }
      if (body.stripe.secretKey && !body.stripe.secretKey.includes('••••')) {
        db.config.stripe.secretKey = body.stripe.secretKey.trim();
      }
      if (body.stripe.webhookSecret && !body.stripe.webhookSecret.includes('••••')) {
        db.config.stripe.webhookSecret = body.stripe.webhookSecret.trim();
      }
    }
    saveDB(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      config: db.config,
    }));
  }

  // --- API: Admin Send Test Email ---
  if (pathname === '/api/admin/test-email' && req.method === 'POST') {
    const body = await parseBody(req);
    const { toEmail } = body;
    if (!toEmail || !toEmail.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Valid email address required.' }));
    }

    const db = loadDB();
    const emailConfig = db.config?.email || {};

    try {
      const result = await sendTestEmail(toEmail.trim(), {
        ...emailConfig,
        venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
      }, BASE_URL);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: result.simulated
          ? `Test receipt logged to console (Simulation mode). Set Resend key or Gmail credentials to deliver to live inboxes.`
          : `Live test receipt sent to ${toEmail} via ${result.provider}!`,
        result,
      }));
    } catch (err) {
      console.error('[TEST EMAIL ERROR]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'Failed to send test email.' }));
    }
  }

  // --- API: Admin Send Test SMS ---
  if (pathname === '/api/admin/test-sms' && req.method === 'POST') {
    const body = await parseBody(req);
    const { toPhone } = body;
    if (!toPhone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Phone number required.' }));
    }

    const db = loadDB();
    const twilioConfig = {
      twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
      twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
      twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
    };

    try {
      const result = await sendTestSms(toPhone.trim(), twilioConfig);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: `Test SMS sent to ${toPhone} via Twilio!`,
        result,
      }));
    } catch (err) {
      console.error('[TEST SMS ERROR]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'Failed to send test SMS.' }));
    }
  }

  // --- API: Resend / Forward Receipt Email ---
  if (pathname === '/api/send-receipt' && req.method === 'POST') {
    if (!checkAdminAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. Valid chapter passcode required.' }));
    }

    const body = await parseBody(req);
    const { ticketId, recipientEmail } = body;

    if (!ticketId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket ID required.' }));
    }

    const db = loadDB();
    const ticket = db.tickets.find(t => t.ticketId === ticketId);

    if (!ticket) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket not found.' }));
    }

    const dispatchTicket = {
      ...ticket,
      buyerEmail: (recipientEmail && recipientEmail.includes('@')) ? recipientEmail.trim().toLowerCase() : ticket.buyerEmail,
    };

    try {
      const emailConfig = db.config?.email || {};
      const result = await sendTicketReceipt(dispatchTicket, {
        ...emailConfig,
        venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
      }, BASE_URL);

      ticket.emailStatus = result.simulated ? 'SIMULATED' : 'SENT';
      ticket.emailSentAt = new Date().toISOString();
      ticket.emailProvider = result.provider || 'simulated';
      ticket.emailError = null;
      saveDB(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: `Receipt dispatched to ${dispatchTicket.buyerEmail}`,
        provider: result.provider || 'simulated',
      }));
    } catch (err) {
      console.error('[RESEND RECEIPT ERROR]', err);
      ticket.emailStatus = 'FAILED';
      ticket.emailError = err.message;
      saveDB(db);

      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'Could not send receipt email.' }));
    }
  }

  // --- API: Public Ticket View for Mobile Pass ---
  if (pathname === '/api/ticket' && req.method === 'GET') {
    const ticketId = url.searchParams.get('id');
    if (!ticketId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket ID required' }));
    }

    const db = loadDB();
    const ticket = db.tickets.find(t => t.ticketId === ticketId);

    if (!ticket) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket not found.' }));
    }

    // Return safe attendee ticket pass data
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      ticket: {
        ticketId: ticket.ticketId,
        securityToken: ticket.securityToken,
        buyerName: ticket.buyerName,
        buyerEmail: ticket.buyerEmail,
        tier: ticket.tier,
        price: ticket.price,
        method: ticket.method,
        paymentStatus: ticket.paymentStatus,
        cardBrand: ticket.cardBrand || 'Card',
        cardLast4: ticket.cardLast4 || '4242',
        purchasedAt: ticket.purchasedAt,
        checkedIn: Boolean(ticket.checkedIn),
        venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
      },
    }));
  }

  // --- API: Admin confirm Venmo payment ---
  if (pathname === '/api/admin/confirm-venmo' && req.method === 'POST') {
    const body = await parseBody(req);
    const { ticketId } = body;

    if (!ticketId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket ID required.' }));
    }

    const db = loadDB();
    const ticket = db.tickets.find(t => t.ticketId === ticketId);

    if (!ticket) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket not found.' }));
    }

    ticket.paymentStatus = 'PAID';
    ticket.paidAt = new Date().toISOString();
    saveDB(db);

    // Automatically send receipt with activated QR code to attendee now that ticket is paid!
    const emailConfig = db.config?.email || {};
    sendTicketReceipt(ticket, {
      ...emailConfig,
      venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
    }, BASE_URL)
      .then(res => console.log(`[RECEIPT] Activated pass emailed to ${ticket.buyerEmail} on Venmo confirm.`))
      .catch(e => console.error('[RECEIPT ERROR] Failed to send activated pass:', e.message));

    // Also fire SMS with unlocked QR pass link
    const smsConfigVenmo = {
      twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
      twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
      twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
      venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
    };
    sendSmsReceipt(ticket, smsConfigVenmo, BASE_URL)
      .then(r => { if (!r.skipped) console.log(`[SMS] Unlocked QR pass SMS sent to ${ticket.buyerPhone} on Venmo confirm.`); })
      .catch(e => console.error('[SMS ERROR] Venmo confirm SMS failed:', e.message));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, ticketId, ticket }));
  }

  // --- API: Admin refund / cancel ticket ---
  if (pathname === '/api/admin/refund' && req.method === 'POST') {
    const body = await parseBody(req);
    const { ticketId } = body;

    if (!ticketId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket ID required.' }));
    }

    const db = loadDB();
    const ticket = db.tickets.find(t => t.ticketId === ticketId);

    if (!ticket) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket not found.' }));
    }

    ticket.paymentStatus = 'REFUNDED';
    ticket.refundedAt = new Date().toISOString();
    saveDB(db);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, ticketId }));
  }

  // --- Serve Static Assets ---
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Access Denied');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎺 BANDA NIGHT 2026 TICKET PLATFORM`);
  console.log(`===============================================`);
  console.log(`✨ Main Event Page:   http://localhost:${PORT}`);
  console.log(`📊 Admin Dashboard:   http://localhost:${PORT}/admin.html`);
  console.log(`🔍 Door Scanner:      http://localhost:${PORT}/scanner.html`);
  console.log(`💳 Card Payments:     Integrated & Ready (Instant Ticket + QR)`);
  console.log(`===============================================\n`);
});
