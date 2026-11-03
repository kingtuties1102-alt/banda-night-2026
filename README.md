# 🎺 Sigma Lambda Beta — Banda Night 2026 Ticket Platform

Official ticketing and event platform for **Sigma Lambda Beta International Fraternity Inc. (Sigma Gamma Chapter)** for **Banda Night 2026** (January 9th, 2026).

---

## ✨ Features
- **3-Tier Automatic Pricing:**
  - **Early Bird:** First 100 tickets @ $15
  - **Standard Tier:** Next 100 tickets @ $20
  - **Late Entry:** Unlimited remaining @ $25
  - Automatically switches tiers in real-time as tickets sell out.
- **Venmo Instant Checkout (`@Betas_UCSB`):** Pre-populates attendee payment with exact price & ticket reference; generates instant digital pass.
- **Credit / Debit Card Checkout:** Full card validation support.
- **Encrypted QR Code Passes:** Client-side generated digital ticket pass with single-entry cryptographic token.
- **Door Check-In Scanner:** Mobile camera QR scanner + manual ID lookup with duplicate-entry prevention.
- **Organizer Admin Dashboard:** Live sales revenue, ticket tracking, Venmo pending confirmation buttons, and 1-click CSV export.
- **Vamos a Volar Scholarship Tribute:** Dedicated memorial section in honor of Brother Hector "Hermes" Serrano.

---

## 🚀 Running Locally
Run with Node (pure standard library, zero npm dependencies):
```bash
node server.js
```
*(On this Mac via Antigravity runtime:)*
```bash
"/Users/kingac1102/Library/Application Support/Antigravity/bin/agy-node" server.js
```

### URLs
- **Main Event & Tickets:** http://localhost:3000
- **Organizer Dashboard:** http://localhost:3000/admin.html
- **Door Scanner:** http://localhost:3000/scanner.html

---

## 🌐 Deploying to the Web (Free & Public)

### Option 1: Render.com (Recommended — 2 Minutes)
1. Push this folder to a GitHub repository (e.g. `banda-night-2026`).
2. Go to [render.com](https://render.com) and click **New → Web Service**.
3. Connect your repository.
4. Settings:
   - **Environment:** Node
   - **Build Command:** *(leave empty or `npm install`)*
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Click **Deploy Web Service**. You'll get a public URL like `https://banda-night-2026.onrender.com`.

### Option 2: Railway.app
1. Go to [railway.app](https://railway.app).
2. Click **New Project → Deploy from GitHub repo**.
3. Railway automatically detects `server.js` and deploys it with a public HTTPS link.

---

## 📱 Event Day Checklist
1. **Door Staff:** Open `/scanner.html` on your phones. Allow camera access.
2. **Scan:** Point the camera at any attendee's QR code.
   - 🟢 **Green:** Admission Granted! (Marks ticket checked-in).
   - 🟡 **Yellow:** Already scanned or Venmo payment pending verification.
   - 🔴 **Red:** Invalid or fake code.
3. **Admin:** Access `/admin.html` to track total attendees and click "Export CSV" for chapter records.
