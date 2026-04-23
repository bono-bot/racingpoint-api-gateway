const { Router } = require('express');
const logger = require('../utils/logger');

const router = Router();
const RACECONTROL_URL = process.env.RACECONTROL_URL || 'http://localhost:8080';

// Proxy all requests to RaceControl API
router.all('/*', async (req, res) => {
  const path = req.params[0] || '';
  // Extract query string from req.originalUrl rather than the deprecated
  // Node-internal req._parsedUrl (undefined under some Express/Node combos).
  const qsIndex = req.originalUrl.indexOf('?');
  const search = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';
  const url = `${RACECONTROL_URL}/api/v1/${path}${search}`;

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });

    // Defensive body parse: upstream may return empty 204, HTML error pages,
    // or text. Fall back to raw text so callers always get a useful response.
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    let data;
    if (contentType.includes('application/json') && raw.length > 0) {
      try { data = JSON.parse(raw); }
      catch { data = { raw, parse_error: true }; }
    } else {
      data = raw.length > 0 ? { raw } : {};
    }
    res.status(response.status).json(data);
  } catch (err) {
    logger.error({ err, url }, 'RaceControl proxy failed');
    res.status(502).json({ error: 'RaceControl service unavailable' });
  }
});

module.exports = router;
