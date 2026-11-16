# Stripe Integration — Setup Checklist

> This is the single source of truth for completing your Stripe Checkout integration.
> Card payments will not charge buyers until these steps are done.

---

## ⚠️ Values to Replace

The following are placeholder / auto-generated values that must be set before going live.

**Files containing placeholders:**
- [server.js](server.js) — Stripe session creation

| Field | Current Value | What to Set |
|-------|--------------|-------------|
| `mode` | `payment` | Already correct — `"payment"` is right for one-time ticket purchases. No change needed. |
| `line_items[].price_data` | Dynamic (uses tier price × 100 cents) | ✅ Already dynamic — pulls from your tier config. No Stripe Price ID needed since we use `price_data`. |
| `STRIPE_SECRET_KEY` | _(empty — not set)_ | Your Stripe Secret Key from [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/test/apikeys) |
| `STRIPE_PUBLISHABLE_KEY` | _(empty — not set)_ | Your Stripe Publishable Key from the same page |

---

## ✅ Configured Parameters

These parameters were configured per the Field Intents specification and are already set correctly in [server.js](server.js).

**Files containing these parameters:**
- [server.js](server.js) — `/api/create-checkout-session` endpoint

| Parameter | Value |
|-----------|-------|
| `ui_mode` | `embedded` |
| `billing_address_collection` | `auto` |
| `phone_number_collection.enabled` | `false` |
| `automatic_tax.enabled` | `false` |
| `payment_method_collection` | `always` |
| `submit_type` | `auto` |
| `mode` | `payment` (one-time charge) |
| Stripe API Version | `2026-03-25.dahlia` |
| Stripe.js | Loaded from `https://js.stripe.com/dahlia/stripe.js` |

---

## 🛠 Setup Steps

### Step 1 — Get your Stripe API Keys

1. Go to [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys)
2. Copy your **Publishable key** (`pk_test_...`) and **Secret key** (`sk_test_...`)
3. When ready for real payments, switch to Live keys (`pk_live_...` / `sk_live_...`)

### Step 2 — Add keys to Render

1. Open your Render dashboard → `banda-night-2026` service → **Environment**
2. Add these two variables:

```
STRIPE_SECRET_KEY      = sk_test_...
STRIPE_PUBLISHABLE_KEY = pk_test_...
```

3. Click **Save Changes** — Render will restart (~35 seconds)

### Step 3 — Verify the integration

Once deployed, go to your site and try a card payment with the Stripe test card:

| Field | Value |
|-------|-------|
| Card number | `4242 4242 4242 4242` |
| Expiry | Any future date (e.g. `12/28`) |
| CVC | Any 3 digits (e.g. `123`) |
| ZIP | Any 5 digits (e.g. `93106`) |

✅ You should receive your ticket QR code after payment.

---

## 📁 Project Structure (New Files)

```
banda-night-tickets/
├── server.js           ← Added: stripeRequest(), flattenForStripe(),
│                              /api/create-checkout-session,
│                              /api/checkout-complete
├── public/
│   └── index.html      ← Added: Stripe.js (Dahlia) in <head>,
│                              Stripe Embedded Checkout Form container,
│                              initStripeCheckout(), finalizeStripeTicket(),
│                              cancelStripeCheckout()
└── STRIPE_INTEGRATION_TODO.md  ← This file
```

---

## 🔄 How the Integration Works

```
1. Buyer fills name / email / phone
2. Clicks "Pay with Card" → initStripeCheckout() runs
3. POST /api/create-checkout-session
   → Server creates Stripe Checkout Session (embedded mode)
   → Saves a pending ticket keyed by session ID
   → Returns { client_secret }
4. Stripe Embedded Form renders in #checkout-form
5. Buyer enters card details and confirms
6. On confirm event → finalizeStripeTicket() runs
7. POST /api/checkout-complete
   → Server verifies payment_status === 'paid' with Stripe
   → Promotes pending ticket to tickets[], sets paymentStatus: 'PAID'
   → Sends email + SMS receipt
   → Returns ticket data
8. QR code pass shown to buyer
```

**Venmo flow is unchanged** — Stripe is only used for card payments.

---

## 🧪 More Test Cards

| Scenario | Card Number |
|----------|-------------|
| Visa success | `4242 4242 4242 4242` |
| Mastercard success | `5555 5555 5555 4444` |
| Insufficient funds | `4000 0000 0000 9995` |
| 3D Secure required | `4000 0025 0000 3155` |
| Declined | `4000 0000 0000 0002` |

---

## 📚 Resources

- Stripe Dashboard: [dashboard.stripe.com](https://dashboard.stripe.com)
- Stripe Docs: [docs.stripe.com](https://docs.stripe.com)
- Stripe Support: [support.stripe.com](https://support.stripe.com)
- MCP Docs: [docs.stripe.com/mcp](https://docs.stripe.com/mcp)
- Test cards: [docs.stripe.com/testing](https://docs.stripe.com/testing)
