const { Router } = require('express');
const Database = require('better-sqlite3');
const { calendar } = require('@racingpoint/google');
const { getAuthClient } = require('@racingpoint/google');
const logger = require('../utils/logger');

const router = Router();

const WHATSAPP_DB = process.env.WHATSAPP_DB_PATH;
const DISCORD_DB = process.env.DISCORD_DB_PATH;

function getWhatsAppDb() {
  return new Database(WHATSAPP_DB, { readonly: true });
}

function getDiscordDb() {
  return new Database(DISCORD_DB, { readonly: true });
}

function getWritableWhatsAppDb() {
  const db = new Database(WHATSAPP_DB);
  db.pragma('busy_timeout = 5000');
  return db;
}

function getWritableDiscordDb() {
  const db = new Database(DISCORD_DB);
  db.pragma('busy_timeout = 5000');
  return db;
}

function getGoogleAuth() {
  return getAuthClient({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  });
}

// GET /api/bookings
router.get('/', (req, res) => {
  try {
    const { search, status, source, date_from, date_to, limit = 50, offset = 0 } = req.query;

    let whatsappBookings = [];
    let discordBookings = [];

    try {
      const waDb = getWhatsAppDb();
      let waQuery = 'SELECT *, "whatsapp" as source, remote_jid as source_user_id FROM bookings WHERE 1=1';
      const waParams = [];

      if (status) { waQuery += ' AND status = ?'; waParams.push(status); }
      if (search) {
        waQuery += ' AND (customer_name LIKE ? OR customer_phone LIKE ? OR booking_id LIKE ?)';
        const s = `%${search}%`;
        waParams.push(s, s, s);
      }
      if (date_from) { waQuery += ' AND session_date >= ?'; waParams.push(date_from); }
      if (date_to) { waQuery += ' AND session_date <= ?'; waParams.push(date_to); }

      waQuery += ' ORDER BY created_at DESC';
      whatsappBookings = waDb.prepare(waQuery).all(...waParams);
      waDb.close();
    } catch (err) {
      logger.warn({ err }, 'Failed to read WhatsApp bookings DB');
    }

    try {
      const dcDb = getDiscordDb();
      let dcQuery = 'SELECT *, "discord" as source, discord_user_id as source_user_id FROM bookings WHERE 1=1';
      const dcParams = [];

      if (status) { dcQuery += ' AND status = ?'; dcParams.push(status); }
      if (search) {
        dcQuery += ' AND (customer_name LIKE ? OR customer_phone LIKE ? OR booking_id LIKE ?)';
        const s = `%${search}%`;
        dcParams.push(s, s, s);
      }
      if (date_from) { dcQuery += ' AND session_date >= ?'; dcParams.push(date_from); }
      if (date_to) { dcQuery += ' AND session_date <= ?'; dcParams.push(date_to); }

      dcQuery += ' ORDER BY created_at DESC';
      discordBookings = dcDb.prepare(dcQuery).all(...dcParams);
      dcDb.close();
    } catch (err) {
      logger.warn({ err }, 'Failed to read Discord bookings DB');
    }

    let all = [...whatsappBookings, ...discordBookings];

    if (source === 'whatsapp') all = whatsappBookings;
    else if (source === 'discord') all = discordBookings;

    // Sort by created_at descending
    all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Defensive pagination: NaN-coerce + clamp to sane bounds.
    // Without this, `?limit=abc` returns NaN and an empty page silently.
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);

    const total = all.length;
    const paginated = all.slice(off, off + lim);

    res.json({ bookings: paginated, total, limit: lim, offset: off });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch bookings');
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// GET /api/bookings/:id
router.get('/:id', (req, res) => {
  const { id } = req.params;

  try {
    const waDb = getWhatsAppDb();
    let booking = waDb.prepare('SELECT *, "whatsapp" as source FROM bookings WHERE booking_id = ?').get(id);
    waDb.close();

    if (!booking) {
      const dcDb = getDiscordDb();
      booking = dcDb.prepare('SELECT *, "discord" as source FROM bookings WHERE booking_id = ?').get(id);
      dcDb.close();
    }

    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    res.json(booking);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch booking');
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// PUT /api/bookings/:id/cancel
router.put('/:id/cancel', async (req, res) => {
  const { id } = req.params;

  try {
    // Find booking and its source
    const waDb = getWhatsAppDb();
    let booking = waDb.prepare('SELECT *, "whatsapp" as source FROM bookings WHERE booking_id = ?').get(id);
    waDb.close();
    let source = 'whatsapp';

    if (!booking) {
      const dcDb = getDiscordDb();
      booking = dcDb.prepare('SELECT *, "discord" as source FROM bookings WHERE booking_id = ?').get(id);
      dcDb.close();
      source = 'discord';
    }

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled') return res.status(400).json({ error: 'Booking already cancelled' });

    // Update status in the correct database
    if (source === 'whatsapp') {
      const db = getWritableWhatsAppDb();
      db.prepare('UPDATE bookings SET status = ? WHERE booking_id = ?').run('cancelled', id);
      db.close();
    } else {
      const db = getWritableDiscordDb();
      db.prepare('UPDATE bookings SET status = ? WHERE booking_id = ?').run('cancelled', id);
      db.close();
    }

    // Delete calendar event if exists
    if (booking.calendar_event_id) {
      try {
        const auth = getGoogleAuth();
        await calendar.deleteEvent({ auth, eventId: booking.calendar_event_id });
        logger.info({ bookingId: id, eventId: booking.calendar_event_id }, 'Calendar event deleted');
      } catch (calErr) {
        logger.warn({ err: calErr, bookingId: id }, 'Failed to delete calendar event');
      }
    }

    logger.info({ bookingId: id, source }, 'Booking cancelled');
    res.json({ success: true, booking_id: id, status: 'cancelled' });
  } catch (err) {
    logger.error({ err }, 'Failed to cancel booking');
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

module.exports = router;
