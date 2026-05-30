require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const { v4: uuid } = require('uuid');
const nodemailer = require('nodemailer');
const { Pool }   = require('pg');

const app  = express();
const PORT = process.env.PORT || 3001;

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

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

app.use(cors());
app.use(express.json());

function generateLicenseKey() {
  const random = crypto.randomBytes(8).toString('hex').toUpperCase();
  return 'SELC-' + random.match(/.{1,4}/g).join('-');
}

async function sendLicenseEmail(email, licenseKey, orderId) {
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f0e8;margin:0;padding:40px 20px;"><div style="max-width:480px;margin:0 auto;background:#ede8de;padding:40px;border:1px solid #d4cfc5;"><div style="margin-bottom:32px;"><div style="font-size:18px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#1a1a1a;">SELECTOR</div><div style="font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#e05c2a;margin-top:2px;">by Crab Culture</div></div><div style="font-size:22px;font-weight:800;color:#1a1a1a;margin-bottom:12px;">You're all set!</div><div style="font-size:14px;color:#666;line-height:1.6;margin-bottom:32px;">Thanks for purchasing Selector. Your license key is below.</div><div style="background:#1a1a1a;padding:20px;text-align:center;margin-bottom:32px;"><div style="font-size:11px;color:#888;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px;">Your License Key</div><div style="font-size:20px;font-weight:800;color:#f5f0e8;letter-spacing:.08em;font-family:monospace;">${licenseKey}</div></div><div style="font-size:13px;color:#666;line-height:1.8;margin-bottom:32px;"><strong>How to activate:</strong><br>1. Open Selector<br>2. Click "Already purchased? Enter license key"<br>3. Paste your key and click Activate</div><div style="font-size:11px;color:#999;border-top:1px solid #d4cfc5;padding-top:20px;">Order: ${orderId}<br>Questions? hello@crabculture.com</div></div></body></html>`;
  await transporter.sendMail({
    from:    `"Selector by Crab Culture" <${process.env.FROM_EMAIL}>`,
    to:      email,
    subject: 'Your Selector License Key',
    html,
  });
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Selector License Backend', version: '2.0.0' });
});

app.post('/webhook/dodo', async (req, res) => {
  try {
    const event = req.body;
    console.log('[Dodo] Webhook received:', event.type);
    console.log('[Dodo] Payload:', JSON.stringify(event, null, 2));

    if (event.type === 'payment.succeeded') {
      const data       = event.data || {};
      const email      = data.customer?.email || data.email;
      const payment_id = data.payment_id || data.id || String(Date.now());

      if (!email) {
        console.log('[Dodo] No email found, skipping');
        return res.json({ ok: true });
      }

      const existing = await pool.query('SELECT * FROM licenses WHERE order_id=$1', [payment_id]);
      if (existing.rows.length > 0) {
        console.log('[Dodo] License already issued');
        return res.json({ ok: true });
      }

      const licenseKey = generateLicenseKey();
      await pool.query(
        'INSERT INTO licenses (id, key, email, order_id, payment_id) VALUES ($1,$2,$3,$4,$5)',
        [uuid(), licenseKey, email, payment_id, payment_id]
      );

      try {
        await sendLicenseEmail(email, licenseKey, payment_id);
        console.log('[Dodo] License', licenseKey, 'sent to', email);
      } catch (e) {
        console.error('[Dodo Email Error]', e.message);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[Dodo Webhook Error]', e.message);
    res.status(400).json({ error: e.message });
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

    console.log('[Validate] Key', key, 'valid for', license.email);
    res.json({ valid: true, email: license.email, activatedAt: license.activated_at });
  } catch (e) {
    console.error('[Validate Key Error]', e.message);
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

app.get('/stats', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.BACKEND_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const licenses  = await pool.query('SELECT COUNT(*) FROM licenses');
  const activated = await pool.query('SELECT COUNT(*) FROM licenses WHERE activated=1');
  const count     = parseInt(licenses.rows[0].count);

  res.json({
    totalLicenses:     count,
    activatedLicenses: parseInt(activated.rows[0].count),
    revenue:           'INR ' + (count * 1999),
  });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log('Selector backend running on port', PORT);
    console.log('SMTP:', process.env.SMTP_USER ? 'OK' : 'MISSING');
    console.log('DB:', process.env.DATABASE_URL ? 'OK' : 'MISSING');
  });
}).catch(e => {
  console.error('DB init failed:', e.message);
  process.exit(1);
});

// ── Validate Dodo License Key ─────────────────────────────────────
app.post('/validate-dodo-key', async (req, res) => {
  try {
    const { key, instanceId } = req.body;
    if (!key) return res.status(400).json({ valid: false, error: 'Key required' });

    const https = require('https');
    const result = await new Promise((resolve) => {
      const options = {
        hostname: 'live.dodopayments.com',
        path: '/licenses/activate',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DODO_API_KEY}`,
          'Content-Type': 'application/json',
        },
      };
      const reqBody = JSON.stringify({ license_key: key.trim(), name: instanceId || 'Selector' });
      const r = https.request(options, (resp) => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => { try { resolve({ status: resp.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: resp.statusCode, data: d }); } });
      });
      r.on('error', () => resolve({ status: 500, data: {} }));
      r.write(reqBody);
      r.end();
    });

    console.log('[Dodo Validate]', key, '→', result.status, JSON.stringify(result.data));

    if (result.status === 200 && result.data?.id) {
      return res.json({ valid: true, email: result.data?.customer?.email || '' });
    }
    return res.json({ valid: false, error: result.data?.message || 'Invalid license key' });
  } catch (e) {
    console.error('[Dodo Validate Error]', e.message);
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});
