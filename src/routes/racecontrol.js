const { Router } = require('express');
const logger = require('../utils/logger');

const router = Router();
const RACECONTROL_URL = process.env.RACECONTROL_URL || 'http://localhost:8080';

// Proxy all requests to RaceControl API
router.all('/*', async (req, res) => {
  const path = req.params[0] || '';
  const url = `${RACECONTROL_URL}/api/v1/${path}${req._parsedUrl.search || ''}`;

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    logger.error({ err, url }, 'RaceControl proxy failed');
    res.status(502).json({ error: 'RaceControl service unavailable' });
  }
});

module.exports = router;
