// Database layer — Postgres via `pg`. The schema is created on first boot and
// kept current by a versioned, idempotent migration, so a fresh database needs
// nothing but a DATABASE_URL.
require('dotenv').config();
const crypto = require('node:crypto');
const { Pool } = require('pg');

// The connection string: DATABASE_URL, or whatever a hosting integration
// named it (Vercel's Neon/Postgres add-ons use POSTGRES_URL or <PREFIX>_URL).
function connectionString() {
  const env = process.env;
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'STORAGE_URL', 'NEON_DATABASE_URL', 'POSTGRES_PRISMA_URL'])
    if (env[k] && /^postgres/i.test(env[k])) return env[k];
  const any = Object.keys(env).find(k => /_URL$/.test(k) && /^postgres(ql)?:\/\//i.test(env[k] || ''));
  return any ? env[any] : '';
}
const DATABASE_URL = connectionString();
if (!DATABASE_URL) {
  console.error('\nMissing DATABASE_URL. Copy .env.example to .env and fill in your Postgres connection string.\n');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
  max: 3, // serverless-friendly
});

async function q(text, params = []) { return (await pool.query(text, params)).rows; }
async function one(text, params = []) { return (await q(text, params))[0] ?? null; }

// ---- settings (key/value), cached per process for a few seconds ----
let settingsCache = null, settingsCacheAt = 0;
async function loadSettings() {
  if (settingsCache && Date.now() - settingsCacheAt < 10 * 1000) return settingsCache;
  settingsCache = Object.fromEntries((await q('SELECT key, value FROM settings')).map(r => [r.key, r.value]));
  settingsCacheAt = Date.now();
  return settingsCache;
}
function clearSettingsCache() { settingsCache = null; }
async function getSetting(key, fallback = '') { const s = await loadSettings(); return s[key] !== undefined ? s[key] : fallback; }
async function getAllSettings() { return { ...(await loadSettings()) }; }
async function setSetting(key, value) {
  await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(value)]);
  clearSettingsCache();
}

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Everyone who signs things off. Managers with a phone number can post by text.
CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','manager')),
  pin TEXT NOT NULL DEFAULT '',              -- optional: required to sign as this person
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Recurring goal definitions, copied onto each new day the board is opened.
CREATE TABLE IF NOT EXISTS goal_templates (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'count' CHECK (unit IN ('count','dollars')),
  target NUMERIC(12,2) NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- One row per goal per day; progress is the sum of its entries.
CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL,                        -- YYYY-MM-DD in the business timezone
  template_id INTEGER REFERENCES goal_templates(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'count' CHECK (unit IN ('count','dollars')),
  target NUMERIC(12,2) NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',     -- template | manual | sms
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS goals_day_tpl_idx ON goals (date, template_id) WHERE template_id IS NOT NULL;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS baseline NUMERIC(12,2);   -- e.g. last year's number the target was built from
-- Imported per-day targets for a recurring goal (e.g. last year's daily revenue
-- + 5%). When a day is materialized, its row here overrides the template target.
CREATE TABLE IF NOT EXISTS goal_schedule (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES goal_templates(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  target NUMERIC(12,2) NOT NULL,
  baseline NUMERIC(12,2),
  UNIQUE (template_id, date)
);
CREATE TABLE IF NOT EXISTS goal_entries (
  id SERIAL PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  staff_name TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',        -- PNG data URL (drawn) or the typed name
  signature_kind TEXT NOT NULL DEFAULT 'typed',
  note TEXT NOT NULL DEFAULT '',
  signed_ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('daily','weekly','once')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  day_of_week INTEGER,                       -- weekly: due weekday (0=Sun..6=Sat), NULL = any day
  due_date TEXT,                             -- once: the day it belongs to
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',     -- manual | sms
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Who does a task: 'anyone' = one sign-off by whoever did it; 'each' = every
-- person in assignees (JSON array of staff ids; empty = everyone active) signs
-- off separately, and the task is done when they all have.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assign TEXT NOT NULL DEFAULT 'anyone';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignees TEXT NOT NULL DEFAULT '[]';
-- period = the day (daily/once) or the week's Monday (weekly) the sign-off covers.
CREATE TABLE IF NOT EXISTS task_completions (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  staff_name TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  signature_kind TEXT NOT NULL DEFAULT 'typed',
  note TEXT NOT NULL DEFAULT '',
  signed_ip TEXT NOT NULL DEFAULT '',
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- v4: one sign-off per person per period (per-person tasks); 'anyone' tasks
-- enforce their single sign-off in the API instead of here.
ALTER TABLE task_completions DROP CONSTRAINT IF EXISTS task_completions_task_id_period_key;
CREATE UNIQUE INDEX IF NOT EXISTS task_completions_person_idx ON task_completions (task_id, period, LOWER(staff_name));
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  media_url TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  expires_on TEXT,                           -- hidden from the board after this day
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS announcement_acks (
  id SERIAL PRIMARY KEY,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  staff_name TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  signature_kind TEXT NOT NULL DEFAULT 'typed',
  signed_ip TEXT NOT NULL DEFAULT '',
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ack_once_idx ON announcement_acks (announcement_id, LOWER(staff_name));
-- Every inbound text, whatever became of it.
CREATE TABLE IF NOT EXISTS sms_log (
  id SERIAL PRIMARY KEY,
  from_phone TEXT NOT NULL DEFAULT '',
  staff_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  media_url TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',           -- announcement | task-once | task-daily | task-weekly | goal | help | rejected
  target_id INTEGER,
  reply TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- On Supabase, tables are also reachable through its auto-generated REST API.
-- Row Level Security with no policies = deny-all there; this app connects as
-- the table owner, which bypasses RLS, so nothing changes for it.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['settings','staff','goal_templates','goals','goal_entries','tasks',
    'task_completions','announcements','announcement_acks','sms_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
`;

// Bump when DDL or defaults change; a mismatch replays the (idempotent) migration.
const SCHEMA_VERSION = '4';

async function ensureDefaults() {
  const setDefault = (k, v) => q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  await setDefault('business_name', 'Daily Board');
  await setDefault('timezone', 'America/Denver');
  // Branding (Manager panel -> Branding)
  await setDefault('tagline', '');
  await setDefault('welcome_text', '');
  await setDefault('theme_color', '#1f6feb');   // accent: buttons, highlights
  await setDefault('theme_topbar', '#111827');  // the bar across the top
  await setDefault('theme_bg', '#f4f6f9');      // page background
  await setDefault('font', 'system');
  await setDefault('logo_url', '');
  await setDefault('logo_data', '');            // uploaded logo as a data URL
  await setDefault('manager_pin', '1234');    // change it in Manager panel -> Settings!
  await setDefault('board_pass', '');         // blank = only managers can open the board
  await setDefault('sms_number', '');
  await setDefault('sms_default_kind', 'announcement');
  await setDefault('sms_reply', '1');
  await setDefault('sms_notify', '1');
  await setDefault('sms_broadcast', '0');        // text every announcement to the whole roster           // text people when a per-person task is created for them            // text a confirmation back to the manager (off = inbound-only, no carrier registration needed)
  await setDefault('token_secret', crypto.randomBytes(32).toString('hex')); // signs login tokens
}

const ready = (async () => {
  let current = false;
  try {
    const r = await one("SELECT value FROM settings WHERE key = 'schema_version'");
    current = !!(r && r.value === SCHEMA_VERSION);
  } catch { /* first boot: no settings table yet */ }
  if (!current) {
    await pool.query(DDL);
    await ensureDefaults();
    await setSetting('schema_version', SCHEMA_VERSION);
  }
})();
// Don't crash the process on startup failure — requests get a clean 500 instead.
ready.catch(err => console.error('Database init failed:', err.message));

// Everything the pages need to draw themselves in the business's colors.
const FONTS = ['system', 'Inter', 'Roboto', 'Poppins', 'Nunito', 'Montserrat', 'Lora', 'Work Sans'];
async function branding() {
  const s = await loadSettings();
  return {
    business_name: s.business_name || 'Daily Board', tagline: s.tagline || '', welcome_text: s.welcome_text || '',
    theme_color: s.theme_color || '#1f6feb', theme_topbar: s.theme_topbar || '#111827', theme_bg: s.theme_bg || '#f4f6f9',
    font: FONTS.includes(s.font) ? s.font : 'system',
    logo: s.logo_data || s.logo_url || '', logo_url: s.logo_url || '', has_logo_upload: !!s.logo_data,
  };
}

module.exports = { q, one, pool, ready, getSetting, getAllSettings, setSetting, clearSettingsCache, branding, FONTS };
