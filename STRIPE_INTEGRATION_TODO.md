# Stripe Integration — Managed Payments Blueprint

> This is the single source of truth for the Stripe Managed Payments integration.

---

## 📋 Blueprint Summary

| Step | Operation | Parameters |
|------|-----------|------------|
| **1. Create a Product** | `POST /v1/products` | `name`: `Hamlet (e-book)`, `tax_code`: `txcd_10103100`, `default_price_data`: `{ currency: 'usd', unit_amount: 1000 }`, `api_version`: `2026-02-25.preview` |
| **2. Create Checkout Session** | `POST /v1/checkout/sessions` | `managed_payments[enabled]`: `true`, `mode`: `payment`, `line_items`: `[{ price: default_price, quantity: 1 }]`, `success_url`: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`, `api_version`: `2026-02-25.preview` |
| **3. Test Checkout** | Hosted Checkout | Redirect buyer to `session.url` |
| **4. Webhooks** | `POST /api/webhook` | Listen for `checkout.session.completed` event |

---

## 🔑 Environment Variables Setup

Obtain your API keys and webhook secret from the [Stripe Dashboard](https://dashboard.stripe.com):
- **Secret Key (`STRIPE_SECRET_KEY`)**: [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys)
- **Publishable Key (`STRIPE_PUBLISHABLE_KEY`)**: [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys)
- **Webhook Secret (`STRIPE_WEBHOOK_SECRET`)**: [dashboard.stripe.com/test/webhooks](https://dashboard.stripe.com/test/webhooks)

Set these environment variables on your hosting provider (e.g., Render) or in `.env`:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
BASE_URL=https://banda-night-2026-1.onrender.com
```

---

## 🔄 Endpoints Overview

- `POST /api/create-product` & `POST /create-product`
  Creates the digital product with tax code `txcd_10103100` and saves `default_price` in the database.
- `POST /api/create-checkout-session` & `POST /create-checkout-session`
  Creates a Stripe Checkout Session with `managed_payments[enabled]: true` using the digital product's `default_price`. Returns `{ url, id }` to redirect to Stripe Hosted Checkout.
- `POST /api/webhook` & `POST /webhook`
  Receives and verifies Stripe webhook events, including `checkout.session.completed`.
- `POST /api/verify-payment` & `POST /verify-payment`
  Used by `/success.html` to confirm payment and display the ticket pass.
