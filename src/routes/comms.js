const { Router } = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const router = Router();

const DB_PATH = path.join(__dirname, '../../data/comms.db');

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

// Initialize database on first require
(function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL CHECK(sender IN ('bono', 'james')),
      recipient TEXT NOT NULL CHECK(recipient IN ('bono', 'james')),
      type TEXT NOT NULL DEFAULT 'update' CHECK(type IN ('task', 'update', 'query', 'response', 'command', 'command_result')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
      subject TEXT NOT NULL,
      body TEXT,
      ref_id INTEGER,
      status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'read', 'archived')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_status ON messages(recipient, status);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_ref_id ON messages(ref_id);

    CREATE TABLE IF NOT EXISTS heartbeats (
      agent TEXT PRIMARY KEY CHECK(agent IN ('bono', 'james')),
      last_beat TEXT NOT NULL DEFAULT (datetime('now')),
      pm2_status TEXT,
      uptime_seconds INTEGER,
      meta TEXT
    );
  `);
  db.close();
  logger.info('Comms database initialized');
})();

// POST /api/comms/messages — send a message
router.post('/messages', (req, res) => {
  try {
    const { sender, recipient, type = 'update', priority = 'normal', subject, body, ref_id } = req.body;

    if (!sender || !recipient || !subject) {
      return res.status(400).json({ error: 'sender, recipient, and subject are required' });
    }
    if (sender === recipient) {
      return res.status(400).json({ error: 'sender and recipient must be different' });
    }

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO messages (sender, recipient, type, priority, subject, body, ref_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sender, recipient, type, priority, subject, body || null, ref_id || null);

    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
    db.close();

    logger.info({ id: message.id, sender, recipient, type, subject }, 'Message sent');

    // Unified delivery bridge: forward to comms-link WS for real-time delivery.
    // Fire-and-forget — DB is source of truth, WS delivery is best-effort.
    const COMMS_LINK_URL = process.env.COMMS_LINK_URL || 'http://localhost:8765';
    try {
      const deliverPayload = JSON.stringify({
        id: message.id, sender, recipient, type, subject,
        body: body || null, priority,
      });
      const deliverReq = require('http').request(
        `${COMMS_LINK_URL}/relay/deliver`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(deliverPayload) }, timeout: 3000 },
        (deliverRes) => {
          let d = '';
          deliverRes.on('data', (c) => { d += c; });
          deliverRes.on('end', () => {
            logger.info({ db_id: message.id, ws_response: d.slice(0, 200) }, 'WS delivery bridge notified');
          });
        }
      );
      deliverReq.on('error', (err) => {
        logger.warn({ db_id: message.id, err: err.message }, 'WS delivery bridge unreachable (message persisted in DB)');
      });
      deliverReq.write(deliverPayload);
      deliverReq.end();
    } catch (bridgeErr) {
      logger.warn({ db_id: message.id, err: bridgeErr.message }, 'WS delivery bridge error');
    }

    res.status(201).json(message);
  } catch (err) {
    logger.error({ err }, 'Failed to send message');
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// GET /api/comms/messages — list messages
router.get('/messages', (req, res) => {
  try {
    const { recipient, sender, status, type, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT * FROM messages WHERE 1=1';
    const params = [];

    if (recipient) { query += ' AND recipient = ?'; params.push(recipient); }
    if (sender) { query += ' AND sender = ?'; params.push(sender); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (type) { query += ' AND type = ?'; params.push(type); }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const db = getDb();
    const messages = db.prepare(query).all(...params);
    const total = db.prepare(
      query.replace('SELECT *', 'SELECT COUNT(*) as count').replace(/ ORDER BY.*$/, '')
    ).get(...params.slice(0, -2)).count;
    db.close();

    res.json({ messages, total, limit: Number(limit), offset: Number(offset) });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch messages');
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/comms/messages/:id — get single message
router.get('/messages/:id', (req, res) => {
  try {
    const db = getDb();
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    db.close();

    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch message');
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// PATCH /api/comms/messages/:id/read — mark as read
router.patch('/messages/:id/read', (req, res) => {
  try {
    const db = getDb();
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!message) { db.close(); return res.status(404).json({ error: 'Message not found' }); }

    db.prepare("UPDATE messages SET status = 'read', read_at = datetime('now') WHERE id = ?").run(req.params.id);
    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    db.close();

    res.json(updated);
  } catch (err) {
    logger.error({ err }, 'Failed to mark message as read');
    res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

// PATCH /api/comms/messages/:id/archive — archive a message
router.patch('/messages/:id/archive', (req, res) => {
  try {
    const db = getDb();
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!message) { db.close(); return res.status(404).json({ error: 'Message not found' }); }

    db.prepare("UPDATE messages SET status = 'archived' WHERE id = ?").run(req.params.id);
    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    db.close();

    res.json(updated);
  } catch (err) {
    logger.error({ err }, 'Failed to archive message');
    res.status(500).json({ error: 'Failed to archive message' });
  }
});

// GET /api/comms/unread — quick unread count per recipient
router.get('/unread', (req, res) => {
  try {
    const { recipient } = req.query;
    const db = getDb();

    let result;
    if (recipient) {
      result = db.prepare("SELECT COUNT(*) as count FROM messages WHERE recipient = ? AND status = 'unread'").get(recipient);
    } else {
      result = {
        bono: db.prepare("SELECT COUNT(*) as count FROM messages WHERE recipient = 'bono' AND status = 'unread'").get().count,
        james: db.prepare("SELECT COUNT(*) as count FROM messages WHERE recipient = 'james' AND status = 'unread'").get().count,
      };
    }
    db.close();

    res.json(recipient ? { recipient, unread: result.count } : { unread: result });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch unread count');
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// POST /api/comms/heartbeat — agent sends a heartbeat
router.post('/heartbeat', (req, res) => {
  try {
    const { agent, pm2_status, uptime_seconds, meta } = req.body;
    if (!agent || !['bono', 'james'].includes(agent)) {
      return res.status(400).json({ error: 'agent must be "bono" or "james"' });
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO heartbeats (agent, last_beat, pm2_status, uptime_seconds, meta)
      VALUES (?, datetime('now'), ?, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET
        last_beat = datetime('now'),
        pm2_status = excluded.pm2_status,
        uptime_seconds = excluded.uptime_seconds,
        meta = excluded.meta
    `).run(agent, JSON.stringify(pm2_status || null), uptime_seconds || 0, JSON.stringify(meta || null));
    db.close();

    res.json({ ok: true, agent, time: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, 'Heartbeat failed');
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// GET /api/comms/heartbeat — get all heartbeats
router.get('/heartbeat', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM heartbeats').all();
    db.close();

    const heartbeats = {};
    for (const row of rows) {
      heartbeats[row.agent] = {
        last_beat: row.last_beat,
        pm2_status: JSON.parse(row.pm2_status),
        uptime_seconds: row.uptime_seconds,
        meta: JSON.parse(row.meta),
        age_seconds: Math.floor((Date.now() - new Date(row.last_beat + 'Z').getTime()) / 1000),
      };
    }
    res.json(heartbeats);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch heartbeats');
    res.status(500).json({ error: 'Failed to fetch heartbeats' });
  }
});

// GET /api/comms/heartbeat/:agent — get single agent heartbeat
router.get('/heartbeat/:agent', (req, res) => {
  try {
    const { agent } = req.params;
    const db = getDb();
    const row = db.prepare('SELECT * FROM heartbeats WHERE agent = ?').get(agent);
    db.close();

    if (!row) return res.status(404).json({ error: `No heartbeat from ${agent}` });

    res.json({
      agent: row.agent,
      last_beat: row.last_beat,
      pm2_status: JSON.parse(row.pm2_status),
      uptime_seconds: row.uptime_seconds,
      meta: JSON.parse(row.meta),
      age_seconds: Math.floor((Date.now() - new Date(row.last_beat + 'Z').getTime()) / 1000),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch heartbeat');
    res.status(500).json({ error: 'Failed to fetch heartbeat' });
  }
});

module.exports = router;
