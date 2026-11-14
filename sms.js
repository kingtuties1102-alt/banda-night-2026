/**
 * Banda Night 2026 - SMS Receipt System
 * Zero external dependencies (pure Node.js standard library: https)
 * Uses Twilio REST API to send text message receipts to attendees.
 *
 * Required environment variables (or set via admin dashboard):
 *   TWILIO_ACCOUNT_SID   - Your Twilio Account SID (starts with AC...)
 *   TWILIO_AUTH_TOKEN    - Your Twilio Auth Token
 *   TWILIO_FROM_NUMBER   - Your Twilio phone number (e.g. +18055551234)
 */

const https = require('https');

/**
 * Send an SMS via Twilio REST API
 * @param {object} opts
 * @param {string} opts.accountSid  - Twilio Account SID
 * @param {string} opts.authToken   - Twilio Auth Token
 * @param {string} opts.from        - Twilio phone number (E.164 format, e.g. +18055551234)
 * @param {string} opts.to          - Recipient phone number (E.164 format)
 * @param {string} opts.body        - Message body (max 1600 chars)
 */
function sendViaTwilio({ accountSid, authToken, from, to, body }) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams({ From: from, To: to, Body: body }).toString();
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const req = https.request(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 12000,
      },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, provider: 'twilio', sid: parsed.sid });
            } else {
              reject(new Error(parsed.message || `Twilio error HTTP ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Twilio parse error HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Twilio request timed out after 12s'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX for US numbers)
 * Returns null if the number cannot be normalized.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  // Strip everything except digits and leading +
  let digits = raw.replace(/[^\d+]/g, '');
  // Already E.164
  if (digits.startsWith('+')) {
    return digits.length >= 10 ? digits : null;
  }
  // Strip leading 1 for US numbers
  if (digits.startsWith('1') && digits.length === 11) {
    return '+' + digits;
  }
  // Plain 10-digit US number
  if (digits.length === 10) {
    return '+1' + digits;
  }
  return null;
}

/**
 * Build a concise SMS receipt message (keep under 320 chars for 2 SMS segments)
 */
function buildSmsBody(ticket, config = {}, baseUrl = 'https://banda-night-2026-1.onrender.com') {
  const isPaid = ticket.paymentStatus === 'PAID';
  const isVenmo = ticket.method === 'VENMO' || ticket.paymentMethod === 'venmo';
  const venmoHandle = config.venmoUsername || 'Betas_UCSB';
  const passUrl = `${baseUrl}/ticket.html?id=${ticket.ticketId}`;

  if (isVenmo && !isPaid) {
    return (
      `🎺 Banda Night 2026 — Hi ${ticket.buyerName.split(' ')[0]}!\n` +
      `Ticket ID: ${ticket.ticketId} ($${ticket.price})\n` +
      `ACTION REQUIRED: Send $${ticket.price} on Venmo to @${venmoHandle}\n` +
      `Note: "Banda Night - ${ticket.ticketId}"\n` +
      `Your QR code unlocks once payment is confirmed.\n` +
      `View pass: ${passUrl}`
    );
  }

  return (
    `🎺 Banda Night 2026 — Hi ${ticket.buyerName.split(' ')[0]}!\n` +
    `Ticket confirmed ✅ | ID: ${ticket.ticketId}\n` +
    `Tier: ${ticket.tier} · $${ticket.price}\n` +
    `📅 Jan 9, 2026 · Doors 8PM PST\n` +
    `🎟 View your QR pass: ${passUrl}`
  );
}

/**
 * High-level function: send SMS receipt to the ticket buyer.
 * Gracefully skips (does not throw) if phone is missing or Twilio is not configured.
 */
async function sendSmsReceipt(ticket, config = {}, baseUrl = 'https://banda-night-2026-1.onrender.com') {
  // Resolve Twilio credentials: config object first, then env vars
  const accountSid = config.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID || '';
  const authToken  = config.twilioAuthToken  || process.env.TWILIO_AUTH_TOKEN  || '';
  const fromNumber = config.twilioFromNumber || process.env.TWILIO_FROM_NUMBER || '';

  if (!accountSid || !authToken || !fromNumber) {
    return { success: false, skipped: true, reason: 'Twilio not configured' };
  }

  const toNumber = normalizePhone(ticket.buyerPhone);
  if (!toNumber) {
    return { success: false, skipped: true, reason: 'No valid phone number on ticket' };
  }

  const body = buildSmsBody(ticket, config, baseUrl);
  return await sendViaTwilio({ accountSid, authToken, from: fromNumber, to: toNumber, body });
}

/**
 * Send a test SMS to verify Twilio credentials
 */
async function sendTestSms(toPhone, config = {}) {
  const accountSid = config.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID || '';
  const authToken  = config.twilioAuthToken  || process.env.TWILIO_AUTH_TOKEN  || '';
  const fromNumber = config.twilioFromNumber || process.env.TWILIO_FROM_NUMBER || '';

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('Twilio credentials not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.');
  }

  const toNumber = normalizePhone(toPhone);
  if (!toNumber) {
    throw new Error(`Invalid phone number: "${toPhone}". Use format: 8055551234 or +18055551234`);
  }

  const body =
    `✅ Banda Night 2026 — Test SMS from Sigma Lambda Beta.\n` +
    `Twilio is configured correctly! Your attendees will receive receipts like this.`;

  return await sendViaTwilio({ accountSid, authToken, from: fromNumber, to: toNumber, body });
}

module.exports = {
  sendSmsReceipt,
  sendTestSms,
  normalizePhone,
  buildSmsBody,
};
