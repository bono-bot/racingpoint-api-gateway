const crypto = require('crypto');
const logger = require('./logger');

let razorpay = null;

try {
  const Razorpay = require('razorpay');
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET &&
      !process.env.RAZORPAY_KEY_ID.includes('placeholder')) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    logger.info('Razorpay SDK initialized');
  } else {
    logger.warn('Razorpay keys not configured — payment features disabled. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  }
} catch (err) {
  logger.warn({ err }, 'Failed to initialize Razorpay SDK');
}

/**
 * Verify Razorpay webhook signature using HMAC-SHA256.
 * @param {Buffer|string} rawBody - The raw request body
 * @param {string} signature - The x-razorpay-signature header value
 * @returns {boolean} Whether the signature is valid
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    logger.warn('RAZORPAY_WEBHOOK_SECRET not set — cannot verify webhook');
    return false;
  }
  const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET);
  hmac.update(rawBody);
  const digest = hmac.digest('hex');
  return digest === signature;
}

module.exports = { razorpay, verifyWebhookSignature };
