const { Router } = require('express');
const logger = require('../utils/logger');

const router = Router();
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:32769';

// POST /api/ollama/chat
router.post('/chat', async (req, res) => {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
        messages: req.body.messages,
        stream: false,
        options: { temperature: 0.7, num_predict: 1024 },
      }),
    });

    const data = await response.json();
    res.json({ reply: data.message?.content || '' });
  } catch (err) {
    logger.error({ err }, 'Ollama proxy failed');
    res.status(502).json({ error: 'AI service unavailable' });
  }
});

module.exports = router;
