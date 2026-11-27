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
    const headers = {
      'Authorization': `Bearer ${getStripeConfig(loadDB()).secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (apiVersion) {
      headers['Stripe-Version'] = apiVersion;
    }
    const req = https.request({
      hostname: 'api.stripe.com',
      path: path + queryStr,
      method,
      headers,
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
        name: `Banda Night 2027 — ${tierName} Admission`,
        description: 'Sigma Lambda Beta · Sigma Gamma Chapter · Saturday, January 9th, 2027 · Doors 9:00 PM PST',
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

// --- WRITE MUTEX ---
// Prevents race conditions when multiple users purchase simultaneously.
// All write operations are queued and executed one at a time.
let _dbLockQueue = Promise.resolve();

/**
 * withDBLock(fn) — runs fn() exclusively, queuing any concurrent callers.
 * fn receives a fresh loadDB() snapshot and must call saveDB() inside itself.
 * Usage: const result = await withDBLock(db => { ...mutate db...; saveDB(db); return value; });
 */
function withDBLock(fn) {
  const result = _dbLockQueue.then(() => {
    const db = loadDB();
    return Promise.resolve(fn(db));
  });
  // Always keep the shared queue resolved so one rejected write never poisons subsequent callers
  _dbLockQueue = result.catch((err) => {
    console.error('[DB Lock] Locked operation error:', err.message);
  });
  return result;
}

function updateTicketFields(ticketId, updates) {
  return withDBLock((lockedDb) => {
    const t = (lockedDb.tickets || []).find(x => x.ticketId === ticketId);
    if (t) {
      Object.assign(t, updates);
      saveDB(lockedDb);
    }
  }).catch(err => console.error('[DB Lock] updateTicketFields error:', err));
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

  // maxActiveTierIndex: highest tier index you've manually unlocked (default 0 = Early Bird only)
  const maxActiveTierIndex = typeof db.config?.maxActiveTierIndex === 'number'
    ? db.config.maxActiveTierIndex
    : 0;

  let cumulative = 0;

  for (let i = 0; i < TIERS.length; i++) {
    cumulative += TIERS[i].limit;
    if (totalSold < cumulative) {
      // This is the tier that has capacity — but is it unlocked?
      const tierPaused = i > maxActiveTierIndex;
      const remaining = TIERS[i].limit === Infinity ? 'Unlimited' : (cumulative - totalSold);
      return {
        currentTier: TIERS[i],
        tierIndex: i,
        ticketsSold: totalSold,
        remainingInTier: tierPaused ? 0 : remaining,
        tierPaused,          // true = tier sold out & next drop not yet opened
        maxActiveTierIndex,
        tiers: TIERS.map((t, idx) => ({
          ...t,
          isCurrent: idx === i && !tierPaused,
          isSoldOut: idx < i || (idx === i && tierPaused),
          isUpcoming: idx > i || (idx === i && tierPaused),
          isLocked: idx > maxActiveTierIndex,
        })),
      };
    }
  }

  // All tiers exhausted (sold out completely)
  const last = TIERS[TIERS.length - 1];
  return {
    currentTier: last,
    tierIndex: TIERS.length - 1,
    ticketsSold: totalSold,
    remainingInTier: 'Unlimited',
    tierPaused: false,
    maxActiveTierIndex,
    tiers: TIERS.map((t, idx) => ({
      ...t,
      isCurrent: idx === TIERS.length - 1,
      isSoldOut: idx < TIERS.length - 1,
      isUpcoming: false,
      isLocked: false,
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

  // --- SITE LOCK / MAINTENANCE MODE HELPERS ---
  function isSiteLocked(db) {
    if (process.env.SITE_LOCKED === 'false') return false;
    if (process.env.SITE_LOCKED === 'true') return true;
    return db?.config?.siteLocked !== false;
  }

  function hasPreviewAccess(req, url, db) {
    const activePin = (process.env.ADMIN_PIN || db?.config?.adminPin || 'betas1986').trim();
    const previewParam = (url.searchParams.get('preview') || '').trim();
    if (previewParam && previewParam === activePin) return true;

    const headerPin = (req.headers['x-admin-pin'] || '').trim();
    if (headerPin && headerPin === activePin) return true;

    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/slb_preview=([^;]+)/);
    if (match && decodeURIComponent(match[1].trim()) === activePin) return true;

    return false;
  }

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
      siteLocked: isSiteLocked(db),
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
    if (isSiteLocked(db_chk) && !hasPreviewAccess(req, url, db_chk)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket sales are currently paused. Please check back soon!' }));
    }
    if (!getStripeConfig(db_chk).configured) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' }));
    }

    const body = await parseBody(req);
    const db = loadDB();

    try {
      // 1. Get current tier info and price
      const tierInfo = getCurrentTierInfo(db);

      // Block purchase if the current tier sold out and next drop hasn't been opened yet
      if (tierInfo.tierPaused) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'This tier is sold out! The next ticket drop has not opened yet. Stay tuned for the announcement.' }));
      }

      const currentTier = tierInfo.currentTier;
      const tierPrice = currentTier.price;
      const tierName = currentTier.name;

      const ticketId = body.ticketId || ('SLB-' + crypto.randomBytes(6).toString('hex').toUpperCase());
      const securityToken = crypto.randomBytes(16).toString('hex');
      const buyerName = (body.name || body.buyerName || 'Attendee').trim();
      const buyerEmail = (body.email || body.buyerEmail || body.customer_email || 'attendee@example.com').trim().toLowerCase();
      const buyerPhone = (body.phone || body.buyerPhone || '').trim();

      // 2. Build line item with correct tier name and price
      const lineItem = await getStripeLineItem(tierName, tierPrice);

      // 3. Create hosted Checkout Session (standard instant card checkout — verifies funds in real time)
      const sessionParams = {
        mode: 'payment',
        managed_payments: { enabled: 'false' },
        allowed_payment_method_types: ['card'],
        line_items: [lineItem],
        success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BASE_URL}/#tickets`,
      };

      if (buyerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
        sessionParams.customer_email = buyerEmail;
      }

      const session = await stripeRequest('POST', '/v1/checkout/sessions', sessionParams);

      // 4. Persist pending ticket keyed by Stripe session ID (under lock to avoid overwriting concurrent writes)
      await withDBLock((lockedDb) => {
        if (!lockedDb.pendingSessions) lockedDb.pendingSessions = {};
        lockedDb.pendingSessions[session.id] = {
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
        saveDB(lockedDb);
      });

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

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data?.object || {};
      const sessionId = session.id;
      console.log(`[STRIPE WEBHOOK] ${event.type} for session: ${sessionId} (payment_status=${session.payment_status})`);

      // Strictly verify Stripe confirms actual funds captured (payment_status === 'paid')
      if (session.payment_status !== 'paid') {
        console.log(`[STRIPE WEBHOOK] Skipping session ${sessionId} — payment_status is "${session.payment_status}", not paid.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ received: true, paid: false }));
      }

      // --- MUTEX: prevent duplicate ticket creation from simultaneous webhooks ---
      let ticket;
      let createdNewTicket = false;
      let emailConfig;
      let smsConfig;
      await withDBLock((db) => {
        if (!db.pendingSessions) db.pendingSessions = {};

        ticket = (db.tickets || []).find(t => t.stripeSessionId === sessionId);
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
          createdNewTicket = true;
          console.log(`[MUTEX] Webhook ticket ${ticket.ticketId} written (total: ${db.tickets.length})`);
        } else if (ticket && ticket.paymentStatus !== 'PAID') {
          ticket.paymentStatus = 'PAID';
          ticket.paidAt = ticket.paidAt || new Date().toISOString();
          saveDB(db);
          createdNewTicket = true;
        }
        emailConfig = db.config?.email || {};
        smsConfig = {
          twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
          twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
          twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
          venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
        };
      });

      // Send notifications outside the lock only for newly confirmed tickets
      if (createdNewTicket && ticket) {
        sendTicketReceipt(ticket, { ...emailConfig, venmoUsername: smsConfig.venmoUsername }, BASE_URL).catch(() => {});
        sendSmsReceipt(ticket, smsConfig, BASE_URL).catch(() => {});
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
      const session = await stripeRequest('GET', `/v1/checkout/sessions/${sessionId}`, {});
      if (session.payment_status === 'paid') {
        let cardBrand = '';
        let cardLast4 = '';
        if (session.payment_intent) {
          try {
            const pi = await stripeRequest('GET', `/v1/payment_intents/${session.payment_intent}?expand[]=payment_method`, {});
            cardBrand = pi.payment_method?.card?.brand || '';
            cardLast4 = pi.payment_method?.card?.last4 || '';
          } catch (_) {}
        }

        let createdNewTicket = false;
        let emailConfig;
        let smsConfig;

        await withDBLock((lockedDb) => {
          if (!lockedDb.pendingSessions) lockedDb.pendingSessions = {};
          ticket = (lockedDb.tickets || []).find(t => t.stripeSessionId === sessionId);

          if (!ticket) {
            const curTier = getCurrentTierInfo(lockedDb).currentTier;
            const pending = lockedDb.pendingSessions[sessionId] || {
              ticketId: 'SLB-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
              securityToken: crypto.randomBytes(16).toString('hex'),
              buyerName: session.customer_details?.name || 'Attendee',
              buyerEmail: session.customer_details?.email || '',
              tier: curTier.name,
              price: curTier.price,
              purchasedAt: new Date().toISOString(),
            };

            ticket = {
              ...pending,
              securityToken: pending.securityToken || crypto.randomBytes(16).toString('hex'),
              purchasedAt: pending.purchasedAt || new Date().toISOString(),
              paymentStatus: 'PAID',
              paidAt: new Date().toISOString(),
              stripeSessionId: sessionId,
              cardBrand: cardBrand || pending.cardBrand || '',
              cardLast4: cardLast4 || pending.cardLast4 || '',
              method: 'CARD',
            };
            lockedDb.tickets.push(ticket);
            delete lockedDb.pendingSessions[sessionId];
            saveDB(lockedDb);
            createdNewTicket = true;
          } else if (ticket.paymentStatus !== 'PAID') {
            ticket.paymentStatus = 'PAID';
            ticket.paidAt = ticket.paidAt || new Date().toISOString();
            saveDB(lockedDb);
          }

          emailConfig = lockedDb.config?.email || {};
          smsConfig = {
            twilioAccountSid: lockedDb.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
            twilioAuthToken:  lockedDb.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
            twilioFromNumber: lockedDb.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
            venmoUsername: lockedDb.config?.venmoUsername || VENMO_USERNAME,
          };
        });

        if (createdNewTicket && ticket) {
          sendTicketReceipt(ticket, {
            ...emailConfig,
            venmoUsername: smsConfig.venmoUsername,
          }, BASE_URL)
            .then(r => {
              withDBLock((lockedDb) => {
                const tRef = lockedDb.tickets.find(x => x.ticketId === ticket.ticketId);
                if (tRef) {
                  tRef.emailStatus = r.simulated ? 'SIMULATED' : 'SENT';
                  tRef.emailSentAt = new Date().toISOString();
                  saveDB(lockedDb);
                }
              }).catch(() => {});
            })
            .catch(e => {
              withDBLock((lockedDb) => {
                const tRef = lockedDb.tickets.find(x => x.ticketId === ticket.ticketId);
                if (tRef) {
                  tRef.emailStatus = 'FAILED';
                  tRef.emailError = e.message;
                  saveDB(lockedDb);
                }
              }).catch(() => {});
            });

          sendSmsReceipt(ticket, smsConfig, BASE_URL).catch(() => {});
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

    // Quick read-only check first (outside lock, idempotent fast path)
    const dbCheck = loadDB();
    const existing = dbCheck.tickets.find(t => t.stripeSessionId === session_id);
    if (existing) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ticket: existing }));
    }
    if (!dbCheck.pendingSessions?.[session_id]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Session not found.' }));
    }

    try {
      // Verify payment status with Stripe before acquiring lock
      const session = await stripeRequest('GET', `/v1/checkout/sessions/${session_id}`, {});
      if (session.payment_status !== 'paid') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payment not yet confirmed by Stripe.' }));
      }

      // Extract card details from payment intent (outside lock — network call)
      let cardBrand = '';
      let cardLast4 = '';
      if (session.payment_intent) {
        try {
          const pi = await stripeRequest('GET', `/v1/payment_intents/${session.payment_intent}?expand[]=payment_method`, {});
          cardBrand = pi.payment_method?.card?.brand || '';
          cardLast4 = pi.payment_method?.card?.last4 || '';
        } catch (_) { /* non-fatal */ }
      }

      // --- MUTEX: serialize ticket finalization to prevent duplicate writes ---
      let ticket;
      let createdNewTicket = false;
      let emailConfig;
      let smsConfig;
      await withDBLock((db) => {
        if (!db.pendingSessions) db.pendingSessions = {};

        // Double-check inside lock (another request may have beaten us here)
        const alreadyDone = db.tickets.find(t => t.stripeSessionId === session_id);
        if (alreadyDone) { ticket = alreadyDone; return; }

        const pending = db.pendingSessions[session_id];
        if (!pending) { return; } // Session was cleaned up between checks

        ticket = {
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
        createdNewTicket = true;
        console.log(`[MUTEX] checkout-complete ticket ${ticket.ticketId} written (total: ${db.tickets.length})`);

        emailConfig = db.config?.email || {};
        smsConfig = {
          twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
          twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
          twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
          venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
        };
      });

      if (!ticket) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Session not found or already processed.' }));
      }

      // Send email + SMS receipts outside the lock (only if newly created)
      if (createdNewTicket && emailConfig) {
        sendTicketReceipt(ticket, { ...emailConfig, venmoUsername: smsConfig?.venmoUsername || VENMO_USERNAME }, BASE_URL)
          .then(r => updateTicketFields(ticket.ticketId, { emailStatus: r.simulated ? 'SIMULATED' : 'SENT', emailSentAt: new Date().toISOString() }))
          .catch(e => updateTicketFields(ticket.ticketId, { emailStatus: 'FAILED', emailError: e.message }));
        sendSmsReceipt(ticket, smsConfig, BASE_URL)
          .then(r => { if (!r.skipped) updateTicketFields(ticket.ticketId, { smsStatus: 'SENT', smsSentAt: new Date().toISOString() }); })
          .catch(e => updateTicketFields(ticket.ticketId, { smsStatus: 'FAILED', smsError: e.message }));
      }

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
    const db_chk = loadDB();
    if (isSiteLocked(db_chk) && !hasPreviewAccess(req, url, db_chk)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket sales are currently paused. Please check back soon!' }));
    }
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

    // Determine payment method — card payments MUST go through Stripe Checkout so real bank funds are verified
    const method = paymentMethod || 'card';
    if (method !== 'venmo') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'Debit/Credit card purchases must go through secure Stripe Checkout so funds are verified in real time.',
      }));
    }

    const cardBrand = '';
    const cardLast4 = '';

    // --- MUTEX: serialize ticket writes to prevent race conditions ---
    let purchaseResult;
    try {
      purchaseResult = await withDBLock((db) => {
        const info = getCurrentTierInfo(db);

        // Block if tier sold out and next drop not yet opened
        if (info.tierPaused) {
          throw Object.assign(new Error('This tier is sold out! The next ticket drop has not opened yet. Stay tuned for the announcement.'), { statusCode: 409 });
        }

        const tier = info.currentTier;

        const ticketId = 'SLB-' + crypto.randomBytes(6).toString('hex').toUpperCase();
        const securityToken = crypto.randomBytes(16).toString('hex');

        const newTicket = {
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

        db.tickets.push(newTicket);
        saveDB(db);
        console.log(`[MUTEX] Ticket ${ticketId} written (total: ${db.tickets.length})`);

        return {
          ticket: newTicket,
          tierPrice: tier.price,
          emailConfig: db.config?.email || {},
          venmoUser: db.config?.venmoUsername || VENMO_USERNAME,
          smsConfig: {
            twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
            twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
            twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
            venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
          },
        };
      });
    } catch (lockErr) {
      console.error('[MUTEX ERROR] purchase lock failed:', lockErr.message);
      const statusCode = lockErr.statusCode || 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: lockErr.message || 'Server error processing purchase. Please try again.' }));
    }

    const { ticket, tierPrice, emailConfig, venmoUser, smsConfig } = purchaseResult;

    // Asynchronously dispatch email receipt to attendee
    sendTicketReceipt(ticket, {
      ...emailConfig,
      venmoUsername: venmoUser,
    }, BASE_URL)
      .then(result => {
        updateTicketFields(ticket.ticketId, {
          emailStatus: result.simulated ? 'SIMULATED' : 'SENT',
          emailSentAt: new Date().toISOString(),
          emailProvider: result.provider || 'simulated',
        });
        console.log(`[RECEIPT] Email dispatched to ${ticket.buyerEmail} for ticket ${ticket.ticketId}`);
      })
      .catch(emailErr => {
        console.error(`[RECEIPT ERROR] Failed to send email to ${ticket.buyerEmail}:`, emailErr.message);
        updateTicketFields(ticket.ticketId, {
          emailStatus: 'FAILED',
          emailError: emailErr.message,
        });
      });

    // Asynchronously dispatch SMS receipt to attendee (if phone provided + Twilio configured)
    sendSmsReceipt(ticket, smsConfig, BASE_URL)
      .then(result => {
        if (!result.skipped) {
          updateTicketFields(ticket.ticketId, {
            smsStatus: 'SENT',
            smsSentAt: new Date().toISOString(),
          });
          console.log(`[SMS] Text receipt sent to ${ticket.buyerPhone} for ticket ${ticket.ticketId}`);
        } else {
          console.log(`[SMS] Skipped for ${ticket.ticketId}: ${result.reason}`);
        }
      })
      .catch(smsErr => {
        console.error(`[SMS ERROR] Failed to send SMS to ${ticket.buyerPhone}:`, smsErr.message);
        updateTicketFields(ticket.ticketId, {
          smsStatus: 'FAILED',
          smsError: smsErr.message,
        });
      });

    const venmoNote = `Banda Night - ${ticket.ticketId} - ${ticket.buyerName}`;
    const venmoDeepLink = `https://venmo.com/${venmoUser}?txn=pay&amount=${tierPrice}&note=${encodeURIComponent(venmoNote)}`;

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

    let checkinResponse;
    let venmoConfirmEmailArgs = null;

    await withDBLock((db) => {
      const ticket = db.tickets.find(t => t.ticketId.toUpperCase() === ticketId);

      if (!ticket) {
        checkinResponse = {
          valid: false,
          message: 'Invalid Ticket — Code not found in database.',
        };
        return;
      }

      if (ticket.paymentStatus === 'REFUNDED') {
        checkinResponse = {
          valid: false,
          isRefunded: true,
          message: '⛔ TICKET VOID / REFUNDED — Do NOT allow entry!',
          ticket,
        };
        return;
      }

      // Door check: Is ticket paid?
      if (ticket.paymentStatus !== 'PAID') {
        if (confirmVenmo && ticket.paymentStatus === 'VENMO_PENDING') {
          // Door staff verified and confirmed payment on the spot
          ticket.paymentStatus = 'PAID';
          ticket.paidAt = new Date().toISOString();
          const emailConfig = db.config?.email || {};
          venmoConfirmEmailArgs = {
            ticket: { ...ticket },
            config: { ...emailConfig, venmoUsername: db.config?.venmoUsername || VENMO_USERNAME },
          };
        } else {
          checkinResponse = {
            valid: false,
            isPending: true,
            message: '⚠️ UNPAID TICKET — Venmo payment is still pending! Verify transfer before admitting.',
            ticket,
          };
          return;
        }
      }

      if (ticket.checkedIn) {
        checkinResponse = {
          valid: false,
          alreadyCheckedIn: true,
          message: `⚠️ ALREADY SCANNED! Checked in on ${new Date(ticket.checkedInAt).toLocaleTimeString()}`,
          ticket,
        };
        return;
      }

      // Mark as checked in
      ticket.checkedIn = true;
      ticket.checkedInAt = new Date().toISOString();
      saveDB(db);

      checkinResponse = {
        valid: true,
        message: '✅ ADMISSION GRANTED! Welcome to Banda Night.',
        ticket,
      };
    });

    if (venmoConfirmEmailArgs) {
      sendTicketReceipt(venmoConfirmEmailArgs.ticket, venmoConfirmEmailArgs.config, BASE_URL)
        .catch(e => console.error('Venmo checkin email error:', e.message));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(checkinResponse));
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
      tierPaused: info.tierPaused,
      maxActiveTierIndex: info.maxActiveTierIndex,
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
      siteLocked: isSiteLocked(db),
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
    if (typeof body.siteLocked === 'boolean') {
      db.config.siteLocked = body.siteLocked;
    }
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

  // --- API: Toggle Public Website Lock ---
  if (pathname === '/api/admin/toggle-lock' && req.method === 'POST') {
    if (!checkAdminAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    const body = await parseBody(req);
    const nextState = await withDBLock((db) => {
      if (!db.config) db.config = {};
      const current = isSiteLocked(db);
      const next = typeof body.locked === 'boolean' ? body.locked : !current;
      db.config.siteLocked = next;
      saveDB(db);
      return next;
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, siteLocked: nextState }));
  }

  // --- API: Admin Open Next Tier Drop ---
  if (pathname === '/api/admin/open-next-tier' && req.method === 'POST') {
    if (!checkAdminAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized.' }));
    }
    let result;
    try {
      result = await withDBLock((db) => {
        if (!db.config) db.config = {};
        const currentMax = typeof db.config.maxActiveTierIndex === 'number' ? db.config.maxActiveTierIndex : 0;
        if (currentMax >= TIERS.length - 1) {
          throw Object.assign(new Error('All tiers are already open. No more tiers to unlock.'), { statusCode: 400 });
        }
        const newMax = currentMax + 1;
        db.config.maxActiveTierIndex = newMax;
        saveDB(db);
        console.log(`[TIER DROP] Tier unlocked to index ${newMax}: ${TIERS[newMax].name} ($${TIERS[newMax].price})`);
        return {
          success: true,
          unlockedTier: TIERS[newMax],
          maxActiveTierIndex: newMax,
          message: `${TIERS[newMax].name} ($${TIERS[newMax].price}) is now open for purchase!`,
        };
      });
    } catch (err) {
      res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // --- API: Admin Test Stripe Checkout Session Creation ---
  if (pathname === '/api/admin/test-stripe' && req.method === 'POST') {
    const db_chk = loadDB();
    const stripeCfg = getStripeConfig(db_chk);
    if (!stripeCfg.configured) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Stripe secret key is not configured.' }));
    }
    try {
      const lineItem = await getStripeLineItem('Diagnostic Test', 15);
      const session = await stripeRequest('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        managed_payments: { enabled: 'false' },
        allowed_payment_method_types: ['card'],
        line_items: [lineItem],
        success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BASE_URL}/#tickets`,
      });
      // Immediately expire the diagnostic session so it can never be paid
      if (session?.id) {
        await stripeRequest('POST', `/v1/checkout/sessions/${session.id}/expire`, {}).catch(() => {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        sessionId: session.id,
        hasUrl: Boolean(session.url),
        livemode: Boolean(session.livemode),
        message: 'Stripe Checkout session created & verified successfully!',
      }));
    } catch (err) {
      console.error('[STRIPE DIAGNOSTIC ERROR]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // --- API: Admin Restore Tickets Backup ---
  if (pathname === '/api/admin/restore-tickets' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!Array.isArray(body.tickets)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'tickets array required.' }));
    }
    const restoredCount = await withDBLock((db) => {
      if (!db.config) db.config = {};
      if (body.overwrite === true) {
        db.tickets = [...body.tickets].reverse().filter(t => t && t.ticketId);
      } else {
        // Preserve chronological order (oldest first) while keeping unique ticketIds
        const existingIds = new Set((db.tickets || []).map(t => t.ticketId));
        const toAdd = [...body.tickets].reverse().filter(t => t && t.ticketId && !existingIds.has(t.ticketId));
        db.tickets = [...(db.tickets || []), ...toAdd];
      }
      if (typeof body.maxActiveTierIndex === 'number') {
        db.config.maxActiveTierIndex = body.maxActiveTierIndex;
      }
      if (typeof body.siteLocked === 'boolean') {
        db.config.siteLocked = body.siteLocked;
      }
      saveDB(db);
      return db.tickets.length;
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, totalTickets: restoredCount }));
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

    let confirmResult = null;
    await withDBLock((db) => {
      const ticket = db.tickets.find(t => t.ticketId === ticketId);
      if (!ticket) return;

      ticket.paymentStatus = 'PAID';
      ticket.paidAt = new Date().toISOString();
      saveDB(db);

      confirmResult = {
        ticket: { ...ticket },
        emailConfig: db.config?.email || {},
        smsConfigVenmo: {
          twilioAccountSid: db.config?.twilio?.accountSid || TWILIO_ACCOUNT_SID,
          twilioAuthToken:  db.config?.twilio?.authToken  || TWILIO_AUTH_TOKEN,
          twilioFromNumber: db.config?.twilio?.fromNumber || TWILIO_FROM_NUMBER,
          venmoUsername: db.config?.venmoUsername || VENMO_USERNAME,
        },
      };
    });

    if (!confirmResult) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket not found.' }));
    }

    const { ticket, emailConfig, smsConfigVenmo } = confirmResult;

    // Automatically send receipt with activated QR code to attendee now that ticket is paid!
    sendTicketReceipt(ticket, {
      ...emailConfig,
      venmoUsername: smsConfigVenmo.venmoUsername,
    }, BASE_URL)
      .then(() => console.log(`[RECEIPT] Activated pass emailed to ${ticket.buyerEmail} on Venmo confirm.`))
      .catch(e => console.error('[RECEIPT ERROR] Failed to send activated pass:', e.message));

    // Also fire SMS with unlocked QR pass link
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

    const found = await withDBLock((db) => {
      const ticket = db.tickets.find(t => t.ticketId === ticketId);
      if (!ticket) return false;
      ticket.paymentStatus = 'REFUNDED';
      ticket.refundedAt = new Date().toISOString();
      saveDB(db);
      return true;
    });

    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Ticket not found.' }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, ticketId }));
  }

  // --- Serve Static Assets ---
  let filePath = pathname === '/' ? '/index.html' : pathname;

  // Intercept root page when public website is locked
  const db_static = loadDB();
  if (isSiteLocked(db_static) && (filePath === '/index.html' || pathname === '/') && !hasPreviewAccess(req, url, db_static)) {
    filePath = '/locked.html';
  }

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
  console.log(`\n🎺 BANDA NIGHT 2027 TICKET PLATFORM`);
  console.log(`===============================================`);
  console.log(`✨ Main Event Page:   http://localhost:${PORT}`);
  console.log(`📊 Admin Dashboard:   http://localhost:${PORT}/admin.html`);
  console.log(`🔍 Door Scanner:      http://localhost:${PORT}/scanner.html`);
  console.log(`💳 Card Payments:     Integrated & Ready (Instant Ticket + QR)`);
  console.log(`===============================================\n`);
});
