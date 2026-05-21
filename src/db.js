/**
 * db.js — PostgreSQL connection + schema setup
 * Tables:
 *   orders    — tracks Razorpay orders + payment status
 *   licenses  — activated license keys per machine
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function setupDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id              SERIAL PRIMARY KEY,
        razorpay_order_id   VARCHAR(100) UNIQUE NOT NULL,
        razorpay_payment_id VARCHAR(100),
        email           VARCHAR(255) NOT NULL,
        amount          INTEGER NOT NULL,          -- in paise (1999 * 100)
        currency        VARCHAR(10) DEFAULT 'INR',
        status          VARCHAR(20) DEFAULT 'created',  -- created | paid | failed
        license_key     VARCHAR(50),
        created_at      TIMESTAMP DEFAULT NOW(),
        paid_at         TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS licenses (
        id              SERIAL PRIMARY KEY,
        license_key     VARCHAR(50) UNIQUE NOT NULL,
        email           VARCHAR(255) NOT NULL,
        order_id        VARCHAR(100) NOT NULL,
        activations     INTEGER DEFAULT 0,
        max_activations INTEGER DEFAULT 3,         -- allow up to 3 machines
        active          BOOLEAN DEFAULT true,
        created_at      TIMESTAMP DEFAULT NOW(),
        last_seen       TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_orders_razorpay_id ON orders(razorpay_order_id);
      CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
      CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
    `);
    console.log('[DB] Tables ready');
  } finally {
    client.release();
  }
}

module.exports = { pool, setupDatabase };
