'use strict';
const express      = require('express');
const { Pool }     = require('pg');
const cookieParser = require('cookie-parser');
const cron         = require('node-cron');
const path         = require('path');

const app = express();

const PASSWORD          = process.env.APP_PASSWORD     || 'Rose2024!';
const SECRET            = process.env.SESSION_SECRET   || 'rose-tracker-secret-change-me';
const SHEETS_SCRIPT_URL = process.env.SHEETS_SCRIPT_URL || '';
const PORT              = process.env.PORT || 3000;

// ── DB connection config ──────────────────────────────────────────────────────
// Prefer individual PG* vars (always work on Railway without private networking).
// Fall back to DATABASE_URL if PG* vars aren't present.
const DB_URL  = (process.env.DATABASE_URL || '').trim();
const PGHOST  = (process.env.PGHOST       || '').trim();
const PGPORT  = (process.env.PGPORT       || '5432').trim();
const PGDB    = (process.env.PGDATABASE   || 'railway').trim();
const PGUSER  = (process.env.PGUSER       || 'postgres').trim();
const PGPASS  = (process.env.PGPASSWORD   || '').trim();

// ── Startup diagnostics ───────────────────────────────────────────────────────
console.log('=== STARTUP ===');
console.log('NODE_ENV    :', process.env.NODE_ENV || '(not set)');
console.log('PORT        :', process.env.PORT     || '3000');
console.log('DATABASE_URL:', DB_URL ? DB_URL.replace(/:([^:@]+)@/, ':***@') : '(not set)');
console.log('PGHOST      :', PGHOST  || '(not set)');
console.log('PGPORT      :', PGPORT);
console.log('PGDATABASE  :', PGDB    || '(not set)');
console.log('PGUSER      :', PGUSER  || '(not set)');
console.log('PGPASSWORD  :', PGPASS  ? '(set)' : '(not set)');
console.log('===============');

let dbHost  = '(not set)';
let dbReady = false;
let poolConfig;

if (PGHOST) {
  // ── Method 1: individual PG* vars (recommended on Railway) ──────────────────
  poolConfig = {
    host:     PGHOST,
    port:     parseInt(PGPORT, 10),
    database: PGDB,
    user:     PGUSER,
    password: PGPASS,
    ssl:      { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis:       30000,
  };
  dbHost = `${PGHOST}:${PGPORT}`;
  console.log('[db] Using individual PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD');
  console.log('[db] Host:', dbHost);
} else if (DB_URL && !DB_URL.includes('{{')) {
  // ── Method 2: DATABASE_URL connection string ─────────────────────────────────
  poolConfig = {
    connectionString: DB_URL,
    ssl:      { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis:       30000,
  };
  try { const u = new URL(DB_URL); dbHost = `${u.hostname}:${u.port}`; } catch (_) {}
  console.log('[db] Using DATABASE_URL, host:', dbHost);
} else {
  console.error('[db] ERROR: No database credentials found.');
  console.error('[db] In Railway → web service → Variables, add:');
  console.error('[db]   PGHOST=${{Postgres.PGHOST}}');
  console.error('[db]   PGPORT=${{Postgres.PGPORT}}');
  console.error('[db]   PGDATABASE=${{Postgres.PGDATABASE}}');
  console.error('[db]   PGUSER=${{Postgres.PGUSER}}');
  console.error('[db]   PGPASSWORD=${{Postgres.PGPASSWORD}}');
}

let pool = null;
if (poolConfig) {
  pool = new Pool(poolConfig);
  pool.on('error', err => console.error('[db] Pool error:', err.message));
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser(SECRET));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check (public — no auth) ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    dbHost,
    dbReady,
    dbUrlSet: !!DB_URL && !DB_URL.includes('{{'),
    port: PORT,
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/me', (req, res) => {
  res.json({ authed: req.signedCookies.authed === '1' });
});

app.post('/api/login', (req, res) => {
  if (req.body.password === PASSWORD) {
    res.cookie('authed', '1', {
      signed:   true,
      maxAge:   30 * 24 * 60 * 60 * 1000,
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

// ── Guard for routes that need DB ─────────────────────────────────────────────
function requireDB(req, res, next) {
  if (!pool || !dbReady) {
    return res.status(503).json({ error: 'Database not ready. Check DATABASE_URL in Railway variables.' });
  }
  next();
}

// ── Data ──────────────────────────────────────────────────────────────────────
app.get('/api/data', requireAuth, requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM store WHERE id = 1');
    res.json(rows[0]?.data || {});
  } catch (err) {
    console.error('[data/get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/data', requireAuth, requireDB, async (req, res) => {
  try {
    await pool.query('UPDATE store SET data = $1, updated_at = NOW() WHERE id = 1', [req.body]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[data/post]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Google Sheets sync ────────────────────────────────────────────────────────
const SERVICE_OPTS = [
  'Driveway Cleaning', 'House Washing', 'Roof Cleaning', 'Fence Cleaning',
  'Concrete Cleaning', 'Patio / Pool Deck', 'Commercial Pressure Washing',
  'Gutter Brightening', 'Bundle / Multiple Services', 'Other',
];

async function syncSheetLeads() {
  if (!SHEETS_SCRIPT_URL) return { added: 0, note: 'SHEETS_SCRIPT_URL not set' };
  if (!pool || !dbReady)  return { added: 0, note: 'DB not ready' };
  try {
    const resp = await fetch(SHEETS_SCRIPT_URL);
    if (!resp.ok) throw new Error('Sheets HTTP ' + resp.status);
    const rows = await resp.json();
    if (!Array.isArray(rows)) throw new Error('Unexpected response from Apps Script');

    const { rows: dbRows } = await pool.query('SELECT data FROM store WHERE id = 1');
    const appData = dbRows[0]?.data || {};
    if (!appData.leads) appData.leads = [];

    let added = 0;
    for (const row of rows) {
      const ts = row['Timestamp'] ? String(row['Timestamp']) : '';
      if (!ts || appData.leads.some(l => l.sheetTimestamp === ts)) continue;

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
        if (!isNaN(d)) dateStr = d.getFullYear() + '-' +
          String(d.getMonth()+1).padStart(2,'0') + '-' +
          String(d.getDate()).padStart(2,'0');
      } catch (_) {}

      const noteParts = [];
      if (row['Address']) noteParts.push('Address: ' + row['Address']);
      if (row['Details']) noteParts.push(row['Details']);

      appData.leads.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        name: String(row['Name'] || '').trim(),
        phone: String(row['Phone'] || '').trim(),
        leadSource: 'Website Form',
        serviceInterested: services,
        quoteAmount: 0,
        dateContacted: dateStr,
        followUpDate: '',
        status: 'New',
        notes: noteParts.join('\n'),
        sheetTimestamp: ts,
        convertedCustomerId: null,
      });
      added++;
    }

    if (added > 0) {
      await pool.query('UPDATE store SET data = $1, updated_at = NOW() WHERE id = 1', [appData]);
      console.log(`[sheets-sync] ${added} new leads added`);
    }
    return { added };
  } catch (err) {
    console.error('[sheets-sync error]', err.message);
    return { added: 0, error: err.message };
  }
}

app.post('/api/sync', requireAuth, async (req, res) => {
  res.json(await syncSheetLeads());
});

if (SHEETS_SCRIPT_URL) {
  cron.schedule('*/5 * * * *', () => syncSheetLeads().catch(console.error));
  console.log('[sheets-sync] Auto-sync every 5 minutes');
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────
async function initDB() {
  if (!pool) return;
  for (let i = 1; i <= 5; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS store (
          id         INTEGER PRIMARY KEY DEFAULT 1,
          data       JSONB   NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO store (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT DO NOTHING;
      `);
      dbReady = true;
      console.log('[db] Store table ready');
      return;
    } catch (err) {
      console.error(`[db] Attempt ${i}/5: ${err.message}`);
      if (i < 5) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('[db] All connection attempts failed. Check DATABASE_URL.');
}

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start — bind port first, connect DB in background ────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  initDB();
});
