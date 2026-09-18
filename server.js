// Daily Board server — Express + Postgres.
// Runs locally with `npm start` (.env required) and on Vercel via api/index.js.
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { q, one, ready } = db;

const app = express();
app.use(express.json({ limit: '2mb' })); // drawn signatures and uploaded logos are small PNGs

// Security headers on every response.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Wait for the schema before serving anything.
app.use(async (req, res, next) => {
  try { await ready; next(); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Database unavailable — check DATABASE_URL.' }); }
});

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' });
});
function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}`;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
}
// Constant-time comparison so password checks can't be timed.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Brute-force guard: 10 failed sign-ins from one IP locks that IP out for 10
// minutes. Per-instance memory — enough to make guessing impractical.
const authFails = new Map();
function tooManyFails(req) {
  const rec = authFails.get(clientIp(req));
  return rec && rec.count >= 10 && (Date.now() - rec.first) < 10 * 60 * 1000;
}
function recordFail(req) {
  const ip = clientIp(req), rec = authFails.get(ip);
  if (!rec || (Date.now() - rec.first) > 10 * 60 * 1000) authFails.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
  if (authFails.size > 5000) authFails.clear();
}

// ---------- sign-in tokens ----------
// Two roles: 'board' (the front-desk device, unlocked with the shared board
// password, valid 30 days) and 'manager' (the manager PIN, valid 12 hours).
// Tokens are HMAC-signed and carry a fingerprint of the password they were
// minted with, so changing a password signs everyone out.
const fingerprint = v => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
async function makeToken(role) {
  const secret = await db.getSetting('token_secret', '');
  const pw = await db.getSetting(role === 'manager' ? 'manager_pin' : 'board_pass', '');
  const payload = `${role}|${fingerprint(pw)}|${Date.now() + (role === 'manager' ? 12 : 24 * 30) * 3600 * 1000}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}
// The token's role, or null when missing / expired / forged / stale.
async function readToken(header) {
  try {
    const raw = Buffer.from(String(header || ''), 'base64url').toString();
    const i = raw.lastIndexOf('|');
    const payload = raw.slice(0, i), sig = raw.slice(i + 1);
    const [role, fp, exp] = payload.split('|');
    if (!['board', 'manager'].includes(role) || !(Number(exp) > Date.now())) return null;
    const want = crypto.createHmac('sha256', await db.getSetting('token_secret', '')).update(payload).digest('hex');
    if (!safeEqual(sig, want)) return null;
    const pw = await db.getSetting(role === 'manager' ? 'manager_pin' : 'board_pass', '');
    if (role === 'board' && !pw) return null; // board password removed = board access removed
    return fingerprint(pw) === fp ? role : null;
  } catch { return null; }
}
async function roleOf(req) { return readToken(req.headers['x-token']); }

function boardAuth(req, res, next) {
  roleOf(req).then(role => {
    if (!role) return res.status(401).json({ error: 'Please sign in.' });
    req.role = role; next();
  }).catch(() => res.status(500).json({ error: 'Database unavailable.' }));
}
function managerOnly(req, res, next) {
  roleOf(req).then(role => {
    if (role !== 'manager') return res.status(401).json({ error: 'Manager sign-in required.' });
    req.role = role; next();
  }).catch(() => res.status(500).json({ error: 'Database unavailable.' }));
}

// Public branding for the sign-in screen.
app.get('/api/config', wrap(async (req, res) => {
  res.json({ ...(await db.branding()), sms_number: await db.getSetting('sms_number', ''), board_pass_set: !!(await db.getSetting('board_pass', '')).trim() });
}));

// Sign in with either the board password or the manager PIN.
app.post('/api/login', wrap(async (req, res) => {
  if (tooManyFails(req)) return res.status(429).json({ error: 'Too many failed attempts — try again in 10 minutes.' });
  const b = req.body || {};
  if (b.manager_pin != null) {
    const pin = await db.getSetting('manager_pin', '');
    if (pin && safeEqual(String(b.manager_pin).trim(), pin)) return res.json({ ok: true, role: 'manager', token: await makeToken('manager') });
    recordFail(req);
    return res.status(401).json({ error: 'Wrong manager PIN.' });
  }
  const pass = (await db.getSetting('board_pass', '')).trim();
  if (!pass) return res.status(401).json({ error: 'No board password is set yet — a manager can sign in with the PIN and set one under Settings.' });
  if (safeEqual(String(b.board_pass || '').trim(), pass)) return res.json({ ok: true, role: 'board', token: await makeToken('board') });
  recordFail(req);
  res.status(401).json({ error: 'Wrong board password.' });
}));

// Everything else — the board, the manager panel, and inbound texts.
require('./board')(app, { q, one, db, wrap, boardAuth, managerOnly, makeToken, safeEqual, recordFail, clientIp, baseUrl });

const PORT = process.env.PORT || 3000;
module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Daily Board running at http://localhost:${PORT}`));
}
