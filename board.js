// The board itself: daily sales goals, daily / weekly / one-off tasks, and
// announcements, each signed off by an employee (drawn or typed signature)
// so every check-off records who did it and when. Managers can also post by
// text message — the SMS provider (Twilio) POSTs each inbound text to
// /api/sms/inbound and the message's first word decides where it lands.
//
// Mounted by server.js:  require('./board')(app, deps)
const crypto = require('crypto');
const express = require('express');

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_MATCH = [/^sun/, /^mon/, /^tue/, /^wed/, /^thu/, /^fri/, /^sat/];

// ---------- dates (all in the business timezone, as YYYY-MM-DD strings) ----------
function isDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')); }
function dowOf(dateStr) { return new Date(dateStr + 'T00:00:00Z').getUTCDay(); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// The board's week runs Monday–Sunday; weekly tasks are signed once per week.
function weekStart(dateStr) { return addDays(dateStr, -((dowOf(dateStr) + 6) % 7)); }
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
function localToday(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: validTz(tz) ? tz : 'UTC' }).format(new Date());
}

// ---------- the text-message grammar ----------
// First word (case-insensitive, optional ':' / '-' / '#') picks the destination:
//   ANNOUNCE <text>              announcement (also the default with no keyword)
//   TASK <text>                  one-off task on today's board
//   DAILY <text>                 recurring daily task
//   WEEKLY [Mon..Sun] <text>     recurring weekly task, optionally due a weekday
//   GOAL <label> <number>        set/replace today's target ("GOAL memberships 5", "GOAL revenue $1200")
//   HELP                         reply with this list
// Returns { action, text, kind?, dow?, label?, target?, unit? } — action 'help' or 'error' otherwise.
function parseSms(raw, defaultKind = 'announcement') {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return { action: 'help' };
  const m = s.match(/^#?([a-z]+)\s*[:\-–—]?\s*(.*)$/i);
  const word = m ? m[1].toLowerCase() : '';
  const rest = m ? m[2].trim() : s;
  if (['help', 'commands', 'menu'].includes(word) || s === '?') return { action: 'help' };
  if (['announce', 'announcement', 'ann', 'news', 'notice'].includes(word))
    return rest ? { action: 'announcement', text: rest } : { action: 'error', text: 'Nothing to post after ANNOUNCE.' };
  if (['task', 'todo', 'do'].includes(word)) {
    const sub = rest.match(/^(daily|weekly)\b\s*[:\-]?\s*(.*)$/i);
    if (sub) return parseSms(`${sub[1]} ${sub[2]}`, defaultKind);
    return rest ? { action: 'task', kind: 'once', text: rest } : { action: 'error', text: 'Nothing to post after TASK.' };
  }
  if (['daily', 'everyday'].includes(word))
    return rest ? { action: 'task', kind: 'daily', text: rest } : { action: 'error', text: 'Nothing to post after DAILY.' };
  if (['weekly', 'week'].includes(word)) {
    const dm = rest.match(/^([a-z]+)\b\s*[:\-]?\s*(.*)$/i);
    let dow = null, text = rest;
    if (dm) {
      const i = DOW_MATCH.findIndex(rx => rx.test(dm[1].toLowerCase()));
      if (i >= 0 && dm[1].length >= 3) { dow = i; text = dm[2].trim(); }
    }
    return text ? { action: 'task', kind: 'weekly', dow, text } : { action: 'error', text: 'Nothing to post after WEEKLY.' };
  }
  if (['goal', 'target'].includes(word)) {
    const nm = rest.match(/(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(\$|dollars?|bucks)?/i);
    if (!nm) return { action: 'error', text: 'GOAL needs a number, e.g. "GOAL memberships 5" or "GOAL revenue $1200".' };
    const target = Number(nm[2].replace(/,/g, ''));
    const label = (rest.slice(0, nm.index) + ' ' + rest.slice(nm.index + nm[0].length)).replace(/\s+/g, ' ').trim()
      .replace(/^[:\-–—]\s*|\s*[:\-–—]$/g, '');
    if (!label) return { action: 'error', text: 'GOAL needs a name too, e.g. "GOAL memberships 5".' };
    const unit = (nm[1] || nm[3] || /revenue|sales|dollar|\$/i.test(label)) ? 'dollars' : 'count';
    return { action: 'goal', label, target, unit };
  }
  // No keyword: the whole message goes wherever the board is set to default.
  return defaultKind === 'task' ? { action: 'task', kind: 'once', text: s } : { action: 'announcement', text: s };
}

const HELP_TEXT = 'Board commands — start your text with one:\n' +
  'ANNOUNCE <message>\nTASK <message> (today)\nDAILY <message>\nWEEKLY [Mon..Sun] <message>\n' +
  'GOAL <name> <number> (e.g. GOAL memberships 5)\nNo keyword = announcement. Attach a photo to include it.';

// ---------- goal schedule import ----------
// Turns pasted/uploaded text (CSV from a POS export, a spreadsheet, or just
// "9/17/2025  $1,450" lines) into [{date, amount}]. Each line needs one
// date-looking cell and a number after it; other lines (headers, totals) are
// skipped and counted.
function parseDateCell(s) {
  s = String(s || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return mkDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))) return mkDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  if ((m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/)) || (m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{4})$/))) {
    const [mon, day, year] = /^[A-Za-z]/.test(s) ? [m[1], m[2], m[3]] : [m[2], m[1], m[3]];
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(mon.slice(0, 3).toLowerCase());
    if (mi >= 0) return mkDate(+year, mi + 1, +day);
  }
  return null;
}
function mkDate(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}
function parseAmountCell(s) {
  s = String(s || '').trim().replace(/^["']|["']$/g, '');
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()$,\s]/g, ''));
  return s !== '' && Number.isFinite(n) ? (neg ? -n : n) : null;
}
function splitCells(line) {
  const cells = []; let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === ',' || ch === '\t' || ch === ';' || ch === '|')) { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  // Columns pasted from a spreadsheet or a fixed-width report are separated by
  // runs of spaces; a lone "9/17/2025 1450" line splits before its number.
  let parts = cells.flatMap(c => c.trim().split(/\s{2,}/));
  if (parts.length === 1) parts = line.trim().split(/\s+(?=[$(\d])/);
  // an unquoted "$5,000" was cut at its own comma — glue thousands groups back together
  const out = [];
  for (const c of parts) {
    const prev = out[out.length - 1];
    if (prev != null && /^\(?-?\$?\d{1,3}(,\d{3})*$/.test(prev.trim()) && /^\d{3}(\.\d+)?\)?$/.test(c.trim())) out[out.length - 1] = prev.trim() + ',' + c.trim();
    else out.push(c);
  }
  return out;
}
function parseSchedule(text) {
  const rows = [], seen = new Map(); let skipped = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = splitCells(line);
    let date = null, amount = null;
    for (let i = 0; i < cells.length && amount == null; i++) {
      if (!date) {
        // "Sep 19, 2025" / "Sep 19 2025" can arrive split across two or three cells
        for (let span = 1; span <= 3 && i + span <= cells.length; span++) {
          date = parseDateCell(cells.slice(i, i + span).join(' '));
          if (date) { i += span - 1; break; }
        }
        continue;
      }
      amount = parseAmountCell(cells[i]);
    }
    if (!date || amount == null) { skipped++; continue; }
    if (seen.has(date)) rows[seen.get(date)].amount = amount; // a later duplicate wins
    else { seen.set(date, rows.length); rows.push({ date, amount }); }
  }
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  return { rows, skipped };
}
// Move last year's dates onto this year: same calendar date (+1 year, Feb 29 -> Feb 28)
// or the same weekday (+52 weeks), or leave them alone.
function shiftDate(dateStr, mode) {
  if (mode === '52w') return addDays(dateStr, 364);
  if (mode === 'year') {
    const [y, m, d] = dateStr.split('-').map(Number);
    return mkDate(y + 1, m, d) || mkDate(y + 1, m, d - 1);
  }
  return dateStr;
}

// Phone numbers compare by their last 10 digits ("(208) 555-0100", "+12085550100", "208.555.0100" all match).
function phoneKey(s) { const d = String(s || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }

function xmlEsc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

// Twilio signs every webhook: base64(HMAC-SHA1(authToken, url + sorted POST params)).
function twilioSignatureValid(token, url, params, header) {
  const data = url + Object.keys(params || {}).sort().map(k => k + params[k]).join('');
  const want = crypto.createHmac('sha1', token).update(data).digest('base64');
  const got = String(header || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function mount(app, deps) {
  const { q, one, db, wrap, boardAuth, managerOnly, makeToken, safeEqual, recordFail, clientIp, baseUrl } = deps;

  const today = async () => localToday(await db.getSetting('timezone', 'UTC'));
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clean = (v, max = 4000) => String(v ?? '').trim().slice(0, max);
  const isOff = v => v === false || v === 0 || v === '0';

  // Copy every active goal template onto this day (today or later only — never
  // invent history for a past day that had no goals).
  async function materializeGoals(date, todayStr) {
    if (date < todayStr) return;
    const sched = await q('SELECT template_id, target, baseline FROM goal_schedule WHERE date = $1', [date]);
    for (const t of await q('SELECT * FROM goal_templates WHERE active = 1 ORDER BY sort, id')) {
      const s = sched.find(x => x.template_id === t.id);
      await q(`INSERT INTO goals (date, template_id, label, unit, target, baseline, sort, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (date, template_id) WHERE template_id IS NOT NULL DO NOTHING`,
        [date, t.id, t.label, t.unit, s ? s.target : t.target, s ? s.baseline : null, t.sort, s ? 'schedule' : 'template']);
    }
  }

  async function boardData(date) {
    const todayStr = await today();
    const ws = weekStart(date), dow = dowOf(date);
    await materializeGoals(date, todayStr);
    const [goals, entries, staff, tasks, completions, anns, acks, settings] = await Promise.all([
      q('SELECT * FROM goals WHERE date = $1 ORDER BY sort, id', [date]),
      q(`SELECT e.goal_id, e.amount, e.staff_name, e.note, e.created_at FROM goal_entries e
         JOIN goals g ON g.id = e.goal_id WHERE g.date = $1 ORDER BY e.id`, [date]),
      q('SELECT id, name, role, pin FROM staff WHERE active = 1 ORDER BY name'),
      q(`SELECT * FROM tasks WHERE active = 1 AND (kind = 'daily' OR (kind = 'once' AND due_date = $1) OR kind = 'weekly')
         ORDER BY sort, id`, [date]),
      q('SELECT * FROM task_completions WHERE period IN ($1, $2)', [date, ws]),
      q(`SELECT * FROM announcements WHERE active = 1 AND (expires_on IS NULL OR expires_on >= $1)
         ORDER BY pinned DESC, id DESC LIMIT 50`, [date]),
      q(`SELECT a.announcement_id, a.staff_name, a.signed_at FROM announcement_acks a
         JOIN announcements n ON n.id = a.announcement_id WHERE n.active = 1 ORDER BY a.id`),
      db.getAllSettings(),
    ]);
    const brand = await db.branding();
    const byGoal = {};
    for (const e of entries) (byGoal[e.goal_id] = byGoal[e.goal_id] || []).push({ ...e, amount: Number(e.amount) });
    const doneBy = {};
    for (const c of completions) doneBy[`${c.task_id}|${c.period}`] = c;
    const pubDone = c => c ? { id: c.id, staff_id: c.staff_id, staff_name: c.staff_name, signed_at: c.signed_at,
      signature: c.signature, signature_kind: c.signature_kind, note: c.note } : null;
    const ackBy = {};
    for (const a of acks) (ackBy[a.announcement_id] = ackBy[a.announcement_id] || []).push({ staff_name: a.staff_name, signed_at: a.signed_at });
    const tasks_today = [], tasks_week = [];
    for (const t of tasks) {
      const period = t.kind === 'weekly' ? ws : date;
      const row = { id: t.id, kind: t.kind, title: t.title, detail: t.detail, day_of_week: t.day_of_week, due_date: t.due_date,
        source: t.source, created_by: t.created_by, period, completion: pubDone(doneBy[`${t.id}|${period}`]) };
      if (t.kind === 'weekly') { row.due_today = t.day_of_week === dow; tasks_week.push(row); }
      else tasks_today.push(row);
    }
    return {
      today: todayStr, date, week_start: ws, week_end: addDays(ws, 6), timezone: settings.timezone || 'UTC',
      ...brand,
      sms_number: settings.sms_number || '', board_pass_set: !!(settings.board_pass || '').trim(),
      staff: staff.map(s => ({ id: s.id, name: s.name, role: s.role, has_pin: !!s.pin })),
      goals: goals.map(g => ({ id: g.id, label: g.label, unit: g.unit, target: Number(g.target), baseline: g.baseline == null ? null : Number(g.baseline),
        actual: (byGoal[g.id] || []).reduce((s, e) => s + e.amount, 0), entries: byGoal[g.id] || [] })),
      tasks_today, tasks_week,
      announcements: anns.map(a => ({ id: a.id, title: a.title, body: a.body, media_url: a.media_url, pinned: !!a.pinned,
        expires_on: a.expires_on, source: a.source, created_by: a.created_by, created_at: a.created_at, acks: ackBy[a.id] || [] })),
    };
  }

  app.get('/api/board', boardAuth, wrap(async (req, res) => {
    const date = isDateStr(req.query.date) ? String(req.query.date) : await today();
    const data = await boardData(date);
    data.is_manager = req.role === 'manager';
    res.json(data);
  }));

  // Who is signing: a roster pick (with their PIN when they have one), or a
  // typed name while the roster is still empty. Returns {staff_id, staff_name} or an error string.
  async function resolveSigner(b) {
    const roster = await q('SELECT * FROM staff WHERE active = 1');
    if (b.staff_id) {
      const s = roster.find(r => r.id === Number(b.staff_id));
      if (!s) return 'Pick your name from the list.';
      if (s.pin && !safeEqual(String(b.pin || '').trim(), s.pin)) return 'Wrong PIN for ' + s.name + '.';
      return { staff_id: s.id, staff_name: s.name };
    }
    if (roster.length) return 'Pick your name from the list.';
    const name = clean(b.staff_name, 80);
    if (!name) return 'Enter your name.';
    return { staff_id: null, staff_name: name };
  }
  // A signature is a PNG drawn on the board (data URL) or a typed name.
  function readSignature(b) {
    const sig = String(b.signature || '').trim();
    if (!sig) return null;
    if (sig.startsWith('data:image/png;base64,')) return sig.length <= 400000 ? { signature: sig, signature_kind: 'drawn' } : null;
    if (/^data:/i.test(sig)) return null;
    return { signature: sig.slice(0, 120), signature_kind: 'typed' };
  }

  // Sign off a task, acknowledge an announcement, or log progress toward a goal.
  app.post('/api/board/sign', boardAuth, wrap(async (req, res) => {
    const b = req.body || {};
    const todayStr = await today();
    const date = isDateStr(b.date) ? String(b.date) : todayStr;
    if (date > todayStr) return res.status(400).json({ error: "You can't sign off a future day." });
    const who = await resolveSigner(b);
    if (typeof who === 'string') { if (b.staff_id && b.pin) recordFail(req); return res.status(400).json({ error: who }); }
    const sig = readSignature(b);
    if (!sig) return res.status(400).json({ error: 'Add your signature (draw it or type your name).' });
    const ip = clientIp(req), note = clean(b.note, 500), id = Number(b.id);
    if (b.kind === 'task') {
      const t = await one('SELECT * FROM tasks WHERE id = $1 AND active = 1', [id]);
      if (!t) return res.status(404).json({ error: 'That task is no longer on the board.' });
      const period = t.kind === 'weekly' ? weekStart(date) : t.kind === 'once' ? t.due_date : date;
      try {
        const row = await one(`INSERT INTO task_completions (task_id, period, staff_id, staff_name, signature, signature_kind, note, signed_ip)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, signed_at`, [t.id, period, who.staff_id, who.staff_name, sig.signature, sig.signature_kind, note, ip]);
        return res.json({ ok: true, completion: { id: row.id, ...who, ...sig, note, signed_at: row.signed_at } });
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Someone already signed this off — refresh the board.' });
        throw e;
      }
    }
    if (b.kind === 'announcement') {
      const a = await one('SELECT id FROM announcements WHERE id = $1 AND active = 1', [id]);
      if (!a) return res.status(404).json({ error: 'That announcement is gone.' });
      await q(`INSERT INTO announcement_acks (announcement_id, staff_id, staff_name, signature, signature_kind, signed_ip)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (announcement_id, LOWER(staff_name)) DO NOTHING`,
        [a.id, who.staff_id, who.staff_name, sig.signature, sig.signature_kind, ip]);
      return res.json({ ok: true });
    }
    if (b.kind === 'goal') {
      const g = await one('SELECT * FROM goals WHERE id = $1', [id]);
      if (!g) return res.status(404).json({ error: 'That goal is gone.' });
      const amount = Math.round(num(b.amount) * 100) / 100;
      if (!amount) return res.status(400).json({ error: 'Enter how much to add (a whole number or dollar amount).' });
      if (Math.abs(amount) > 1e9) return res.status(400).json({ error: 'That amount is too large.' });
      await q(`INSERT INTO goal_entries (goal_id, amount, staff_id, staff_name, signature, signature_kind, note, signed_ip)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [g.id, amount, who.staff_id, who.staff_name, sig.signature, sig.signature_kind, note, ip]);
      const sum = await one('SELECT COALESCE(SUM(amount),0)::float AS actual FROM goal_entries WHERE goal_id = $1', [g.id]);
      return res.json({ ok: true, actual: sum.actual });
    }
    res.status(400).json({ error: 'Unknown sign-off kind.' });
  }));

  // Undo a task sign-off: the person who signed it (with their PIN if they have one) or a manager.
  app.post('/api/board/unsign', boardAuth, wrap(async (req, res) => {
    const b = req.body || {};
    const c = await one('SELECT * FROM task_completions WHERE id = $1', [Number(b.completion_id)]);
    if (!c) return res.json({ ok: true });
    if (req.role !== 'manager') {
      const s = c.staff_id ? await one('SELECT * FROM staff WHERE id = $1', [c.staff_id]) : null;
      if (!s || Number(b.staff_id) !== s.id) return res.status(403).json({ error: `Only ${c.staff_name} or a manager can clear this sign-off.` });
      if (s.pin && !safeEqual(String(b.pin || '').trim(), s.pin)) { recordFail(req); return res.status(403).json({ error: 'Wrong PIN.' }); }
    }
    await q('DELETE FROM task_completions WHERE id = $1', [c.id]);
    res.json({ ok: true });
  }));

  // ---------- manager panel ----------
  app.get('/api/manager/overview', managerOnly, wrap(async (req, res) => {
    const todayStr = await today();
    const [staff, goal_templates, goals, goal_schedule, tasks, announcements, sms_log, completions, entries] = await Promise.all([
      q('SELECT id, name, phone, role, active, created_at, (pin <> \'\') AS has_pin FROM staff ORDER BY active DESC, name'),
      q('SELECT * FROM goal_templates ORDER BY active DESC, sort, id'),
      q('SELECT * FROM goals WHERE date >= $1 ORDER BY date, sort, id', [addDays(todayStr, -1)]),
      q(`SELECT template_id, COUNT(*)::int AS days, MIN(date) AS from_date, MAX(date) AS to_date,
           COUNT(*) FILTER (WHERE date >= $1)::int AS days_ahead FROM goal_schedule GROUP BY template_id`, [todayStr]),
      q(`SELECT * FROM tasks WHERE active = 1 OR created_at > now() - interval '30 days' ORDER BY active DESC, kind, sort, id`),
      q(`SELECT * FROM announcements WHERE active = 1 OR created_at > now() - interval '30 days' ORDER BY active DESC, pinned DESC, id DESC`),
      q('SELECT * FROM sms_log ORDER BY id DESC LIMIT 100'),
      q(`SELECT c.id, c.task_id, t.title, t.kind, c.period, c.staff_name, c.signature_kind, c.note, c.signed_at
         FROM task_completions c JOIN tasks t ON t.id = c.task_id
         WHERE c.signed_at > now() - interval '30 days' ORDER BY c.signed_at DESC LIMIT 500`),
      q(`SELECT e.id, g.date, g.label, g.unit, e.amount::float AS amount, e.staff_name, e.note, e.created_at
         FROM goal_entries e JOIN goals g ON g.id = e.goal_id
         WHERE e.created_at > now() - interval '30 days' ORDER BY e.created_at DESC LIMIT 500`),
    ]);
    const s = await db.getAllSettings();
    res.json({
      today: todayStr, staff,
      goal_templates: goal_templates.map(t => ({ ...t, target: Number(t.target) })),
      goals: goals.map(g => ({ ...g, target: Number(g.target), baseline: g.baseline == null ? null : Number(g.baseline) })),
      goal_schedule, tasks, announcements, sms_log, completions, goal_entries: entries,
      branding: await db.branding(),
      settings: {
        timezone: s.timezone || '',
        board_pass: s.board_pass || '', manager_pin: s.manager_pin || '',
        sms_number: s.sms_number || '', sms_default_kind: s.sms_default_kind || 'announcement',
        sms_secured: !!(process.env.TWILIO_AUTH_TOKEN || process.env.SMS_WEBHOOK_SECRET),
      },
    });
  }));

  app.post('/api/manager/staff', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.remove) { await q('DELETE FROM staff WHERE id = $1', [Number(b.id)]); return res.json({ ok: true }); }
    const name = clean(b.name, 80);
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const role = b.role === 'manager' ? 'manager' : 'employee';
    const phone = clean(b.phone, 30), active = isOff(b.active) ? 0 : 1;
    if (b.pin != null && String(b.pin).trim() && !/^\d{4,8}$/.test(String(b.pin).trim()))
      return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
    if (b.id) {
      const cur = await one('SELECT * FROM staff WHERE id = $1', [Number(b.id)]);
      if (!cur) return res.status(404).json({ error: 'Not found.' });
      const pin = b.pin == null ? cur.pin : String(b.pin).trim(); // undefined = keep, '' = clear
      await q('UPDATE staff SET name=$2, phone=$3, role=$4, pin=$5, active=$6 WHERE id=$1', [cur.id, name, phone, role, pin, active]);
      return res.json({ ok: true, id: cur.id });
    }
    const row = await one('INSERT INTO staff (name, phone, role, pin, active) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, phone, role, String(b.pin || '').trim(), active]);
    res.json({ ok: true, id: row.id });
  }));

  app.post('/api/manager/goal-template', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.remove) { await q('DELETE FROM goal_templates WHERE id = $1', [Number(b.id)]); return res.json({ ok: true }); }
    const label = clean(b.label, 80);
    if (!label) return res.status(400).json({ error: 'Goal name is required.' });
    const unit = b.unit === 'dollars' ? 'dollars' : 'count';
    const target = Math.max(0, num(b.target)), sort = num(b.sort), active = isOff(b.active) ? 0 : 1;
    let id = Number(b.id) || 0;
    if (id) await q('UPDATE goal_templates SET label=$2, unit=$3, target=$4, sort=$5, active=$6 WHERE id=$1', [id, label, unit, target, sort, active]);
    else id = (await one('INSERT INTO goal_templates (label, unit, target, sort, active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [label, unit, target, sort, active])).id;
    // Today's copy follows the template right away (past days keep their history).
    const todayStr = await today();
    if (active) await q(`INSERT INTO goals (date, template_id, label, unit, target, sort, source) VALUES ($1,$2,$3,$4,$5,$6,'template')
      ON CONFLICT (date, template_id) WHERE template_id IS NOT NULL DO UPDATE SET label = EXCLUDED.label, unit = EXCLUDED.unit, target = EXCLUDED.target, sort = EXCLUDED.sort`,
      [todayStr, id, label, unit, target, sort]);
    else await q('DELETE FROM goals WHERE template_id = $1 AND date >= $2 AND NOT EXISTS (SELECT 1 FROM goal_entries e WHERE e.goal_id = goals.id)', [id, todayStr]);
    res.json({ ok: true, id });
  }));

  // Import a per-day target schedule for a recurring goal — typically last year's
  // daily numbers, shifted onto this year and bumped by a percentage. dry_run
  // returns what would be imported without writing anything.
  app.post('/api/manager/goal-schedule', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    const tpl = Number.isInteger(Number(b.template_id)) && Number(b.template_id) > 0 ? await one('SELECT * FROM goal_templates WHERE id = $1', [Number(b.template_id)]) : null;
    if (!tpl) return res.status(400).json({ error: 'Pick which goal this schedule is for.' });
    const todayStr = await today();
    if (b.clear) {
      await q('DELETE FROM goal_schedule WHERE template_id = $1', [tpl.id]);
      await q('UPDATE goals SET target = $2, baseline = NULL, source = $3 WHERE template_id = $1 AND date >= $4 AND source = $5',
        [tpl.id, tpl.target, 'template', todayStr, 'schedule']);
      return res.json({ ok: true });
    }
    const text = String(b.text || '');
    if (text.length > 2_000_000) return res.status(400).json({ error: 'That file is too large — trim it to the dates you need.' });
    const shift = ['none', 'year', '52w'].includes(b.shift) ? b.shift : 'none';
    const uplift = Math.max(-100, Math.min(1000, num(b.uplift)));
    const { rows, skipped } = parseSchedule(text);
    const out = rows.map(r => ({ date: shiftDate(r.date, shift), baseline: r.amount, target: Math.round(r.amount * (1 + uplift / 100) * 100) / 100 }))
      .filter(r => r.date && r.target >= 0);
    const past = out.filter(r => r.date < todayStr).length;
    const summary = { rows: out.length, skipped, past, from: out[0]?.date || null, to: out[out.length - 1]?.date || null,
      sample: out.filter(r => r.date >= todayStr).slice(0, 3) };
    if (!out.length) return res.status(400).json({ error: 'No date + amount pairs found. Each line needs a date (like 9/17/2025 or 2025-09-17) followed by a number.', summary });
    if (b.dry_run) return res.json({ ok: true, summary });
    if (b.replace) await q('DELETE FROM goal_schedule WHERE template_id = $1', [tpl.id]);
    for (const r of out)
      await q(`INSERT INTO goal_schedule (template_id, date, target, baseline) VALUES ($1,$2,$3,$4)
        ON CONFLICT (template_id, date) DO UPDATE SET target = EXCLUDED.target, baseline = EXCLUDED.baseline`, [tpl.id, r.date, r.target, r.baseline]);
    // Days already on the board (today onward) pick up their scheduled numbers now.
    await q(`UPDATE goals g SET target = s.target, baseline = s.baseline, source = 'schedule'
      FROM goal_schedule s WHERE s.template_id = g.template_id AND s.date = g.date AND g.template_id = $1 AND g.date >= $2`, [tpl.id, todayStr]);
    res.json({ ok: true, summary });
  }));

  // A goal for one specific day (or a per-day override of a template's target).
  app.post('/api/manager/goal', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.remove) { await q('DELETE FROM goals WHERE id = $1', [Number(b.id)]); return res.json({ ok: true }); }
    if (b.id) {
      const g = await one('SELECT * FROM goals WHERE id = $1', [Number(b.id)]);
      if (!g) return res.status(404).json({ error: 'Not found.' });
      await q('UPDATE goals SET label=$2, unit=$3, target=$4 WHERE id=$1',
        [g.id, clean(b.label, 80) || g.label, ['dollars', 'count'].includes(b.unit) ? b.unit : g.unit, b.target != null ? Math.max(0, num(b.target)) : g.target]);
      return res.json({ ok: true, id: g.id });
    }
    const date = isDateStr(b.date) ? String(b.date) : await today();
    const label = clean(b.label, 80);
    if (!label) return res.status(400).json({ error: 'Goal name is required.' });
    const row = await one(`INSERT INTO goals (date, label, unit, target, sort, source) VALUES ($1,$2,$3,$4,$5,'manual') RETURNING id`,
      [date, label, b.unit === 'dollars' ? 'dollars' : 'count', Math.max(0, num(b.target)), num(b.sort)]);
    res.json({ ok: true, id: row.id });
  }));

  app.post('/api/manager/task', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.remove) { await q('DELETE FROM tasks WHERE id = $1', [Number(b.id)]); return res.json({ ok: true }); }
    const title = clean(b.title, 200);
    if (!title) return res.status(400).json({ error: 'Task title is required.' });
    const kind = ['daily', 'weekly', 'once'].includes(b.kind) ? b.kind : 'daily';
    const detail = clean(b.detail, 2000), sort = num(b.sort), active = isOff(b.active) ? 0 : 1;
    const dow = kind === 'weekly' && b.day_of_week !== '' && b.day_of_week != null && num(b.day_of_week) >= 0 && num(b.day_of_week) <= 6 ? num(b.day_of_week) : null;
    const due = kind === 'once' ? (isDateStr(b.due_date) ? String(b.due_date) : await today()) : null;
    const by = clean(b.created_by, 80) || 'Manager';
    let id = Number(b.id) || 0;
    if (id) await q('UPDATE tasks SET kind=$2, title=$3, detail=$4, day_of_week=$5, due_date=$6, sort=$7, active=$8 WHERE id=$1',
      [id, kind, title, detail, dow, due, sort, active]);
    else id = (await one(`INSERT INTO tasks (kind, title, detail, day_of_week, due_date, sort, active, source, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8) RETURNING id`, [kind, title, detail, dow, due, sort, active, by])).id;
    res.json({ ok: true, id });
  }));

  app.post('/api/manager/announcement', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.remove) { await q('DELETE FROM announcements WHERE id = $1', [Number(b.id)]); return res.json({ ok: true }); }
    const body = clean(b.body, 4000);
    if (!body) return res.status(400).json({ error: 'Announcement text is required.' });
    const title = clean(b.title, 120), media = clean(b.media_url, 1000);
    if (media && !/^https?:\/\//i.test(media)) return res.status(400).json({ error: 'Image link must start with http(s)://' });
    const pinned = b.pinned && !isOff(b.pinned) ? 1 : 0, active = isOff(b.active) ? 0 : 1;
    const expires = isDateStr(b.expires_on) ? String(b.expires_on) : null;
    const by = clean(b.created_by, 80) || 'Manager';
    let id = Number(b.id) || 0;
    if (id) await q('UPDATE announcements SET title=$2, body=$3, media_url=$4, pinned=$5, expires_on=$6, active=$7 WHERE id=$1',
      [id, title, body, media, pinned, expires, active]);
    else id = (await one(`INSERT INTO announcements (title, body, media_url, pinned, expires_on, active, source, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,'manual',$7) RETURNING id`, [title, body, media, pinned, expires, active, by])).id;
    res.json({ ok: true, id });
  }));

  // Managers can clear any sign-off / progress entry (a mistaken tap, a test entry).
  app.post('/api/manager/clear', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.completion_id) await q('DELETE FROM task_completions WHERE id = $1', [Number(b.completion_id)]);
    if (b.entry_id) await q('DELETE FROM goal_entries WHERE id = $1', [Number(b.entry_id)]);
    if (b.ack_id) await q('DELETE FROM announcement_acks WHERE id = $1', [Number(b.ack_id)]);
    res.json({ ok: true });
  }));

  // Branding: name, tagline, welcome text, logo (uploaded data URL or link), colors, font.
  app.post('/api/manager/branding', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.reset) {
      for (const k of ['tagline', 'welcome_text', 'logo_url', 'logo_data']) await db.setSetting(k, '');
      await db.setSetting('theme_color', '#1f6feb'); await db.setSetting('theme_topbar', '#111827'); await db.setSetting('theme_bg', '#f4f6f9');
      await db.setSetting('font', 'system');
      return res.json({ ok: true, branding: await db.branding() });
    }
    const out = {};
    if (b.business_name != null) out.business_name = clean(b.business_name, 80) || 'Daily Board';
    if (b.tagline != null) out.tagline = clean(b.tagline, 120);
    if (b.welcome_text != null) out.welcome_text = clean(b.welcome_text, 600);
    for (const k of ['theme_color', 'theme_topbar', 'theme_bg']) {
      if (b[k] == null) continue;
      const c = clean(b[k], 7);
      if (!/^#[0-9a-f]{6}$/i.test(c)) return res.status(400).json({ error: 'Colors must be hex, like #1f6feb.' });
      out[k] = c.toLowerCase();
    }
    if (b.font != null) {
      if (!db.FONTS.includes(b.font)) return res.status(400).json({ error: 'Pick a font from the list.' });
      out.font = b.font;
    }
    if (b.logo_url != null) {
      const u = clean(b.logo_url, 1000);
      if (u && !/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'Logo link must start with http(s)://' });
      out.logo_url = u;
    }
    if (b.logo_data != null) {
      const d = String(b.logo_data).trim();
      if (d && !/^data:image\/(png|jpeg|webp|svg\+xml|gif);base64,[A-Za-z0-9+/=]+$/.test(d)) return res.status(400).json({ error: 'The logo must be a PNG, JPEG, WebP, GIF, or SVG image.' });
      if (d.length > 400000) return res.status(400).json({ error: 'That logo is too large — please use an image under 300 KB.' });
      out.logo_data = d;
    }
    for (const [k, v] of Object.entries(out)) await db.setSetting(k, v);
    res.json({ ok: true, branding: await db.branding() });
  }));

  app.post('/api/manager/settings', managerOnly, wrap(async (req, res) => {
    const b = req.body || {};
    const out = {};
    if (b.timezone != null) {
      if (!validTz(String(b.timezone).trim())) return res.status(400).json({ error: 'Unknown timezone — use an IANA name like America/Denver.' });
      out.timezone = String(b.timezone).trim();
    }
    if (b.board_pass != null) out.board_pass = clean(b.board_pass, 60);
    if (b.manager_pin != null) {
      const p = clean(b.manager_pin, 40);
      if (p.length < 4) return res.status(400).json({ error: 'Manager PIN must be at least 4 characters.' });
      out.manager_pin = p;
    }
    if (b.sms_number != null) out.sms_number = clean(b.sms_number, 40);
    if (b.sms_default_kind != null) out.sms_default_kind = b.sms_default_kind === 'task' ? 'task' : 'announcement';
    for (const [k, v] of Object.entries(out)) await db.setSetting(k, v);
    // A changed PIN invalidates the caller's own token — hand back a fresh one.
    res.json({ ok: true, token: out.manager_pin != null ? await makeToken('manager') : undefined });
  }));

  // ---------- inbound text messages ----------
  // Twilio (and most SMS providers) POST each text here as a form. Point the
  // number's "A message comes in" webhook at https://<your-site>/api/sms/inbound.
  // Only phone numbers on the staff roster with the Manager role can post.
  app.post('/api/sms/inbound', express.urlencoded({ extended: false, limit: '64kb' }), wrap(async (req, res) => {
    const b = req.body || {};
    const isTwilio = !!(b.MessageSid || b.AccountSid || b.From);
    const from = String(b.From || b.from || b.sender || '').trim();
    const text = String(b.Body ?? b.body ?? b.text ?? b.message ?? '').trim();
    const media = String(b.MediaUrl0 || b.media_url || '').trim();
    const reply = (msg, status = 200) => {
      if (isTwilio) return res.status(status).type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${xmlEsc(msg)}</Message>` : ''}</Response>`);
      res.status(status).json(msg ? { ok: status < 400, reply: msg } : { ok: status < 400 });
    };

    // Authenticate the webhook itself before trusting the From number.
    const token = process.env.TWILIO_AUTH_TOKEN, secret = process.env.SMS_WEBHOOK_SECRET;
    if (token) {
      const url = process.env.TWILIO_WEBHOOK_URL || (baseUrl(req) + req.originalUrl);
      if (!twilioSignatureValid(token, url, b, req.headers['x-twilio-signature'])) {
        recordFail(req);
        return res.status(403).type('text/plain').send('Bad Twilio signature');
      }
    } else if (secret) {
      const given = String(req.headers['x-webhook-secret'] || req.query.secret || '');
      if (!safeEqual(given, secret)) { recordFail(req); return res.status(403).type('text/plain').send('Bad webhook secret'); }
    } else if (!mount.warnedOpen) {
      mount.warnedOpen = true;
      console.warn('SMS webhook: set TWILIO_AUTH_TOKEN (or SMS_WEBHOOK_SECRET) so /api/sms/inbound only accepts real provider posts.');
    }

    const log = fields => q(`INSERT INTO sms_log (from_phone, staff_name, body, media_url, action, target_id, reply) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [from.slice(0, 40), fields.staff_name || '', text.slice(0, 4000), media.slice(0, 1000), fields.action, fields.target_id || null, fields.reply || '']);

    const key = phoneKey(from);
    const sender = key ? (await q("SELECT * FROM staff WHERE active = 1 AND role = 'manager' AND phone <> ''")).find(s => phoneKey(s.phone) === key) : null;
    if (!sender) {
      // Silent to strangers (no auto-reply loops, no SMS spend); the attempt shows in the manager panel.
      await log({ action: 'rejected' });
      return reply('');
    }

    const cmd = parseSms(text, await db.getSetting('sms_default_kind', 'announcement'));
    if (cmd.action === 'help' && !media) { await log({ staff_name: sender.name, action: 'help', reply: HELP_TEXT }); return reply(HELP_TEXT); }
    if (cmd.action === 'error') { await log({ staff_name: sender.name, action: 'rejected', reply: cmd.text }); return reply(cmd.text); }

    const todayStr = await today();
    let msg = '', action = cmd.action, targetId = null;
    if (cmd.action === 'announcement' || cmd.action === 'help') {
      const row = await one(`INSERT INTO announcements (title, body, media_url, pinned, active, source, created_by)
        VALUES ('', $1, $2, 0, 1, 'sms', $3) RETURNING id`, [cmd.text || '(photo)', media, sender.name]);
      action = 'announcement'; targetId = row.id;
      msg = `Posted to announcements ✓${media ? ' (with photo)' : ''}`;
    } else if (cmd.action === 'task') {
      const row = await one(`INSERT INTO tasks (kind, title, detail, day_of_week, due_date, sort, active, source, created_by)
        VALUES ($1,$2,$3,$4,$5,0,1,'sms',$6) RETURNING id`,
        [cmd.kind, cmd.text.slice(0, 200), media ? `Photo: ${media}` : '', cmd.kind === 'weekly' ? cmd.dow : null, cmd.kind === 'once' ? todayStr : null, sender.name]);
      action = `task-${cmd.kind}`; targetId = row.id;
      msg = cmd.kind === 'once' ? "Added to today's tasks ✓" : cmd.kind === 'daily' ? 'Added as a daily task ✓'
        : `Added as a weekly task${cmd.dow != null ? ` (due ${DOW_SHORT[cmd.dow]})` : ''} ✓`;
    } else if (cmd.action === 'goal') {
      // Replace today's goal with that name if there is one, otherwise add it.
      const existing = (await q('SELECT * FROM goals WHERE date = $1', [todayStr])).find(g => g.label.toLowerCase() === cmd.label.toLowerCase());
      if (existing) { await q('UPDATE goals SET target = $2, unit = $3 WHERE id = $1', [existing.id, cmd.target, cmd.unit]); targetId = existing.id; }
      else targetId = (await one(`INSERT INTO goals (date, label, unit, target, sort, source) VALUES ($1,$2,$3,$4,99,'sms') RETURNING id`,
        [todayStr, cmd.label, cmd.unit, cmd.target])).id;
      msg = `Today's goal set: ${cmd.label} → ${cmd.unit === 'dollars' ? '$' + cmd.target.toLocaleString('en-US') : cmd.target} ✓`;
    }
    await log({ staff_name: sender.name, action, target_id: targetId, reply: msg });
    reply(msg);
  }));
}

module.exports = mount;
module.exports.parseSms = parseSms;
module.exports.parseSchedule = parseSchedule;
module.exports.shiftDate = shiftDate;
module.exports.phoneKey = phoneKey;
module.exports.weekStart = weekStart;
module.exports.twilioSignatureValid = twilioSignatureValid;
module.exports.HELP_TEXT = HELP_TEXT;
