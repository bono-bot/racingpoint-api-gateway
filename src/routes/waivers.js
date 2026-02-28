const express = require('express');
const { getAuthClient } = require('@racingpoint/google/auth');
const { readRange } = require('@racingpoint/google/services/sheets');

const router = express.Router();

// Waiver form responses spreadsheet
// This should be the Google Sheets ID where Google Form responses are saved
const WAIVER_SHEET_ID = process.env.WAIVER_SHEET_ID || '';

function getAuth() {
  return getAuthClient({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  });
}

// GET /api/waivers — list all waiver form responses
router.get('/', async (req, res) => {
  if (!WAIVER_SHEET_ID) {
    return res.json({ waivers: [], message: 'WAIVER_SHEET_ID not configured. Set it to the Google Sheets ID where form responses are saved.' });
  }

  try {
    const auth = getAuth();
    // Form responses typically go to "Form Responses 1" sheet
    const rows = await readRange({ auth, spreadsheetId: WAIVER_SHEET_ID, range: 'Form Responses 1' });

    if (rows.length === 0) {
      return res.json({ waivers: [], headers: [] });
    }

    const headers = rows[0];
    const waivers = rows.slice(1).map((row, i) => {
      const entry = { _index: i + 1 };
      headers.forEach((h, j) => {
        entry[h] = row[j] || '';
      });
      return entry;
    });

    // Try to identify phone/email columns for matching
    const phoneCol = headers.find(h => /phone|mobile|number/i.test(h));
    const emailCol = headers.find(h => /email/i.test(h));
    const nameCol = headers.find(h => /name/i.test(h));
    const timestampCol = headers.find(h => /timestamp/i.test(h));

    res.json({
      waivers,
      headers,
      mapping: { phone: phoneCol || null, email: emailCol || null, name: nameCol || null, timestamp: timestampCol || null },
      total: waivers.length,
    });
  } catch (err) {
    req.log.error({ err }, 'Failed to fetch waivers');
    res.status(500).json({ error: 'Failed to fetch waiver data', message: err.message });
  }
});

// GET /api/waivers/check?phone=xxx&email=xxx — check if customer has signed waiver
router.get('/check', async (req, res) => {
  if (!WAIVER_SHEET_ID) {
    return res.json({ signed: false, message: 'Waiver sheet not configured' });
  }

  const { phone, email } = req.query;
  if (!phone && !email) {
    return res.status(400).json({ error: 'phone or email required' });
  }

  try {
    const auth = getAuth();
    const rows = await readRange({ auth, spreadsheetId: WAIVER_SHEET_ID, range: 'Form Responses 1' });

    if (rows.length <= 1) {
      return res.json({ signed: false });
    }

    const headers = rows[0];
    const phoneIdx = headers.findIndex(h => /phone|mobile|number/i.test(h));
    const emailIdx = headers.findIndex(h => /email/i.test(h));

    const found = rows.slice(1).find(row => {
      if (phone && phoneIdx >= 0) {
        const rowPhone = (row[phoneIdx] || '').replace(/\D/g, '').slice(-10);
        const queryPhone = phone.replace(/\D/g, '').slice(-10);
        if (rowPhone === queryPhone) return true;
      }
      if (email && emailIdx >= 0) {
        if ((row[emailIdx] || '').toLowerCase() === email.toLowerCase()) return true;
      }
      return false;
    });

    res.json({ signed: !!found, waiver: found ? Object.fromEntries(headers.map((h, i) => [h, found[i] || ''])) : null });
  } catch (err) {
    req.log.error({ err }, 'Failed to check waiver');
    res.status(500).json({ error: 'Waiver check failed', message: err.message });
  }
});

module.exports = router;
