const { Router } = require('express');
const { execFile } = require('child_process');
const logger = require('../utils/logger');

const router = Router();
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/root/.local/bin/claude';

// POST /api/ollama/chat — Uses Claude CLI as primary AI backend
router.post('/chat', async (req, res) => {
  const messages = req.body.messages || [];
  const userMsg = messages.map(m => m.content).join('\n');

  if (!userMsg.trim()) {
    return res.status(400).json({ error: 'No message content' });
  }

  // Primary: Claude CLI
  try {
    const reply = await new Promise((resolve, reject) => {
      const proc = execFile(
        CLAUDE_BIN,
        ['-p', '--model', 'haiku', '--no-session-persistence'],
        { timeout: 60000, maxBuffer: 1024 * 256, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE')) },
        (err, stdout, stderr) => {
          if (err) return reject(err);
          resolve(stdout.trim());
        }
      );
      proc.stdin.write(userMsg);
      proc.stdin.end();
    });

    if (reply) {
      return res.json({ reply });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Claude CLI failed, trying OpenRouter fallback');
  }

  // Fallback: OpenRouter free tier
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  if (OPENROUTER_KEY) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.OPENROUTER_MODEL || 'openrouter/free',
          messages: req.body.messages,
        }),
        signal: AbortSignal.timeout(30000),
      });

      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content;
      if (reply) {
        return res.json({ reply });
      }
    } catch (err) {
      logger.error({ err: err.message }, 'All AI backends failed');
    }
  }

  res.status(502).json({ error: 'AI service unavailable' });
});

module.exports = router;
