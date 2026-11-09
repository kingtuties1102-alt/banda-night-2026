/**
 * Banda Night 2026 - Email Receipt System
 * Zero external dependencies (pure Node.js standard library: tls, net, https)
 * 
 * Supports:
 * 1. Resend API (https://resend.com) - recommended, fastest, free 3k emails/mo
 * 2. SendGrid API (https://sendgrid.com)
 * 3. Direct SMTP / Gmail App Password (smtp.gmail.com:465) via native TLS
 * 4. Fallback simulation mode with console logging & database tracking
 */

const https = require('https');
const tls = require('tls');
const net = require('net');

/**
 * Send an email via Resend API
 */
function sendViaResend({ apiKey, from, to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const fromAddr = from || 'Sigma Lambda Beta <onboarding@resend.dev>';
    const payload = JSON.stringify({
      from: fromAddr,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || '',
    });

    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 12000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, provider: 'resend', id: parsed.id });
          } else {
            reject(new Error(parsed.message || `Resend error HTTP ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, provider: 'resend' });
          } else {
            reject(new Error(`Resend HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Resend request timed out after 12s'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Send an email via SendGrid API
 */
function sendViaSendgrid({ apiKey, from, to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const fromEmail = from || 'tickets@sigmagamma.org';
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: 'Sigma Lambda Beta - Banda Night' },
      subject,
      content: [
        { type: 'text/html', value: html },
      ],
    });

    const req = https.request('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 12000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, provider: 'sendgrid' });
        } else {
          reject(new Error(`SendGrid HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SendGrid request timed out after 12s'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Pure Node.js SMTP Client (tls / net)
 * Zero dependencies, supports Gmail (smtp.gmail.com:465) and custom SMTP servers
 */
function sendViaSmtp({ host, port, user, pass, from, to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const smtpPort = parseInt(port, 10) || 465;
    const isSecure = smtpPort === 465;
    const fromAddress = from || user;

    let socket;
    let step = 0;
    let buffer = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (socket) socket.destroy();
        reject(new Error(`SMTP connection timed out connecting to ${host}:${smtpPort}`));
      }
    }, 15000);

    function cleanup() {
      clearTimeout(timeout);
    }

    function sendCmd(cmd) {
      if (socket && !socket.destroyed) {
        socket.write(cmd + '\r\n');
      }
    }

    function handleReply(code, msg) {
      // Step machine:
      // 0: Initial 220 banner -> send EHLO
      if (step === 0 && code === 220) {
        step = 1;
        sendCmd('EHLO localhost');
        return;
      }

      // 1: 250 EHLO response -> send AUTH LOGIN (if credentials provided)
      if (step === 1 && code === 250) {
        if (user && pass) {
          step = 2;
          sendCmd('AUTH LOGIN');
        } else {
          // No auth needed
          step = 5;
          sendCmd(`MAIL FROM:<${fromAddress}>`);
        }
        return;
      }

      // 2: 334 Username prompt -> send base64 username
      if (step === 2 && code === 334) {
        step = 3;
        sendCmd(Buffer.from(user).toString('base64'));
        return;
      }

      // 3: 334 Password prompt -> send base64 password
      if (step === 3 && code === 334) {
        step = 4;
        sendCmd(Buffer.from(pass).toString('base64'));
        return;
      }

      // 4: 235 Authentication successful -> send MAIL FROM
      if (step === 4 && (code === 235 || code === 250)) {
        step = 5;
        sendCmd(`MAIL FROM:<${fromAddress}>`);
        return;
      }

      // 5: 250 MAIL FROM ok -> send RCPT TO
      if (step === 5 && code === 250) {
        step = 6;
        sendCmd(`RCPT TO:<${to}>`);
        return;
      }

      // 6: 250 RCPT TO ok -> send DATA
      if (step === 6 && code === 250) {
        step = 7;
        sendCmd('DATA');
        return;
      }

      // 7: 354 Start mail input -> send email headers & body terminated with \r\n.\r\n
      if (step === 7 && code === 354) {
        step = 8;
        const boundary = '----=_Part_' + Date.now();
        const headers = [
          `From: "Sigma Lambda Beta" <${fromAddress}>`,
          `To: <${to}>`,
          `Subject: ${subject}`,
          `Date: ${new Date().toUTCString()}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: 7bit',
          '',
          text || 'Please view this email in an HTML-compatible client.',
          '',
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: 7bit',
          '',
          html,
          '',
          `--${boundary}--`,
          '.',
        ].join('\r\n');

        sendCmd(headers);
        return;
      }

      // 8: 250 Message queued -> send QUIT
      if (step === 8 && code === 250) {
        step = 9;
        sendCmd('QUIT');
        cleanup();
        if (!settled) {
          settled = true;
          resolve({ success: true, provider: 'smtp' });
        }
        return;
      }

      // 9: 221 Bye -> close socket
      if (step === 9 && code === 221) {
        if (socket) socket.end();
        return;
      }

      // Any unexpected error code
      if (code >= 400) {
        cleanup();
        if (!settled) {
          settled = true;
          if (socket) socket.destroy();
          reject(new Error(`SMTP error ${code} at step ${step}: ${msg}`));
        }
      }
    }

    try {
      if (isSecure) {
        socket = tls.connect({
          host,
          port: smtpPort,
          rejectUnauthorized: false, // accommodate self-signed certs if any
        });
      } else {
        socket = net.connect({ host, port: smtpPort });
      }

      socket.setEncoding('utf8');

      socket.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\r\n');
        buffer = lines.pop(); // keep partial line

        for (const line of lines) {
          if (!line.trim()) continue;
          const codeMatch = line.match(/^(\d{3})([ -])(.*)$/);
          if (codeMatch) {
            const code = parseInt(codeMatch[1], 10);
            const isContinuation = codeMatch[2] === '-';
            const msg = codeMatch[3];
            if (!isContinuation) {
              handleReply(code, msg);
            }
          }
        }
      });

      socket.on('error', (err) => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(`SMTP socket error: ${err.message}`));
        }
      });

      socket.on('end', () => {
        cleanup();
        if (!settled) {
          settled = true;
          resolve({ success: true, provider: 'smtp' });
        }
      });
    } catch (connectErr) {
      cleanup();
      reject(connectErr);
    }
  });
}

/**
 * Dispatch an email using the active configuration
 */
async function sendEmail({ to, subject, html, text, config = {} }) {
  const resendKey = config.resendApiKey || process.env.RESEND_API_KEY;
  const sendgridKey = config.sendgridApiKey || process.env.SENDGRID_API_KEY;
  const smtpHost = config.smtpHost || process.env.SMTP_HOST;
  const fromEmail = config.fromEmail || process.env.FROM_EMAIL || 'tickets@sigmagamma.org';

  // 1. Resend API
  if (resendKey) {
    try {
      return await sendViaResend({
        apiKey: resendKey,
        from: config.fromEmail || process.env.FROM_EMAIL,
        to,
        subject,
        html,
        text,
      });
    } catch (err) {
      console.warn('Resend attempt failed, falling back if configured:', err.message);
      if (!smtpHost && !sendgridKey) throw err;
    }
  }

  // 2. SendGrid API
  if (sendgridKey) {
    try {
      return await sendViaSendgrid({
        apiKey: sendgridKey,
        from: fromEmail,
        to,
        subject,
        html,
        text,
      });
    } catch (err) {
      console.warn('SendGrid attempt failed, falling back if configured:', err.message);
      if (!smtpHost) throw err;
    }
  }

  // 3. SMTP (Gmail or custom server)
  if (smtpHost) {
    const smtpPort = config.smtpPort || process.env.SMTP_PORT || 465;
    const smtpUser = config.smtpUser || process.env.SMTP_USER;
    const smtpPass = config.smtpPass || process.env.SMTP_PASS;

    return await sendViaSmtp({
      host: smtpHost,
      port: smtpPort,
      user: smtpUser,
      pass: smtpPass,
      from: fromEmail || smtpUser,
      to,
      subject,
      html,
      text,
    });
  }

  // 4. Simulation Mode (Logs email receipt, ready for instant setup in Admin)
  console.log(`\n======================================================`);
  console.log(`[EMAIL RECEIPT - SIMULATION MODE]`);
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Notice: To deliver live emails to inboxes, add your Resend API Key or Gmail credentials in the Admin Dashboard or environment variables.`);
  console.log(`======================================================\n`);

  return {
    success: true,
    simulated: true,
    message: 'Receipt recorded in simulation mode. Configure SMTP or Resend in Admin Dashboard for live email delivery.',
  };
}

/**
 * Build rich HTML email template matching the Ultraviolet Nocturne event branding
 */
function buildReceiptHtml(ticket, config = {}, baseUrl = 'https://banda-night-2026-1.onrender.com') {
  const isPaid = ticket.paymentStatus === 'PAID';
  const isVenmo = ticket.method === 'VENMO' || ticket.paymentMethod === 'venmo';
  const venmoHandle = config.venmoUsername || 'Betas_UCSB';
  const ticketPassUrl = `${baseUrl}/ticket.html?id=${ticket.ticketId}`;
  
  const qrPayload = JSON.stringify({
    ticketId: ticket.ticketId,
    event: 'Banda Night 2026 - Sigma Lambda Beta',
    name: ticket.buyerName,
    tier: ticket.tier,
    price: ticket.price,
    issued: ticket.purchasedAt,
    token: ticket.securityToken,
  });

  const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&margin=8&data=${encodeURIComponent(qrPayload)}`;

  const paymentStatusHtml = isVenmo
    ? `<span style="display:inline-block; padding:4px 12px; border-radius:999px; background:rgba(250, 204, 21, 0.15); border:1px solid #facc15; color:#facc15; font-size:12px; font-weight:700;">VENMO PENDING ⏳</span>`
    : `<span style="display:inline-block; padding:4px 12px; border-radius:999px; background:rgba(74, 222, 128, 0.15); border:1px solid #4ade80; color:#4ade80; font-size:12px; font-weight:700;">PAID IN FULL ✅</span>`;

  const venmoBoxHtml = (isVenmo && !isPaid) ? `
    <div style="background:rgba(0, 140, 255, 0.12); border:1px solid #38bdf8; border-radius:14px; padding:18px; margin:22px 0; text-align:left;">
      <div style="font-weight:700; color:#ffffff; font-size:14px; margin-bottom:8px;">
        📱 Venmo Payment Confirmation Required:
      </div>
      <div style="color:#bae6fd; font-size:13px; line-height:1.5;">
        Send <strong>$${ticket.price}.00</strong> on Venmo to <strong style="color:#ffffff;">@${venmoHandle}</strong><br>
        Payment Note: <strong style="color:#ffffff; font-family:monospace; background:rgba(0,0,0,0.4); padding:2px 6px; border-radius:4px;">Banda Night - ${ticket.ticketId}</strong>
      </div>
      <div style="margin-top:14px;">
        <a href="https://venmo.com/${venmoHandle}?txn=pay&amount=${ticket.price}&note=Banda%20Night%20-%20${ticket.ticketId}" target="_blank" style="display:inline-block; background:#008cff; color:#ffffff; font-weight:700; font-size:13px; padding:10px 20px; border-radius:8px; text-decoration:none;">
          Open Venmo to Pay ($${ticket.price}.00)
        </a>
      </div>
    </div>
  ` : '';

  const qrSectionHtml = isPaid ? `
    <!-- QR Code Card (Rendered Only Post-Payment) -->
    <div style="background:#ffffff; border-radius:18px; padding:16px; display:inline-block; margin:10px auto 20px; box-shadow:0 10px 30px rgba(0,0,0,0.6);">
      <img src="${qrImgUrl}" width="220" height="220" alt="Ticket QR Code" style="display:block; margin:0 auto; width:220px; height:220px;" />
      <div style="color:#0f051d; font-family:monospace; font-weight:800; font-size:12px; margin-top:8px; letter-spacing:1px;">
        ${ticket.ticketId}
      </div>
    </div>
    <div style="font-size:13px; color:#c084fc; margin-bottom:20px;">
      📱 Show this QR code at the entrance for fast door check-in.
    </div>
  ` : `
    <!-- QR Code Locked Notice (Venmo Pending) -->
    <div style="background:rgba(250, 204, 21, 0.08); border:2px dashed rgba(250, 204, 21, 0.45); border-radius:18px; padding:24px 20px; margin:10px auto 20px; max-width:320px;">
      <div style="font-size:36px; margin-bottom:8px;">🔒</div>
      <div style="color:#facc15; font-weight:800; font-size:15px; margin-bottom:6px; text-transform:uppercase; letter-spacing:1px;">
        Admission QR Code Locked
      </div>
      <div style="font-size:13px; color:#cbd5e1; line-height:1.45;">
        Complete your Venmo payment of <strong>$${ticket.price}.00</strong> below to unlock your admission pass. Once verified by organizers, your active QR code will unlock and a confirmation will be emailed.
      </div>
    </div>
    <div style="font-size:13px; color:#facc15; margin-bottom:20px;">
      ⏳ Payment pending confirmation. Complete Venmo transfer to activate pass.
    </div>
  `;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Ticket Receipt · Banda Night 2026</title>
</head>
<body style="margin:0; padding:0; background-color:#07020f; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#ffffff;">
  
  <!-- Outer wrapper table -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#07020f; padding:30px 10px;">
    <tr>
      <td align="center">
        
        <!-- Main Card Container -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px; background:linear-gradient(160deg, #16062a 0%, #0d0319 50%, #080112 100%); border:1px solid rgba(168, 85, 247, 0.4); border-radius:24px; overflow:hidden; box-shadow:0 25px 60px rgba(0,0,0,0.8);">
          
          <!-- Header Banner -->
          <tr>
            <td style="background:linear-gradient(90deg, #6b21a8 0%, #9333ea 50%, #c026d3 100%); padding:24px 20px; text-align:center;">
              <div style="font-size:12px; font-weight:800; letter-spacing:2px; color:rgba(255,255,255,0.85); text-transform:uppercase; margin-bottom:4px;">
                Sigma Lambda Beta International Fraternity Inc.
              </div>
              <h1 style="margin:0; font-size:24px; font-weight:900; letter-spacing:1px; color:#ffffff; text-transform:uppercase;">
                🎺 Banda Night 2026
              </h1>
              <div style="font-size:12px; font-weight:700; color:#f5d0fe; margin-top:4px;">
                Sigma Gamma Chapter · Official Ticket Receipt
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding:28px 24px; text-align:center;">
              
              <div style="font-size:15px; color:#e9d5ff; margin-bottom:18px;">
                Hi <strong>${ticket.buyerName || 'Attendee'}</strong>, thank you for your support! Here is your official admission pass and receipt.
              </div>

              ${qrSectionHtml}

              <!-- Button: View Pass Online -->
              <div style="margin:20px 0 25px;">
                <a href="${ticketPassUrl}" target="_blank" style="display:inline-block; background:linear-gradient(135deg, #a855f7 0%, #ec4899 100%); color:#ffffff; font-size:15px; font-weight:800; text-decoration:none; padding:14px 28px; border-radius:12px; box-shadow:0 6px 20px rgba(168, 85, 247, 0.4);">
                  🎟️ Open My Digital Ticket Pass
                </a>
              </div>

              <!-- Venmo Instructions (if applicable) -->
              ${venmoBoxHtml}

              <!-- Details Table -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(88, 28, 135, 0.18); border:1px solid rgba(192, 132, 252, 0.25); border-radius:14px; margin:18px 0; text-align:left;">
                <tr>
                  <td style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#a855f7; font-size:13px;">Attendee</td>
                  <td align="right" style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#ffffff; font-weight:700; font-size:13px;">${ticket.buyerName}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#a855f7; font-size:13px;">Ticket Tier</td>
                  <td align="right" style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#ffffff; font-weight:700; font-size:13px;">${ticket.tier}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#a855f7; font-size:13px;">Amount</td>
                  <td align="right" style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#ffffff; font-weight:700; font-size:13px;">$${ticket.price}.00</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#a855f7; font-size:13px;">Payment Status</td>
                  <td align="right" style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15);">${paymentStatusHtml}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#a855f7; font-size:13px;">Payment Method</td>
                  <td align="right" style="padding:10px 16px; border-bottom:1px solid rgba(168, 85, 247, 0.15); color:#ffffff; font-size:13px;">${ticket.method === 'VENMO' ? 'Venmo' : `${ticket.cardBrand || 'Card'} (•••• ${ticket.cardLast4 || 'Card'})`}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px; color:#a855f7; font-size:13px;">Ticket ID</td>
                  <td align="right" style="padding:10px 16px; color:#f0abfc; font-family:monospace; font-weight:700; font-size:12px;">${ticket.ticketId}</td>
                </tr>
              </table>

              <!-- Event Logistics Box -->
              <div style="background:rgba(255, 255, 255, 0.03); border:1px solid rgba(255, 255, 255, 0.08); border-radius:14px; padding:16px; margin:22px 0; text-align:left; font-size:13px; line-height:1.55; color:#d8b4fe;">
                <div style="font-weight:700; color:#ffffff; font-size:14px; margin-bottom:6px;">
                  📍 Event Details & Guidelines:
                </div>
                • <strong>Date:</strong> Friday, January 9th, 2026<br>
                • <strong>Time:</strong> Doors Open at 8:00 PM PST<br>
                • <strong>Featuring Live Banda:</strong> "La Tormentosa"<br>
                • <strong>Food:</strong> Authentic Mexican Tacos on sale all night!<br>
                • <strong>Requirements:</strong> Physical Gov/Student ID required at entrance (18+ to enter, 21+ to drink).<br>
                • <strong>Check-in:</strong> Each QR code is uniquely encrypted and valid for single admission.
              </div>

              <!-- Scholarship Memorial Note -->
              <div style="border-top:1px solid rgba(168, 85, 247, 0.2); padding-top:18px; margin-top:20px; font-size:12px; color:#9ca3af; line-height:1.5;">
                💜 <em>In Honor of Brother Hector "Hermes" Serrano. Proceeds proudly support the <strong>Vamos a Volar Scholarship Fund</strong>.</em>
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:rgba(0,0,0,0.4); padding:18px 20px; text-align:center; font-size:11px; color:#6b7280; border-top:1px solid rgba(168, 85, 247, 0.15);">
              Sigma Lambda Beta International Fraternity Inc. · Sigma Gamma Chapter<br>
              Opportunity for Wisdom, Wisdom for Culture.<br>
              Questions or issues? Contact chapter organizers via Instagram or email.
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
}

/**
 * Plain-text fallback for email clients that do not render HTML
 */
function buildReceiptText(ticket, config = {}, baseUrl = 'https://banda-night-2026-1.onrender.com') {
  const isPaid = ticket.paymentStatus === 'PAID';
  const isVenmo = ticket.method === 'VENMO' || ticket.paymentMethod === 'venmo';
  const venmoHandle = config.venmoUsername || 'Betas_UCSB';
  const ticketPassUrl = `${baseUrl}/ticket.html?id=${ticket.ticketId}`;

  return `
SIGMA LAMBDA BETA - BANDA NIGHT 2026
Official Admission Ticket & Receipt
======================================================

Hi ${ticket.buyerName || 'Attendee'},

Thank you for your purchase! Here is your official ticket receipt for Banda Night 2026.

TICKET DETAILS:
- Attendee: ${ticket.buyerName}
- Ticket ID: ${ticket.ticketId}
- Tier: ${ticket.tier}
- Price: $${ticket.price}.00
- Payment Status: ${ticket.paymentStatus || 'PAID'}
- Payment Method: ${ticket.method}

${(isVenmo && !isPaid) ? `
⚠️ ACTION REQUIRED — VENMO PAYMENT INSTRUCTIONS:
Please send $${ticket.price}.00 to @${venmoHandle} on Venmo with note: Banda Night - ${ticket.ticketId}
Your QR code admission pass will unlock automatically once verified by chapter organizers.
` : ''}

VIEW YOUR DIGITAL PASS ONLINE:
${ticketPassUrl}

EVENT LOGISTICS:
- Date: Friday, January 9th, 2026
- Doors Open: 8:00 PM PST
- Featuring: Live Banda "La Tormentosa"
- Requirements: Physical Gov/Student ID required for entry (18+ to enter, 21+ to drink).
- ${isPaid ? 'Show your unique QR code at the door for entry.' : 'NOTE: Your entry QR code is currently locked pending Venmo payment verification.'}

Proceeds honor Brother Hector "Hermes" Serrano through the Vamos a Volar Scholarship Fund.

Sigma Lambda Beta International Fraternity Inc.
Sigma Gamma Chapter
======================================================
  `.trim();
}

/**
 * High-level function to send the ticket receipt
 */
async function sendTicketReceipt(ticket, config = {}, baseUrl = 'https://banda-night-2026-1.onrender.com') {
  if (!ticket || !ticket.buyerEmail) {
    throw new Error('Buyer email is missing; cannot send receipt.');
  }

  const subject = `🎺 Your Ticket to Banda Night 2026 (${ticket.ticketId})`;
  const html = buildReceiptHtml(ticket, config, baseUrl);
  const text = buildReceiptText(ticket, config, baseUrl);

  return await sendEmail({
    to: ticket.buyerEmail,
    subject,
    html,
    text,
    config,
  });
}

/**
 * Send a quick test email to verify credentials
 */
async function sendTestEmail(toEmail, config = {}, baseUrl = 'https://banda-night-2026-1.onrender.com') {
  const sampleTicket = {
    ticketId: 'SLB-TEST-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
    buyerName: 'Test Attendee',
    buyerEmail: toEmail,
    tier: 'Early Bird (Test)',
    price: 15,
    method: 'CARD',
    paymentStatus: 'PAID',
    cardBrand: 'Visa',
    cardLast4: '4242',
    purchasedAt: new Date().toISOString(),
    securityToken: 'test-token-12345',
  };

  const subject = `🧪 Test Email Receipt · Banda Night 2026`;
  const html = buildReceiptHtml(sampleTicket, config, baseUrl);
  const text = buildReceiptText(sampleTicket, config, baseUrl);

  return await sendEmail({
    to: toEmail,
    subject,
    html,
    text,
    config,
  });
}

module.exports = {
  sendEmail,
  sendTicketReceipt,
  sendTestEmail,
  buildReceiptHtml,
  buildReceiptText,
};
