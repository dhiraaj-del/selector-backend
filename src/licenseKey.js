/**
 * licenseKey.js — generates and validates license keys
 * Format: SLCT-XXXX-XXXX-XXXX-XXXX  (readable, 20 chars after prefix)
 */

const crypto = require('crypto');

/**
 * Generate a unique license key
 * e.g. SLCT-A3F2-9K1M-B7QX-2P4R
 */
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 (confusing)
  const segment = () => Array.from({ length: 4 }, () =>
    chars[crypto.randomInt(0, chars.length)]
  ).join('');
  return `SLCT-${segment()}-${segment()}-${segment()}-${segment()}`;
}

/**
 * Basic format check before hitting the DB
 */
function isValidKeyFormat(key) {
  return /^SLCT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(
    (key || '').toUpperCase().trim()
  );
}

module.exports = { generateLicenseKey, isValidKeyFormat };
