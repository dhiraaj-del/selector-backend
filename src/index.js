/**
 * index.js — Selector backend
 *
 * Routes:
 *   POST /api/orders/create      → create Razorpay order
 *   POST /api/orders/verify      → verify payment after checkout
 *   POST /api/webhook/razorpay   → Razorpay webhook (auto payment capture)
 *   POST /api/licenses/validate  → validate license key from app
 *   GET  /api/health             → health check
 */

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const crypto    = require('crypto');
const Razorpay  = require('razorpay');
const { pool, setupDatabase } = require('./db');
const { generateLicenseKey, isValidKeyFormat } = require('./licenseKey');
const { sendLicenseEmail } = require('./email');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Razorpay client ────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));  // Electron app can be from any origin

// Raw body for webhook signature verification (must be BEFORE express.json)
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', product: 'Selector', version: '1.0.0' });
});

// ── POST /api/orders/create ───────────────────────────────────────────────────
// Called by the Electron app when user clicks "Buy"
// Creates a Razorpay order and returns the order_id to open checkout
app.post('/api/orders/create', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  try {
    // Amount in paise (₹1999 = 199900 paise)
    const amount   = parseInt(process.env.PRODUCT_PRICE || 1999) * 100;
    const currency = 'INR';

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: `sel_${Date.now()}`,
      notes: { email, product: 'Selector Pro' },
    });

    // Store in DB
    await pool.query(
      `INSERT INTO orders (razorpay_order_id, email, amount, currency, status)
       VALUES ($1, $2, $3, $4, 'created')
       ON CONFLICT (razorpay_order_id) DO NOTHING`,
      [order.id, email, amount, currency]
    );

    console.log(`[Order] Created ${order.id} for ${email}`);

    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('[Order] Error:', err.message);
    res.status(500).json({ error: 'Could not create order' });
  }
});

// ── POST /api/orders/verify ───────────────────────────────────────────────────
// Called by the Electron app after user completes payment in Razorpay checkout
// Verifies signature → generates license key → sends email
app.post('/api/orders/verify', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, email } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment details' });
  }

  // ── Verify Razorpay signature ──────────────────────────────────────────────
  // This proves the payment actually came from Razorpay and wasn't tampered with
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    console.warn('[Verify] Signature mismatch for order', razorpay_order_id);
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  try {
    // Check if already processed (idempotency)
    const existing = await pool.query(
      'SELECT license_key FROM orders WHERE razorpay_order_id = $1 AND status = $2',
      [razorpay_order_id, 'paid']
    );

    if (existing.rows[0]?.license_key) {
      // Already processed — just return the existing key
      return res.json({ success: true, licenseKey: existing.rows[0].license_key });
    }

    // Generate license key
    const licenseKey = generateLicenseKey();

    // Get email from DB if not provided
    const orderRow = await pool.query(
      'SELECT email FROM orders WHERE razorpay_order_id = $1',
      [razorpay_order_id]
    );
    const customerEmail = email || orderRow.rows[0]?.email;

    // Update order to paid + store license key
    await pool.query(
      `UPDATE orders
       SET status = 'paid', razorpay_payment_id = $1, license_key = $2, paid_at = NOW()
       WHERE razorpay_order_id = $3`,
      [razorpay_payment_id, licenseKey, razorpay_order_id]
    );

    // Store license in licenses table
    await pool.query(
      `INSERT INTO licenses (license_key, email, order_id)
       VALUES ($1, $2, $3)`,
      [licenseKey, customerEmail, razorpay_order_id]
    );

    // Send email with license key
    if (customerEmail) {
      await sendLicenseEmail({
        to: customerEmail,
        licenseKey,
        orderId: razorpay_order_id,
      });
    }

    console.log(`[Verify] Payment confirmed, license ${licenseKey} issued to ${customerEmail}`);
    res.json({ success: true, licenseKey });

  } catch (err) {
    console.error('[Verify] Error:', err.message);
    res.status(500).json({ error: 'Could not process payment' });
  }
});

// ── POST /api/webhook/razorpay ────────────────────────────────────────────────
// Razorpay calls this directly when a payment is captured
// Backup in case the app verify call fails (e.g. user closed app)
app.post('/api/webhook/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const body      = req.body; // raw buffer

  // Verify webhook signature
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  if (signature !== expectedSig) {
    console.warn('[Webhook] Invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(body.toString());
  console.log('[Webhook] Event:', event.event);

  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const orderId = payment.order_id;

    try {
      // Check if already processed
      const existing = await pool.query(
        'SELECT license_key, status FROM orders WHERE razorpay_order_id = $1',
        [orderId]
      );

      if (existing.rows[0]?.status === 'paid') {
        return res.json({ received: true }); // Already done
      }

      const licenseKey    = generateLicenseKey();
      const customerEmail = payment.email || payment.notes?.email;

      await pool.query(
        `UPDATE orders
         SET status = 'paid', razorpay_payment_id = $1, license_key = $2, paid_at = NOW()
         WHERE razorpay_order_id = $3`,
        [payment.id, licenseKey, orderId]
      );

      await pool.query(
        `INSERT INTO licenses (license_key, email, order_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (license_key) DO NOTHING`,
        [licenseKey, customerEmail, orderId]
      );

      if (customerEmail) {
        await sendLicenseEmail({ to: customerEmail, licenseKey, orderId });
      }

      console.log(`[Webhook] License ${licenseKey} issued via webhook`);
    } catch (err) {
      console.error('[Webhook] Error:', err.message);
    }
  }

  res.json({ received: true });
});

// ── POST /api/licenses/validate ───────────────────────────────────────────────
// Called by the Electron app to validate a license key
// Also increments activation count
app.post('/api/licenses/validate', async (req, res) => {
  const { licenseKey, instanceId } = req.body;

  if (!licenseKey) {
    return res.status(400).json({ valid: false, error: 'License key required' });
  }

  const key = (licenseKey || '').toUpperCase().trim();

  // Format check first (fast, no DB)
  if (!isValidKeyFormat(key)) {
    return res.json({ valid: false, error: 'Invalid license key format' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM licenses WHERE license_key = $1',
      [key]
    );

    if (!result.rows.length) {
      return res.json({ valid: false, error: 'License key not found' });
    }

    const lic = result.rows[0];

    if (!lic.active) {
      return res.json({ valid: false, error: 'License key has been deactivated' });
    }

    if (lic.activations >= lic.max_activations) {
      return res.json({
        valid: false,
        error: `Maximum activations (${lic.max_activations}) reached. Contact support to transfer.`,
      });
    }

    // Increment activations + update last seen
    await pool.query(
      `UPDATE licenses
       SET activations = activations + 1, last_seen = NOW()
       WHERE license_key = $1`,
      [key]
    );

    console.log(`[License] ✓ Validated ${key} for instance ${instanceId || 'unknown'}`);

    res.json({
      valid: true,
      email: lic.email,
      activationsUsed: lic.activations + 1,
      activationsLeft: lic.max_activations - lic.activations - 1,
    });

  } catch (err) {
    console.error('[License] Validate error:', err.message);
    res.status(500).json({ valid: false, error: 'Server error, please try again' });
  }
});

// ── POST /api/licenses/check ──────────────────────────────────────────────────
// Lightweight check — just confirms key is valid without incrementing count
// Used on app launch to verify stored key is still active
app.post('/api/licenses/check', async (req, res) => {
  const { licenseKey } = req.body;
  const key = (licenseKey || '').toUpperCase().trim();

  if (!isValidKeyFormat(key)) {
    return res.json({ valid: false });
  }

  try {
    const result = await pool.query(
      'SELECT active FROM licenses WHERE license_key = $1',
      [key]
    );

    const valid = result.rows[0]?.active === true;
    await pool.query('UPDATE licenses SET last_seen = NOW() WHERE license_key = $1', [key]);

    res.json({ valid });
  } catch {
    res.json({ valid: false });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await setupDatabase();
    app.listen(PORT, () => {
      console.log(`[Server] Selector backend running on port ${PORT}`);
      console.log(`[Server] Razorpay key: ${process.env.RAZORPAY_KEY_ID?.slice(0, 12)}...`);
    });
  } catch (err) {
    console.error('[Boot] Fatal error:', err.message);
    process.exit(1);
  }
}

boot();
