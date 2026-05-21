/**
 * email.js — sends license key emails via Gmail SMTP
 */

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,  // Gmail App Password
  },
});

/**
 * Send license key to customer after successful payment
 */
async function sendLicenseEmail({ to, licenseKey, orderId }) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; background: #f5f0e8; margin: 0; padding: 40px 20px; }
    .container { max-width: 520px; margin: 0 auto; background: #fff; border: 1px solid #e0dbd1; }
    .header { background: #1a1a1a; padding: 32px 40px; text-align: center; }
    .header h1 { color: #f5f0e8; font-size: 22px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; margin: 0; }
    .header p { color: #888; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; margin: 6px 0 0; }
    .body { padding: 40px; }
    .thanks { font-size: 18px; font-weight: 700; color: #1a1a1a; margin-bottom: 12px; }
    .text { font-size: 14px; color: #555; line-height: 1.7; margin-bottom: 24px; }
    .key-box { background: #f5f0e8; border: 2px solid #1a1a1a; padding: 20px; text-align: center; margin: 28px 0; }
    .key-label { font-size: 10px; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; color: #888; margin-bottom: 10px; }
    .key { font-family: 'SF Mono', 'Fira Code', 'Courier New', monospace; font-size: 22px; font-weight: 800; color: #1a1a1a; letter-spacing: .08em; }
    .steps { background: #f9f7f3; padding: 20px 24px; margin: 24px 0; }
    .steps h3 { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #999; margin: 0 0 12px; }
    .step { font-size: 13px; color: #444; margin-bottom: 8px; display: flex; gap: 10px; }
    .step-num { font-weight: 800; color: #1a1a1a; flex-shrink: 0; }
    .footer { padding: 20px 40px; border-top: 1px solid #e0dbd1; font-size: 11px; color: #aaa; text-align: center; line-height: 1.6; }
    .brand { color: #e05c2a; font-weight: 700; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Selector</h1>
      <p>by Crab Culture</p>
    </div>
    <div class="body">
      <div class="thanks">You're all set 🎉</div>
      <p class="text">
        Thanks for purchasing Selector Pro. Your license key is below —
        keep this email safe, you'll need it if you reinstall the app.
      </p>

      <div class="key-box">
        <div class="key-label">Your License Key</div>
        <div class="key">${licenseKey}</div>
      </div>

      <div class="steps">
        <h3>How to activate</h3>
        <div class="step"><span class="step-num">1.</span> Open Selector on your Mac</div>
        <div class="step"><span class="step-num">2.</span> Click "Already purchased? Enter license key"</div>
        <div class="step"><span class="step-num">3.</span> Paste your key above and click Activate</div>
        <div class="step"><span class="step-num">4.</span> Done — unlimited tracks unlocked</div>
      </div>

      <p class="text">
        Your key works on up to 3 machines. If you need more activations,
        reply to this email and we'll sort it out.
      </p>
    </div>
    <div class="footer">
      Order ID: ${orderId}<br>
      Questions? Reply to this email.<br><br>
      <span class="brand">Crab Culture</span> · Made with ♥ for DJs
    </div>
  </div>
</body>
</html>
  `;

  await transporter.sendMail({
    from: `"Selector by Crab Culture" <${process.env.EMAIL_FROM}>`,
    to,
    subject: '🦀 Your Selector Pro License Key',
    html,
    text: `Your Selector Pro license key: ${licenseKey}\n\nOrder ID: ${orderId}\n\nTo activate: Open Selector → click "Already purchased? Enter license key" → paste your key.`,
  });

  console.log(`[Email] License sent to ${to}`);
}

module.exports = { sendLicenseEmail };
