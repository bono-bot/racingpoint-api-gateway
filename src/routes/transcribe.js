const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

const router = express.Router();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB Groq limit

const upload = multer({
  dest: '/tmp/transcribe-uploads/',
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB (we extract audio from video)
});

// Extract audio from video using ffmpeg
async function extractAudio(inputPath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mpeg'];

  if (!videoExts.includes(ext)) return inputPath;

  const outputPath = inputPath + '.flac';
  try {
    execSync(
      `ffmpeg -i "${inputPath}" -ar 16000 -ac 1 -c:a flac "${outputPath}" -y 2>/dev/null`,
      { timeout: 120000 }
    );
    return outputPath;
  } catch (err) {
    logger.warn({ err: err.message }, 'ffmpeg extraction failed, trying raw upload');
    return inputPath;
  }
}

// Send form-data to Groq using https module (form-data + fetch doesn't work)
function sendToGroq(form) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${GROQ_API_KEY}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, data: { text: body } });
          }
        });
      }
    );
    req.on('error', reject);
    form.pipe(req);
  });
}

// Build Groq form from audio file + options
function buildGroqForm(audioPath, originalExt, options = {}) {
  const form = new FormData();
  const ext = path.extname(audioPath).toLowerCase() || originalExt || '.wav';
  form.append('file', fs.createReadStream(audioPath), {
    filename: `audio${ext}`,
    contentType: 'application/octet-stream',
  });
  form.append('model', options.model || 'whisper-large-v3-turbo');
  form.append('response_format', options.response_format || 'verbose_json');
  if (options.language) form.append('language', options.language);
  if (options.prompt) form.append('prompt', options.prompt);
  if (options.timestamps && (options.response_format || 'verbose_json') === 'verbose_json') {
    options.timestamps.split(',').forEach(g => form.append('timestamp_granularities[]', g.trim()));
  }
  return form;
}

// Cleanup temp files
function cleanup(...paths) {
  for (const p of paths) {
    try { if (p) fs.unlinkSync(p); } catch {}
  }
}

// POST /api/transcribe — upload file
router.post('/', upload.single('file'), async (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send multipart form with "file" field.' });

  const { path: tmpPath, originalname, size } = req.file;
  let audioPath = tmpPath;

  try {
    audioPath = await extractAudio(tmpPath, originalname);
    const audioSize = fs.statSync(audioPath).size;

    if (audioSize > MAX_FILE_SIZE) {
      return res.status(413).json({
        error: `File too large (${(audioSize / 1024 / 1024).toFixed(1)}MB, max 25MB). Try a shorter clip.`,
      });
    }

    const opts = {
      model: req.query.model || req.body?.model,
      response_format: req.query.response_format || req.body?.response_format,
      language: req.query.language || req.body?.language,
      prompt: req.query.prompt || req.body?.prompt,
      timestamps: req.query.timestamps || req.body?.timestamps,
    };

    const form = buildGroqForm(audioPath, path.extname(originalname).toLowerCase(), opts);

    logger.info({ originalname, size, audioSize, model: opts.model || 'whisper-large-v3-turbo' }, 'Transcribing');

    const { status, data } = await sendToGroq(form);

    if (status !== 200) {
      logger.error({ status, data }, 'Groq API error');
      return res.status(status).json({ error: 'Transcription failed', details: data });
    }

    logger.info({ duration: data.duration, textLength: data.text?.length }, 'Transcription complete');

    res.json({
      status: 'ok',
      text: data.text,
      duration: data.duration,
      language: data.language,
      model: opts.model || 'whisper-large-v3-turbo',
      segments: data.segments || undefined,
      words: data.words || undefined,
      original_filename: originalname,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Transcription error');
    res.status(500).json({ error: 'Transcription failed', details: err.message });
  } finally {
    cleanup(tmpPath, audioPath !== tmpPath ? audioPath : null);
  }
});

// POST /api/transcribe/url — transcribe from URL
router.post('/url', async (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  const { url, model, language, response_format: respFormat, prompt } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing "url" in request body' });

  const tmpPath = `/tmp/transcribe-downloads/${Date.now()}-${path.basename(url).slice(0, 50)}`;
  let audioPath = tmpPath;

  try {
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    execSync(`curl -sL -o "${tmpPath}" "${url}"`, { timeout: 120000 });

    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      return res.status(400).json({ error: 'Failed to download file from URL' });
    }

    audioPath = await extractAudio(tmpPath, url);
    const audioSize = fs.statSync(audioPath).size;

    if (audioSize > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File too large (${(audioSize / 1024 / 1024).toFixed(1)}MB, max 25MB)` });
    }

    const form = buildGroqForm(audioPath, path.extname(url).toLowerCase(), { model, language, response_format: respFormat, prompt });
    const { status, data } = await sendToGroq(form);

    if (status !== 200) {
      return res.status(status).json({ error: 'Transcription failed', details: data });
    }

    res.json({
      status: 'ok',
      text: data.text,
      duration: data.duration,
      language: data.language,
      model: model || 'whisper-large-v3-turbo',
      segments: data.segments || undefined,
      words: data.words || undefined,
      source_url: url,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'URL transcription error');
    res.status(500).json({ error: 'Transcription failed', details: err.message });
  } finally {
    cleanup(tmpPath, audioPath !== tmpPath ? audioPath : null);
  }
});

module.exports = router;
