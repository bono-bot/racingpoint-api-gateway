const { Router } = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const cron = require('node-cron');
const logger = require('../utils/logger');
const { razorpay, verifyWebhookSignature } = require('../utils/razorpay');

const router = Router();

const RACECONTROL_URL = process.env.RACECONTROL_URL || 'http://localhost:8080';
const DB_PATH = path.join(__dirname, '../../data/gateway.db');

// ─── Database setup ──────────────────────────────────────────────────────────

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

// Initialize payment_orders table on first require
(function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      razorpay_order_id TEXT NOT NULL UNIQUE,
      razorpay_payment_id TEXT,
      driver_id TEXT NOT NULL,
      amount_paise INTEGER NOT NULL,
      bonus_paise INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created'
        CHECK(status IN ('created', 'attempted', 'paid', 'failed', 'refunded')),
      webhook_event_id TEXT,
      credited_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_po_driver ON payment_orders(driver_id);
    CREATE INDEX IF NOT EXISTS idx_po_rzp_order ON payment_orders(razorpay_order_id);
  `);
  db.close();
  logger.info('Payment orders database initialized');
})();

// ─── Shared credit helper ────────────────────────────────────────────────────

/**
 * Credit wallet via rc-core for a payment order.
 * Returns { credited: boolean, bonus_paise: number }
 */
async function creditWallet(order) {
  const db = getDb();
  try {
    const resp = await fetch(`${RACECONTROL_URL}/api/v1/wallet/${order.driver_id}/topup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_paise: order.amount_paise,
        method: 'online',
        notes: `Razorpay payment ${order.razorpay_payment_id || order.razorpay_order_id}`,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const bonusPaise = data.bonus_paise || 0;
      db.prepare(
        "UPDATE payment_orders SET credited_at = datetime('now'), bonus_paise = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(bonusPaise, order.id);
      logger.info({ orderId: order.id, driverId: order.driver_id, bonusPaise }, 'Wallet credited successfully');
      return { credited: true, bonus_paise: bonusPaise };
    } else {
      const errText = await resp.text();
      logger.error({ orderId: order.id, status: resp.status, body: errText }, 'Wallet credit failed');
      return { credited: false, bonus_paise: 0 };
    }
  } finally {
    db.close();
  }
}

// ─── POST /create-order ──────────────────────────────────────────────────────

router.post('/create-order', async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Payment gateway not configured' });
  }

  try {
    let driverId = req.body.driver_id;

    // If Bearer token is present, extract driver_id from PWA JWT
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const profileResp = await fetch(`${RACECONTROL_URL}/api/v1/customer/profile`, {
          headers: { 'Authorization': authHeader },
        });
        if (profileResp.ok) {
          const profile = await profileResp.json();
          driverId = profile.driver?.id || profile.id;
        } else {
          return res.status(401).json({ error: 'Invalid authentication token' });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to verify bearer token');
        return res.status(401).json({ error: 'Authentication failed' });
      }
    }

    if (!driverId) {
      return res.status(400).json({ error: 'driver_id is required' });
    }

    const amountPaise = req.body.amount_paise;
    if (!amountPaise || typeof amountPaise !== 'number' || amountPaise < 10000) {
      return res.status(400).json({ error: 'amount_paise must be at least 10000 (100 credits)' });
    }
    if (amountPaise > 1000000) {
      return res.status(400).json({ error: 'amount_paise must not exceed 1000000 (10000 credits)' });
    }

    const orderId = `rp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: orderId,
      payment_capture: 1,
      notes: {
        driver_id: driverId,
        source: 'pwa_topup',
      },
    });

    const db = getDb();
    db.prepare(
      "INSERT INTO payment_orders (id, razorpay_order_id, driver_id, amount_paise, status) VALUES (?, ?, ?, ?, 'created')"
    ).run(orderId, order.id, driverId, amountPaise);
    db.close();

    logger.info({ orderId, razorpayOrderId: order.id, driverId, amountPaise }, 'Payment order created');

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to create payment order');
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// ─── GET /orders ─────────────────────────────────────────────────────────────

router.get('/orders', (req, res) => {
  try {
    const { driver_id, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT * FROM payment_orders WHERE 1=1';
    const params = [];

    if (driver_id) {
      query += ' AND driver_id = ?';
      params.push(driver_id);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const db = getDb();
    const orders = db.prepare(query).all(...params);
    db.close();

    res.json({ orders });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch payment orders');
    res.status(500).json({ error: 'Failed to fetch payment orders' });
  }
});

// ─── Webhook handler (exported separately for raw body registration) ─────────

async function webhookHandler(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    if (!verifyWebhookSignature(req.body, signature)) {
      logger.warn('Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body.toString());

    // Only process payment.captured events
    if (event.event !== 'payment.captured') {
      return res.status(200).send('OK');
    }

    const payment = event.payload.payment.entity;
    const rzpOrderId = payment.order_id;

    const db = getDb();
    const order = db.prepare(
      'SELECT * FROM payment_orders WHERE razorpay_order_id = ?'
    ).get(rzpOrderId);

    if (!order) {
      db.close();
      logger.warn({ rzpOrderId }, 'Webhook received for unknown order');
      return res.status(200).send('OK');
    }

    // Idempotency check
    if (order.status === 'paid') {
      db.close();
      logger.info({ orderId: order.id }, 'Webhook duplicate — already paid');
      return res.status(200).send('OK');
    }

    // Mark as paid FIRST (prevents double-credit on webhook retry)
    db.prepare(
      "UPDATE payment_orders SET status = 'paid', razorpay_payment_id = ?, webhook_event_id = ?, updated_at = datetime('now') WHERE razorpay_order_id = ? AND status != 'paid'"
    ).run(payment.id, event.event_id || null, rzpOrderId);
    db.close();

    logger.info({ orderId: order.id, paymentId: payment.id }, 'Payment marked as paid');

    // Credit wallet via rc-core
    try {
      await creditWallet({ ...order, razorpay_payment_id: payment.id });
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'Wallet credit failed — reconciliation will retry');
    }

    res.status(200).send('OK');
  } catch (err) {
    logger.error({ err }, 'Webhook processing error');
    res.status(200).send('OK');
  }
}

// ─── Reconciliation cron ─────────────────────────────────────────────────────

if (razorpay) {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const db = getDb();
      const staleOrders = db.prepare(
        "SELECT * FROM payment_orders WHERE status IN ('created', 'attempted') AND created_at < datetime('now', '-10 minutes')"
      ).all();
      db.close();

      if (staleOrders.length === 0) return;

      logger.info({ count: staleOrders.length }, 'Reconciliation: checking stale orders');

      for (const order of staleOrders) {
        try {
          const payments = await razorpay.orders.fetchPayments(order.razorpay_order_id);
          const captured = payments.items ? payments.items.find(p => p.status === 'captured') : null;

          if (captured) {
            const db2 = getDb();
            const current = db2.prepare('SELECT status FROM payment_orders WHERE id = ?').get(order.id);
            if (current && current.status !== 'paid') {
              db2.prepare(
                "UPDATE payment_orders SET status = 'paid', razorpay_payment_id = ?, updated_at = datetime('now') WHERE id = ? AND status != 'paid'"
              ).run(captured.id, order.id);
              db2.close();

              logger.info({ orderId: order.id, paymentId: captured.id }, 'Reconciliation: crediting wallet');
              await creditWallet({ ...order, razorpay_payment_id: captured.id });
            } else {
              db2.close();
            }
          } else {
            // Mark stale orders as failed after 30 minutes
            const db2 = getDb();
            const orderAge = db2.prepare(
              "SELECT (julianday('now') - julianday(created_at)) * 24 * 60 as age_minutes FROM payment_orders WHERE id = ?"
            ).get(order.id);
            if (orderAge && orderAge.age_minutes > 30) {
              db2.prepare(
                "UPDATE payment_orders SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status IN ('created', 'attempted')"
              ).run(order.id);
              logger.info({ orderId: order.id }, 'Reconciliation: marking stale order as failed');
            }
            db2.close();
          }
        } catch (err) {
          logger.error({ err, orderId: order.id }, 'Reconciliation: error processing order');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Reconciliation cron error');
    }
  });
  logger.info('Payment reconciliation cron scheduled (every 5 minutes)');
}

module.exports = { router, webhookHandler };
