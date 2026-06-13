'use strict';
const express      = require('express');
const { Pool }     = require('pg');
const cookieParser = require('cookie-parser');
const cron         = require('node-cron');
const path         = require('path');

const app = express();

// Log the DB host we're connecting to (password hidden) so Railway logs show it clearly
const DB_URL = process.env.DATABASE_URL || '';
try {
  const u = new URL(DB_URL);
  console.log(`[db] Will connect to: ${u.protocol}//${u.username}:***@${u.hostname}:${u.port}${u.pathname}`);
} catch(_) {
  console.log('[db] DATABASE_URL is missing or not a valid URL:', DB_URL ? DB_URL.slice(0, 30) : '(empty)');
}

const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
});

const PASSWORD          = process.env.APP_PASSWORD     || 'Rose2024!';
const SECRET            = process.env.SESSION_SECRET   || 'rose-tracker-secret-change-me';
const SHEETS_SCRIPT_URL = process.env.SHEETS_SCRIPT_URL || '';

const SERVICE_OPTS = [
  'Driveway Cleaning', 'House Washing', 'Roof Cleaning', 'Fence Cleaning',
  'Concrete Cleaning', 'Patio / Pool Deck', 'Commercial Pressure Washing',
  'Gutter Brightening', 'Bundle / Multiple Services', 'Other',
];

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser(SECRET));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth helpers ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.signedCookies.authed === '1') return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/me', (req, res) => {
  res.json({ authed: req.signedCookies.authed === '1' });
});

app.post('/api/login', (req, res) => {
  if (req.body.password === PASSWORD) {
    res.cookie('authed', '1', {
      signed:   true,
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      sameSite: 'lax',
      secure:   process.env.NODE_ENV === 'production',
    });
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('authed');
  res.json({ ok: true });
});

// ── Data ─────────────────────────────────────────────────────────────────────
app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM store WHERE id = 1');
    res.json(rows[0]?.data || {});
  } catch (err) {
    console.error('[data/get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/data', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE store SET data = $1, updated_at = NOW() WHERE id = 1',
      [req.body],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[data/post]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Google Sheets sync ───────────────────────────────────────────────────────
async function syncSheetLeads() {
  if (!SHEETS_SCRIPT_URL) return { added: 0, note: 'SHEETS_SCRIPT_URL not set' };
  try {
    const resp = await fetch(SHEETS_SCRIPT_URL);
    if (!resp.ok) throw new Error('Sheets request failed — HTTP ' + resp.status);
    const rows = await resp.json();
    if (!Array.isArray(rows)) throw new Error('Unexpected response from Apps Script');

    const { rows: dbRows } = await pool.query('SELECT data FROM store WHERE id = 1');
    const appData = dbRows[0]?.data || {};
    if (!appData.leads) appData.leads = [];

    let added = 0;
    for (const row of rows) {
      const ts = row['Timestamp'] ? String(row['Timestamp']) : '';
      if (!ts || appData.leads.some(l => l.sheetTimestamp === ts)) continue;

      // Map free-text service → SERVICE_OPTS values
      const rawSvc = String(row['Service Type'] || '');
      const parts  = rawSvc.split(/[,;\/]+/).map(s => s.trim()).filter(Boolean);
      const services = [];
      for (const part of parts) {
        const match = SERVICE_OPTS.find(opt =>
          opt.toLowerCase() === part.toLowerCase() ||
          part.toLowerCase().includes(opt.toLowerCase().split(' ')[0]),
        );
        if (match && !services.includes(match)) services.push(match);
        else if (!match && part && !services.includes(part)) services.push(part);
      }
      if (!services.length && rawSvc) services.push(rawSvc);

      let dateStr = '';
      try {
        const d = new Date(ts);
        if (!isNaN(d)) {
          dateStr = d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
        }
      } catch (_) {}

      const noteParts = [];
      if (row['Address']) noteParts.push('Address: ' + row['Address']);
      if (row['Details']) noteParts.push(row['Details']);

      appData.leads.push({
        id:               Date.now().toString(36) + Math.random().toString(36).slice(2),
        name:             String(row['Name']  || '').trim(),
        phone:            String(row['Phone'] || '').trim(),
        leadSource:       'Website Form',
        serviceInterested: services,
        quoteAmount:      0,
        dateContacted:    dateStr,
        followUpDate:     '',
        status:           'New',
        notes:            noteParts.join('\n'),
        sheetTimestamp:   ts,
        convertedCustomerId: null,
      });
      added++;
    }

    if (added > 0) {
      await pool.query(
        'UPDATE store SET data = $1, updated_at = NOW() WHERE id = 1',
        [appData],
      );
      console.log(`[sheets-sync] ${added} new leads added`);
    }
    return { added };
  } catch (err) {
    console.error('[sheets-sync error]', err.message);
    return { added: 0, error: err.message };
  }
}

app.post('/api/sync', requireAuth, async (req, res) => {
  const result = await syncSheetLeads();
  res.json(result);
});

// ── Cron: pull sheet every 5 minutes ─────────────────────────────────────────
if (SHEETS_SCRIPT_URL) {
  cron.schedule('*/5 * * * *', () => syncSheetLeads().catch(console.error));
  console.log('[sheets-sync] Auto-sync every 5 minutes');
}

// ── DB bootstrap (with retry) ─────────────────────────────────────────────────
async function initDB(retries = 5, delayMs = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS store (
          id         INTEGER PRIMARY KEY DEFAULT 1,
          data       JSONB   NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO store (id, data) VALUES (1, '{}'::jsonb)
        ON CONFLICT DO NOTHING;
      `);
      console.log('[db] Store table ready');
      return;
    } catch (err) {
      console.error(`[db] Attempt ${i}/${retries} failed: ${err.message}`);
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start — listen first so Railway health check always gets a response ────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);

  if (!process.env.DATABASE_URL) {
    console.error('[db] WARNING: DATABASE_URL is not set — data endpoints will fail.');
    console.error('[db] Add a PostgreSQL database in your Railway project and redeploy.');
    return;
  }

  initDB()
    .then(() => {
      if (SHEETS_SCRIPT_URL) syncSheetLeads();
    })
    .catch(err => {
      console.error('[db] Init failed after retries:', err.message);
    });
});
