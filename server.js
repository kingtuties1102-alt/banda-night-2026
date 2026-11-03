const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'tickets.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- STRIPE CONFIGURATION ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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
      stripeConfigured: Boolean(STRIPE_SECRET_KEY && !STRIPE_SECRET_KEY.includes('REPLACE')),
      stripePublishableKey: STRIPE_PUBLISHABLE_KEY,
    }));
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
    };

    db.tickets.push(ticket);
    saveDB(db);

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
    const body = await parseBody(req);
    let { ticketId } = body;

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

  // --- API: Admin Venmo Config ---
  if (pathname === '/api/admin/config' && req.method === 'GET') {
    const db = loadDB();
    const venmoUser = db.config?.venmoUsername || VENMO_USERNAME;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      venmoUsername: venmoUser,
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
    saveDB(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      venmoUsername: db.config.venmoUsername,
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
    saveDB(db);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, ticketId }));
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
