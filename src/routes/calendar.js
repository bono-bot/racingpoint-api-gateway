const express = require('express');
const { getAuthClient } = require('@racingpoint/google/auth');
const { listEvents } = require('@racingpoint/google/services/calendar');

const router = express.Router();

function getAuth() {
  return getAuthClient({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  });
}

// GET /api/calendar — list upcoming events
router.get('/', async (req, res) => {
  try {
    const auth = getAuth();
    const maxResults = parseInt(req.query.limit) || 20;
    const events = await listEvents({ auth, maxResults });
    res.json({ events });
  } catch (err) {
    req.log.error({ err }, 'Failed to fetch calendar events');
    res.status(500).json({ error: 'Failed to fetch calendar events', message: err.message });
  }
});

module.exports = router;
