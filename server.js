/**
 * Selector License Backend — Render.com compatible
 * Uses PostgreSQL (Render free DB) instead of SQLite
 *
 * Required env vars:
 *   DATABASE_URL          — auto-set by Render PostgreSQL addon
 *   RAZORPAY_KEY_ID       — from Razorpay dashboard
 *   RAZORPAY_KEY_SECRET   — from Razorpay dashboard
 *   SMTP_HOST             — smtp.gmail.com
 *   SMTP_PORT             — 587
 *   SMTP_USER             — your Gmail
 *   SMTP_PASS             — Gmail app password
 *   FROM_EMAIL            — hello@crabculture.com
 *   BACKEND_SECRET        — any random string
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const { v4: uuid } = require('uuid');
const Razorpay   = require('razorpay');
const nodemailer = require('nodemailer');
const { Pool }   = require('pg');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Database ──────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id           TEXT PRIMARY KEY,
      key          TEXT UNIQUE NOT NULL,
      email        TEXT NOT NULL,
      order_id     TEXT NOT NULL,
      payment_id   TEXT,
      activated    INTEGER DEFAULT 0,
      instance_id  TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      activated_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS orders (
      id         TEXT PRIMARY KEY,
      order_id   TEXT UNIQUE NOT NULL,
      email      TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      status     TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[DB] Tables ready');
}

// ── Razorpay — lazy init so missing keys don't crash startup ─────
let _razorpay = null;
function getRazorpay() {
  if (!_razorpay) {
    _razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
}

// ── Email ─────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Middleware ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────
function generateLicenseKey() {
  const random = crypto.randomBytes(8).toString('hex').toUpperCase();
  const parts  = random.match(/.{1,4}/g);
  return `SELC-${parts.join('-')}`;
}

async function sendLicenseEmail(email, licenseKey, orderId) {
  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:-apple-system,sans-serif;background:#f5f0e8;margin:0;padding:40px 20px;">
      <div style="max-width:480px;margin:0 auto;background:#ede8de;padding:40px;border:1px solid #d4cfc5;">
        <div style="margin-bottom:32px;">
          <div style="font-size:18px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#1a1a1a;">SELECTOR</div>
          <div style="font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#e05c2a;margin-top:2px;">by Crab Culture</div>
        </div>
        <div style="font-size:22px;font-weight:800;color:#1a1a1a;margin-bottom:12px;">You're all set 🎉</div>
        <div style="font-size:14px;color:#666;line-height:1.6;margin-bottom:32px;">
          Thanks for purchasing Selector Pro. Your license key is below — keep it safe.
        </div>
        <div style="background:#1a1a1a;padding:20px;text-align:center;margin-bottom:32px;">
          <div style="font-size:11px;color:#888;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px;">Your License Key</div>
          <div style="font-size:20px;font-weight:800;color:#f5f0e8;letter-spacing:.08em;font-family:monospace;">
            ${licenseKey}
          </div>
        </div>
        <div style="font-size:13px;color:#666;line-height:1.8;margin-bottom:32px;">
          <strong>How to activate:</strong><br>
          1. Open Selector<br>
          2. Click "Already purchased? Enter license key"<br>
          3. Paste your key and click Activate
        </div>
        <div style="font-size:11px;color:#999;border-top:1px solid #d4cfc5;padding-top:20px;">
          Order ID: ${orderId}<br>
          Questions? Reply to this email or contact hello@crabculture.com
        </div>
      </div>
    </body>
    </html>
  `;
  await transporter.sendMail({
    from:    `"Selector by Crab Culture" <${process.env.FROM_EMAIL}>`,
    to:      email,
    subject: 'Your Selector Pro License Key',
    html,
  });
}

// ── Routes ────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Selector License Backend', version: '1.0.0' });
});

app.post('/create-order', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@'))
      return res.status(400).json({ error: 'Valid email required' });

    const order = await getRazorpay().orders.create({
      amount: 199900, // ₹1,999 in paise
      currency: 'INR',
      receipt: `sel_${Date.now()}`,
      notes: { email },
    });

    await pool.query(
      'INSERT INTO orders (id, order_id, email, amount, status) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), order.id, email, order.amount, 'pending']
    );

    console.log(`[Order] Created ${order.id} for ${email}`);
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) {
    console.error('[Create Order]', e.message);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.post('/verify-payment', async (req, res) => {
  try {
    const { orderId, paymentId, signature, email } = req.body;

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (expected !== signature)
      return res.status(400).json({ error: 'Payment verification failed' });

    // Check if key already issued
    const existing = await pool.query('SELECT * FROM licenses WHERE order_id=$1', [orderId]);
    if (existing.rows.length > 0)
      return res.json({ success: true, licenseKey: existing.rows[0].key });

    const licenseKey = generateLicenseKey();

    await pool.query(
      'INSERT INTO licenses (id, key, email, order_id, payment_id) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), licenseKey, email, orderId, paymentId]
    );
    await pool.query("UPDATE orders SET status='paid', payment_id=$1 WHERE order_id=$2", [paymentId, orderId]);

    try {
      await sendLicenseEmail(email, licenseKey, orderId);
      console.log(`[Email] License sent to ${email}`);
    } catch (e) {
      console.error('[Email]', e.message);
    }

    console.log(`[License] Generated ${licenseKey} for ${email}`);
    res.json({ success: true, licenseKey });
  } catch (e) {
    console.error('[Verify Payment]', e.message);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

app.post('/validate-key', async (req, res) => {
  try {
    const { key, instanceId } = req.body;
    if (!key) return res.status(400).json({ valid: false, error: 'Key required' });

    const result = await pool.query('SELECT * FROM licenses WHERE key=$1', [key]);
    if (result.rows.length === 0)
      return res.json({ valid: false, error: 'License key not found' });

    const license = result.rows[0];
    if (!license.activated) {
      await pool.query(
        'UPDATE licenses SET activated=1, instance_id=$1, activated_at=NOW() WHERE key=$2',
        [instanceId || 'unknown', key]
      );
    }

    res.json({ valid: true, email: license.email, activatedAt: license.activated_at });
  } catch (e) {
    console.error('[Validate Key]', e.message);
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

app.get('/stats', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.BACKEND_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const orders   = await pool.query("SELECT COUNT(*) FROM orders");
  const paid     = await pool.query("SELECT COUNT(*) FROM orders WHERE status='paid'");
  const licenses = await pool.query("SELECT COUNT(*) FROM licenses");
  const paidCount = parseInt(paid.rows[0].count);

  res.json({
    totalOrders:   parseInt(orders.rows[0].count),
    paidOrders:    paidCount,
    totalLicenses: parseInt(licenses.rows[0].count),
    revenue:       `₹${paidCount * 1999}`,
  });
});

// ── Start ─────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Selector backend running on port ${PORT}`);
    console.log(`Razorpay: ${process.env.RAZORPAY_KEY_ID ? '✓' : '✗ MISSING'}`);
    console.log(`SMTP: ${process.env.SMTP_USER ? '✓' : '✗ MISSING'}`);
    console.log(`DB: ${process.env.DATABASE_URL ? '✓' : '✗ MISSING'}`);
  });
}).catch(e => {
  console.error('DB init failed:', e.message);
  process.exit(1);
});

// ── Dodo Payments Webhook ─────────────────────────────────────────
app.post('/webhook/dodo', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const payload = req.body;
    const event = JSON.parse(payload.toString());

    console.log(`[Dodo] Webhook received: ${event.type}`);

    if (event.type === 'payment.succeeded') {
      const { customer, payment_id, product_id } = event.data;
      const email = customer?.email;
      if (!email) return res.json({ ok: true });

      // Check if license already issued
      const existing = await pool.query('SELECT * FROM licenses WHERE order_id=$1', [payment_id]);
      if (existing.rows.length > 0) return res.json({ ok: true });

      const licenseKey = generateLicenseKey();
      await pool.query(
        'INSERT INTO licenses (id, key, email, order_id, payment_id) VALUES ($1,$2,$3,$4,$5)',
        [uuid(), licenseKey, email, payment_id, payment_id]
      );

      try {
        await sendLicenseEmail(email, licenseKey, payment_id);
        console.log(`[Dodo] License ${licenseKey} sent to ${email}`);
      } catch (e) {
        console.error('[Dodo Email]', e.message);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[Dodo Webhook]', e.message);
    res.status(400).json({ error: e.message });
  }
});
