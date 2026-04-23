const { Router } = require('express');
const Database = require('better-sqlite3');
const logger = require('../utils/logger');

const router = Router();

// GET /api/customers
router.get('/', (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    const customers = new Map();

    // Fetch from WhatsApp
    try {
      const waDb = new Database(process.env.WHATSAPP_DB_PATH, { readonly: true });
      const waBookings = waDb.prepare('SELECT customer_name, customer_phone, customer_email, booking_type, session_date, status, created_at FROM bookings ORDER BY created_at DESC').all();
      waDb.close();

      for (const b of waBookings) {
        const key = b.customer_phone;
        if (!customers.has(key)) {
          customers.set(key, {
            name: b.customer_name,
            phone: b.customer_phone,
            email: b.customer_email,
            sources: new Set(['whatsapp']),
            total_bookings: 0,
            confirmed_bookings: 0,
            first_booking: b.created_at,
            last_booking: b.created_at,
          });
        }
        const c = customers.get(key);
        c.sources.add('whatsapp');
        c.total_bookings++;
        if (b.status === 'confirmed') c.confirmed_bookings++;
        if (!c.email && b.customer_email) c.email = b.customer_email;
        if (b.created_at < c.first_booking) c.first_booking = b.created_at;
        if (b.created_at > c.last_booking) c.last_booking = b.created_at;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to read WhatsApp DB for customers');
    }

    // Fetch from Discord
    try {
      const dcDb = new Database(process.env.DISCORD_DB_PATH, { readonly: true });
      const dcBookings = dcDb.prepare('SELECT customer_name, customer_phone, customer_email, booking_type, session_date, status, created_at FROM bookings ORDER BY created_at DESC').all();
      dcDb.close();

      for (const b of dcBookings) {
        const key = b.customer_phone;
        if (!customers.has(key)) {
          customers.set(key, {
            name: b.customer_name,
            phone: b.customer_phone,
            email: b.customer_email,
            sources: new Set(['discord']),
            total_bookings: 0,
            confirmed_bookings: 0,
            first_booking: b.created_at,
            last_booking: b.created_at,
          });
        }
        const c = customers.get(key);
        c.sources.add('discord');
        c.total_bookings++;
        if (b.status === 'confirmed') c.confirmed_bookings++;
        if (!c.email && b.customer_email) c.email = b.customer_email;
        if (b.created_at < c.first_booking) c.first_booking = b.created_at;
        if (b.created_at > c.last_booking) c.last_booking = b.created_at;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to read Discord DB for customers');
    }

    let result = Array.from(customers.values()).map(c => ({
      ...c,
      sources: Array.from(c.sources),
    }));

    // Search filter — null-safe on every column (DB allows NULL name/phone/email)
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(c =>
        (c.name && c.name.toLowerCase().includes(s)) ||
        (c.phone && c.phone.includes(s)) ||
        (c.email && c.email.toLowerCase().includes(s))
      );
    }

    // Sort by last booking descending
    result.sort((a, b) => new Date(b.last_booking) - new Date(a.last_booking));

    // Defensive pagination: NaN-coerce + clamp.
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);

    const total = result.length;
    const paginated = result.slice(off, off + lim);

    res.json({ customers: paginated, total, limit: lim, offset: off });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch customers');
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

module.exports = router;
