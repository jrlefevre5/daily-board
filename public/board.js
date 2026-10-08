// Daily Board front end — one page that is the front-desk board (goals,
// tasks, announcements, sign-offs) and, for managers, the panel that runs it.
// The board device signs in once with the shared board password; managers
// unlock the panel with the manager PIN. Both get an HMAC token from the
// server, sent back as X-Token.
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const attr = esc;

let boardToken = localStorage.getItem('db_board_token') || '';
let mgrToken = localStorage.getItem('db_mgr_token') || '';
let mgrName = localStorage.getItem('db_mgr_name') || '';
let cfg = {};             // /api/config (public branding)
let data = null;          // /api/board payload for viewDate
let viewDate = '';        // YYYY-MM-DD being shown ('' = today)
let mgr = null;           // /api/manager/overview payload while the panel is open
let mgrTab = 'goals';
let lastStaff = Number(localStorage.getItem('db_me') || 0);
let clockTimer = null, refreshTimer = null;
let lastLoad = 0, refreshing = false, hintTimer = null;   // see "keeping the board current"

function headers() {
  const h = { 'Content-Type': 'application/json' };
  const t = mgrToken || boardToken;
  if (t) h['X-Token'] = t;
  return h;
}
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: headers(), body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, ...j };
}
const isManager = () => !!mgrToken;

// ---- dates & times (the server sends business-timezone date strings) ----
function fmtDay(d) { const x = new Date(d + 'T00:00:00Z'); return `${DOW[x.getUTCDay()]}, ${x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`; }
function fmtShort(d) { return d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''; }
function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: data?.timezone }); } catch { return ''; } }
function fmtStamp(iso) { try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: data?.timezone }); } catch { return ''; } }
function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function fmtAmt(n, unit) { n = Number(n) || 0; return unit === 'dollars' ? '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toLocaleString('en-US', { maximumFractionDigits: 2 }); }

// ---------- boot / sign-in ----------
async function boot() {
  try { cfg = await (await fetch('/api/config')).json(); } catch { cfg = {}; }
  applyBranding(cfg);
  if (!boardToken && !mgrToken) return renderLogin();
  await loadBoard();
}
async function loadBoard() {
  let out = await api('/api/board' + (viewDate ? `?date=${viewDate}` : ''));
  if (out.status === 401 && mgrToken) {           // manager session expired — fall back to the board token
    mgrToken = ''; mgr = null; localStorage.removeItem('db_mgr_token');
    out = boardToken ? await api('/api/board' + (viewDate ? `?date=${viewDate}` : '')) : out;
  }
  if (out.status === 401 || out.status === 429) {
    if (out.status === 401) { boardToken = ''; localStorage.removeItem('db_board_token'); }
    return renderLogin(out.error);
  }
  if (out.error) { $app.innerHTML = `<div class="notice warn">${esc(out.error)}</div>`; return; }
  data = out; lastLoad = Date.now();
  if (!viewDate) viewDate = data.today;
  applyBranding(data);
  render();
}
// ---- branding (Manager panel → Branding) ----
const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const DEFAULT_BRAND = { business_name: 'Daily Board', tagline: '', welcome_text: '', theme_color: '#1f6feb', theme_topbar: '#111827', theme_bg: '#f4f6f9', font: 'system', logo: '' };
// White or near-black text, whichever reads better on the given hex color.
function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.4 ? '#111827' : '#ffffff';
}
function fontStack(font) { return !font || font === 'system' ? SYSTEM_FONT : `"${font}", ${SYSTEM_FONT}`; }
function loadFont(font) {
  if (!font || font === 'system') return;
  const id = 'font-' + font.replace(/\W/g, '');
  if (document.getElementById(id)) return;
  const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, '+')}:wght@400;600;700;800&display=swap`;
  document.head.appendChild(l);
}
// Writes a brand's colors/font onto an element as CSS variables (the page root, or the preview card).
function brandVars(el, b) {
  const r = el.style;
  const accent = b.theme_color || DEFAULT_BRAND.theme_color, top = b.theme_topbar || DEFAULT_BRAND.theme_topbar;
  r.setProperty('--accent', accent);
  r.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 12%, white)`);
  r.setProperty('--accent-ink', `color-mix(in srgb, ${accent} 70%, black)`);
  r.setProperty('--on-accent', inkOn(accent));
  r.setProperty('--topbar', top);
  r.setProperty('--topbar-ink', inkOn(top));
  r.setProperty('--bg', b.theme_bg || DEFAULT_BRAND.theme_bg);
  r.setProperty('--font', fontStack(b.font));
  loadFont(b.font);
}
function markHtml(b) { return b.logo ? `<img src="${attr(b.logo)}" alt="">` : '✓'; }
function applyBranding(b) {
  if (!b) return;
  brandVars(document.documentElement, b);
  const name = b.business_name || 'Daily Board';
  document.getElementById('brandName').textContent = name;
  document.getElementById('brandTag').textContent = b.tagline || '';
  document.title = name;
  const mark = document.getElementById('brandMark');
  mark.innerHTML = markHtml(b); mark.classList.toggle('logo', !!b.logo);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='${b.theme_color || DEFAULT_BRAND.theme_color}'/><path d='M18 34l10 10 18-22' fill='none' stroke='${inkOn(b.theme_color)}' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/></svg>`;
  document.getElementById('favicon').href = b.logo || 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function renderLogin(err) {
  stopTimers();
  document.getElementById('topRight').textContent = '';
  document.getElementById('refreshBtn').hidden = true; document.getElementById('bellBtn').hidden = true;
  $app.innerHTML = `<div class="login">
    <div class="hero">${cfg.logo ? `<img src="${attr(cfg.logo)}" alt="">` : ''}<div><h1>${esc(cfg.business_name || 'Daily Board')}</h1>${cfg.tagline ? `<div class="tagline">${esc(cfg.tagline)}</div>` : ''}</div></div>
    <p class="lead">${esc(cfg.welcome_text || "The team's shared screen: today's sales goals, the daily and weekly checklists, and announcements from management — every item signed off by whoever handled it.")}</p>
    ${err ? `<div class="notice warn">${esc(err)}</div>` : ''}
    <div class="panel" style="max-width:420px">
      <h2>Sign in</h2>
      <form onsubmit="boardLogin(); return false">
        <label>Password or PIN</label>
        <input class="inline" id="bl_pass" type="password" autocomplete="current-password" style="width:100%">
        <div class="err" id="bl_err"></div>
        <div style="margin-top:12px"><button class="small" type="submit">Sign in</button></div>
      </form>
      <p class="mini" style="margin:12px 0 0"><a href="sms.html">Text message policy &amp; opt-in</a></p>
      ${cfg.board_pass_set === false ? `<p class="mini" style="margin:12px 0 0">First time here? Sign in with the manager PIN (default <b>1234</b>), then set a board password and change the PIN under Settings.</p>` : ''}
    </div></div>`;
  document.getElementById('bl_pass').focus();
}
// One sign-in box: the code you type decides your access (manager PIN → manager, board password → board).
window.boardLogin = async () => {
  const p = document.getElementById('bl_pass').value.trim();
  if (!p) return;
  const out = await api('/api/login', { code: p });
  if (!out.token) { document.getElementById('bl_err').textContent = out.error || 'Wrong password or PIN.'; return; }
  if (out.role === 'manager') { mgrToken = out.token; localStorage.setItem('db_mgr_token', mgrToken); if (out.name) window.setMgrName(out.name); }   // a staff manager's own PIN also fills in their name for posts
  else { boardToken = out.token; localStorage.setItem('db_board_token', boardToken); }
  await loadBoard();
};
window.managerLogin = async prefix => {
  const pin = document.getElementById(`${prefix}_pin`).value.trim();
  if (!pin) return;
  const out = await api('/api/login', { manager_pin: pin });
  if (!out.token) { document.getElementById(`${prefix}_err`).textContent = out.error || 'Wrong PIN.'; return false; }
  mgrToken = out.token; localStorage.setItem('db_mgr_token', mgrToken); if (out.name) window.setMgrName(out.name);
  if (prefix === 'ml') await loadBoard();
  return true;
};
window.boardLogout = () => {
  boardToken = ''; mgrToken = ''; data = null; mgr = null; viewDate = '';
  localStorage.removeItem('db_board_token'); localStorage.removeItem('db_mgr_token');
  renderLogin();
};
window.managerLogout = async () => {
  mgrToken = ''; mgr = null; localStorage.removeItem('db_mgr_token');
  if (!boardToken) return boardLogout();
  await loadBoard();
};

// ---------- the board ----------
function stopTimers() { clearInterval(clockTimer); clearInterval(refreshTimer); clockTimer = refreshTimer = null; }
function startTimers() {
  stopTimers();
  clockTimer = setInterval(() => {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: data?.timezone });
  }, 1000);
  // A board left open on the desk keeps itself current (unless someone is mid-dialog).
  refreshTimer = setInterval(() => refreshNow({ quiet: true }), 60 * 1000);
}
window.boardNav = async d => { viewDate = addDays(viewDate, d); await loadBoard(); };
window.boardToday = async () => { viewDate = data.today; await loadBoard(); };

// ---------- keeping the board current ----------
// An installed app is frozen while it's in the background, so the 60-second timer above
// can't catch up on its own: refresh the moment the app comes back, plus a Refresh button
// and pull-down-to-refresh (an installed app has no browser reload button).
function syncRefreshBtn() { const b = document.getElementById('refreshBtn'); if (b) b.hidden = !(data || mgr); }
function showHint(text) {
  let el = document.getElementById('refreshHint');
  if (!el) { el = document.createElement('div'); el.id = 'refreshHint'; document.body.appendChild(el); }
  el.textContent = text; el.classList.add('show');
  clearTimeout(hintTimer); hintTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
const typingInBoard = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $app.contains(a); };
// quiet = automatic refresh: never interrupts a dialog, the manager panel, or someone typing.
async function refreshNow(opts = {}) {
  if (refreshing || (!boardToken && !mgrToken)) return;
  if (opts.quiet && (mgr || $modal.innerHTML || typingInBoard() || Date.now() - lastLoad < 5000)) return;
  refreshing = true;
  const btn = document.getElementById('refreshBtn');
  if (!opts.quiet && btn) btn.classList.add('spin');
  let ok = true;
  try {
    await Promise.all([mgr ? reloadMgr() : loadBoard(), opts.quiet ? 0 : new Promise(r => setTimeout(r, 600))]);
  } catch { ok = false; }
  refreshing = false;
  if (btn) btn.classList.remove('spin');
  if (!opts.quiet) showHint(ok ? 'Updated' : "Couldn't reach the server");
}
window.refreshNow = refreshNow;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshNow({ quiet: true }); });
window.addEventListener('pageshow', e => { if (e.persisted) refreshNow({ quiet: true }); });
window.addEventListener('online', () => refreshNow({ quiet: true }));
// ---------- app notifications (push) ----------
// The bell in the top bar turns them on for this device. A device signed in with someone's own PIN is
// tied to that person, so "a task was assigned to you" alerts can find it. iPhones only allow this
// from the installed (home-screen) app.
let pushKey = null, pushOn = false, pushOwner = null;
const pushWho = () => (data && data.me ? data.me.id : 0) + (mgrToken ? 'm' : '');   // who this device belongs to (and whether it's a manager's)
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushReg = () => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
function keyBytes(s) { const raw = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
async function initPush() {
  const bell = document.getElementById('bellBtn'); if (!bell) return;
  try {
    if (pushKey === null) pushKey = (await api('/api/push/key')).key || '';
    bell.hidden = !pushKey;
    if (!pushKey) return;
    pushOn = false;
    if (pushSupported() && Notification.permission === 'granted') {
      const sub = await (await pushReg()).pushManager.getSubscription();
      if (sub) {
        const owner = pushWho();
        if (pushOwner !== owner) { await api('/api/push/subscribe', { subscription: sub.toJSON() }); pushOwner = owner; }   // keeps the device tied to whoever is signed in
        pushOn = true;
      }
    }
    bell.textContent = pushOn ? '🔔' : '🔕';
    bell.title = pushOn ? 'Notifications are on — tap to turn off' : 'Turn on notifications';
  } catch { /* notifications are optional */ }
}
window.toggleNotifications = async () => {
  if (!pushSupported()) {
    alert(/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches)
      ? 'To get notifications on an iPhone or iPad, first install the app: tap the Share button, choose "Add to Home Screen", then open it from your home screen and tap the bell again.'
      : "This browser can't show app notifications.");
    return;
  }
  try {
    if (pushOn) {
      const sub = await (await pushReg()).pushManager.getSubscription();
      if (sub) { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      pushOwner = null; showHint('Notifications off'); return initPush();
    }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();   // straight from the tap — iPhones insist
    if (perm === 'denied') { alert('Notifications are blocked for this app. Allow them in your phone\'s settings (Settings → Notifications → this app), then tap the bell again.'); return; }
    if (perm !== 'granted') { showHint('Notifications not allowed'); return; }
    const reg = await pushReg();
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey) });
    const out = await api('/api/push/subscribe', { subscription: sub.toJSON() });
    if (out.error) { await sub.unsubscribe(); alert(out.error); return; }
    pushOwner = pushWho();
    showHint(mgrToken ? 'Notifications on — you\'ll hear when tasks are completed' : data && data.me ? 'Notifications on' : 'Notifications on — sign in with your own PIN to also get your personal tasks');
    initPush();
  } catch (e) { alert("Couldn't change notifications: " + ((e && e.message) || e)); }
};
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'refresh') refreshNow({ quiet: true }); });

// Pull down from the top of the page to refresh.
let pullStart = null, pullDy = 0;
document.addEventListener('touchstart', e => {
  pullStart = window.scrollY <= 0 && e.touches.length === 1 && !$modal.innerHTML ? e.touches[0].clientY : null; pullDy = 0;
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (pullStart === null) return;
  pullDy = e.touches[0].clientY - pullStart;
  if (pullDy > 80) showHint('Release to refresh');
}, { passive: true });
document.addEventListener('touchend', () => { if (pullStart !== null && pullDy > 80) refreshNow(); pullStart = null; pullDy = 0; });
document.addEventListener('touchcancel', () => { pullStart = null; pullDy = 0; });

function render() {
  if (mgr) return renderManager();
  startTimers(); syncRefreshBtn(); initPush();
  document.getElementById('topRight').textContent = data.is_manager ? 'Manager' : data.me ? data.me.name : '';
  const isToday = viewDate === data.today, isFuture = viewDate > data.today;
  const canSign = !isFuture;
  const goalsDone = data.goals.filter(g => g.target > 0 && g.actual >= g.target).length;
  const tDone = data.tasks_today.filter(t => t.completion).length, wDone = data.tasks_week.filter(t => t.completion).length;
  // Today's finished tasks drop off the board (the manager portal's Activity log keeps them); past days still show everything.
  const todayList = isToday ? data.tasks_today.filter(t => !t.done) : data.tasks_today;
  const weekList = isToday ? data.tasks_week.filter(t => !t.done) : data.tasks_week;
  $app.innerHTML = `
    <div class="bar">
      <div class="date"><small>${isToday ? 'Today' : isFuture ? 'Upcoming' : 'Looking back'}</small>${esc(fmtDay(viewDate))}</div>
      <button class="mini-btn" onclick="boardNav(-1)">‹ Prev day</button>
      <button class="mini-btn" onclick="boardToday()" ${isToday ? 'disabled' : ''}>Today</button>
      <button class="mini-btn" onclick="boardNav(1)">Next day ›</button>
      <div class="spacer"></div>
      <span class="clock" id="clock">${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: data.timezone })}</span>
      ${data.is_manager
        ? `<button class="small" onclick="openManager()">Manager panel</button><button class="mini-btn" onclick="managerLogout()">Sign out</button>`
        : `<button class="small ghost" onclick="managerPrompt()">Manager</button><button class="mini-btn" onclick="boardLogout()">Sign out</button>`}
    </div>
    ${!data.board_pass_set && data.is_manager ? `<div class="notice">No board password is set yet, so only managers can open this page. Set one under Manager panel → Settings and share it with the team.</div>` : ''}
    ${isFuture ? `<div class="notice">This is a future day — you can look, but sign-offs open on the day itself.</div>` : ''}

    <div class="panel">
      <h2>Sales goals <span class="count">${data.goals.length ? `${goalsDone} of ${data.goals.length} met` : ''}</span></h2>
      ${data.goals.length ? `<div class="goals">${data.goals.map(goalCard(canSign)).join('')}</div>`
        : `<div class="empty">No goals for this day yet.${data.is_manager ? ' Add recurring goals under Manager panel → Goals.' : ''}${data.sms_number ? ` Managers can also text <b>GOAL sales 5</b> to ${esc(data.sms_number)}.` : ''}</div>`}
    </div>

    <div class="panel">
      <h2>Announcements <span class="count">${data.announcements.length || ''}</span></h2>
      ${data.announcements.length ? data.announcements.map(annCard(canSign)).join('') : `<div class="empty">Nothing posted right now.</div>`}
    </div>

    <div class="grid2">
      <div class="panel">
        <h2>Today's tasks <span class="count">${data.tasks_today.length ? `${tDone} / ${data.tasks_today.length} done` : ''}</span></h2>
        ${todayList.length ? todayList.map(taskRow(canSign)).join('') : `<div class="empty">${data.tasks_today.length ? 'All done for today ✓' : 'No daily tasks yet.'}</div>`}
      </div>
      <div class="panel">
        <h2>This week <span class="count">${esc(fmtShort(data.week_start))} – ${esc(fmtShort(data.week_end))}${data.tasks_week.length ? ` · ${wDone} / ${data.tasks_week.length} done` : ''}</span></h2>
        ${weekList.length ? weekList.map(taskRow(canSign)).join('') : `<div class="empty">${data.tasks_week.length ? 'All done for this week ✓' : 'No weekly tasks yet.'}</div>`}
      </div>
    </div>
    ${highlightsPanel(canSign)}
    ${data.sms_number ? `<p class="mini" style="text-align:center">Managers: text <b>${esc(data.sms_number)}</b> to post — start with ANNOUNCE, TASK, DAILY, WEEKLY, or GOAL (or HELP).</p>` : ''}`;
  watchAnnouncements();
}

// ---------- shift highlights & peer shoutouts ----------
function highlightsPanel(canDo) {
  const list = data.highlights || [];
  const item = h => `<div class="hl"><span class="hl-ic">${h.kind === 'shoutout' ? '👏' : '⭐'}</span><div><div>${h.kind === 'shoutout' ? `<b>${esc(h.author_name)}</b> gave <b>${esc(h.subject_name)}</b> a shoutout: ` : ''}${esc(h.body)}</div>
    <div class="mini">${h.kind === 'shoutout' ? '' : `Shift highlight from <b>${esc(h.author_name)}</b> · `}${esc(fmtStamp(h.created_at))}</div></div></div>`;
  return `<div class="panel">
    <h2>Shift highlights &amp; shoutouts <span class="count">${list.length || ''}</span></h2>
    ${canDo ? `<div style="margin:0 0 10px"><button class="small" onclick="openHL('highlight')">⭐ Share a shift highlight</button> <button class="small ghost" onclick="openHL('shoutout')">👏 Give a teammate a shoutout</button></div>` : ''}
    ${list.length ? list.map(item).join('') : `<div class="empty">Nothing shared this week yet — tell the team about something good that happened on your shift.</div>`}
  </div>`;
}
window.sendRemindersNow = async weekly => {
  const out = await api('/api/manager/send-reminders', { weekly: !!weekly }), el = document.getElementById('st_remind_out');
  if (el) el.textContent = out.error ? out.error : out.open ? `Sent to ${out.sent} device${out.sent === 1 ? '' : 's'} (${out.open} open task${out.open === 1 ? '' : 's'}).` : 'Nothing is open.';
};
window.openHL = kind => {
  const shout = kind === 'shoutout';
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal">
    <h3>${shout ? '👏 Give a shoutout' : '⭐ Share a shift highlight'}</h3>
    <p class="sub">${shout ? 'Recognize a teammate for something they did. Everyone with notifications on will see it.' : 'Something good that happened on your shift. Everyone with notifications on will see it.'}</p>
    <form onsubmit="submitHL('${kind}'); return false">
      ${staffPicker('hl')}
      ${shout ? `<label>Who's the shoutout for?</label><select class="inline" id="hl_subject"><option value="">Choose a teammate…</option>${data.staff.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>` : ''}
      <label>${shout ? 'What did they do?' : 'What went well?'}</label>
      <textarea class="inline" id="hl_body" maxlength="500" placeholder="${shout ? 'Be specific — what did they do that you appreciated?' : 'A great sale, a happy customer, a problem solved…'}"></textarea>
      <div class="err" id="hl_err"></div>
      <div class="row"><button type="button" class="small ghost" onclick="closeModal()">Cancel</button><button type="submit" class="small green" id="hl_go">Post</button></div>
    </form>
  </div></div>`;
  onStaffPick('hl');
};
window.submitHL = async kind => {
  const err = document.getElementById('hl_err'), go = document.getElementById('hl_go');
  const body = { ...signerFields('hl'), kind, body: document.getElementById('hl_body').value.trim() };
  if (kind === 'shoutout') { body.subject_id = Number((document.getElementById('hl_subject') || {}).value) || 0; if (!body.subject_id) { err.textContent = 'Choose a teammate.'; return; } }
  if (!body.body) { err.textContent = 'Write a few words first.'; return; }
  go.disabled = true; err.textContent = '';
  const out = await api('/api/board/highlight', body);
  go.disabled = false;
  if (out.error) { err.textContent = out.error; return; }
  if (body.staff_id) { lastStaff = body.staff_id; localStorage.setItem('db_me', String(lastStaff)); }
  closeModal(); await loadBoard();
};

// ---------- peer evaluations (the old weekly ratings; no longer shown on the board) ----------
function evalPanel(canDo) {
  const pe = data.peer_eval;
  const raters = data.staff.filter(s => !s.skip_evals);   // people exempted from evaluations aren't expected to do one
  if (!pe || !pe.enabled || !raters.length) return '';
  const n = raters.filter(s => pe.done.includes(s.id)).length;
  return `<div class="panel">
    <h2>Peer evaluations <span class="count">week of ${esc(fmtShort(pe.week))} · ${n} / ${raters.length} done</span></h2>
    <p class="mini" style="margin:0 0 10px">Each person rates one teammate a week — pick someone different each time. Only managers see what you write.</p>
    <div class="people">${raters.map(s => pe.done.includes(s.id)
      ? `<span class="person done">✓ ${esc(s.name)}</span>`
      : `<button class="person" ${canDo ? `onclick="openEval(${s.id})"` : 'disabled'}>${esc(s.name)}</button>`).join('')}</div>
    ${canDo ? `<div style="margin-top:12px"><button class="small" onclick="openEval(0)">Evaluate a teammate</button></div>` : ''}
  </div>`;
}
let evalScores = {};
window.openEval = staffId => {
  evalScores = {};
  const pe = data.peer_eval;
  // PINs required: step one is just the PIN; step two says who is evaluating and has the form.
  if (data.require_pin && !signPin) {
    $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal">
      <h3>Peer evaluation</h3><p class="sub">Week of ${esc(fmtShort(pe.week))}. Honest and specific helps most — managers read these, teammates don't.</p>
      <form onsubmit="evalContinue(); return false">
        ${staffPicker('ev')}
        <div class="err" id="ev_err"></div>
        <div class="row"><button type="button" class="small ghost" onclick="closeModal()">Cancel</button><button type="submit" class="small green" id="ev_go">Continue</button></div>
      </form>
    </div></div>`;
    document.getElementById('ev_pin').focus();
    return;
  }
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal" style="max-width:600px">
    <h3>Peer evaluation</h3><p class="sub">Week of ${esc(fmtShort(pe.week))}. Honest and specific helps most — managers read these, teammates don't.</p>
    ${data.require_pin ? `<div class="notice" style="margin:0 0 4px">Evaluating as <b>${esc(signWho)}</b> · <a href="#" onclick="evalBack(); return false">not you?</a></div>` : staffPicker('ev', data.staff.filter(s => !s.skip_evals && !pe.done.includes(s.id)).map(s => s.id), staffId)}
    <div id="ev_notice"></div>
    <label>Who are you evaluating?</label>
    <select class="inline" id="ev_subject"><option value="">${data.require_pin ? 'Loading…' : 'Pick your name first…'}</option></select>
    <div id="ev_form" style="display:none">
      ${pe.criteria.map((c, i) => `<div class="crit"><span>${esc(c)}</span><div class="rate" data-c="${attr(c)}">${[1, 2, 3, 4, 5].map(v => `<button type="button" onclick="rate(this, ${v})">${v}</button>`).join('')}</div></div>`).join('')}
      <div class="mini" style="margin:4px 0 0">1 = needs work · 3 = solid · 5 = outstanding</div>
      <label>What are they doing well?</label><textarea class="inline" id="ev_strengths" maxlength="1000" placeholder="A specific example beats a general compliment."></textarea>
      <label>One thing to work on</label><textarea class="inline" id="ev_improve" maxlength="1000" placeholder="Keep it kind and useful."></textarea>
      <label>Signature</label>
      ${padHtml()}
    </div>
    <div class="err" id="ev_err"></div>
    <div class="row"><button class="small ghost" onclick="closeModal()">Cancel</button><button class="small green" id="ev_go" onclick="submitEval()" disabled>Submit evaluation</button></div>
  </div></div>`;
  onStaffPick('ev');
  if (data.require_pin) { evalLoad(); return; }
  document.getElementById('ev_staff').addEventListener('change', evalLoad);
  if (staffId) evalLoad();
};
// Step one done: the server says whose PIN that is; on to the evaluation form.
window.evalContinue = async () => {
  const err = document.getElementById('ev_err'), go = document.getElementById('ev_go');
  const pin = ((document.getElementById('ev_pin') || {}).value || '').trim();
  if (!pin) { err.textContent = 'Enter your PIN.'; return; }
  go.disabled = true; err.textContent = '';
  const out = await api('/api/board/peer-eval/options', { pin });
  go.disabled = false;
  if (out.error) { err.textContent = out.error; document.getElementById('ev_pin').select(); return; }
  if (out.already) { err.textContent = `${out.name}, you've already submitted this week's evaluation (${out.already}). Thanks!`; return; }
  signPin = pin; signWho = out.name;
  openEval(0);
};
window.evalBack = () => { signPin = ''; signWho = ''; openEval(0); };
window.evalLoad = evalLoad;
async function evalLoad() {
  const sel = document.getElementById('ev_staff'), sub = document.getElementById('ev_subject'), form = document.getElementById('ev_form'), notice = document.getElementById('ev_notice');
  const id = sel ? Number(sel.value) : 0, pin = sel ? '' : signPin;
  sub.innerHTML = `<option value="">${sel ? 'Pick your name first…' : 'Loading…'}</option>`; form.style.display = 'none'; notice.innerHTML = ''; document.getElementById('ev_go').disabled = true;
  if (sel ? !id : !pin.trim()) return;
  const out = sel ? await api('/api/board/peer-eval/options?staff_id=' + id) : await api('/api/board/peer-eval/options', { pin });
  if (out.error) { notice.innerHTML = `<div class="notice warn">${esc(out.error)}</div>`; return; }
  if (out.already) { notice.innerHTML = `<div class="notice">You've already submitted this week's evaluation (${esc(out.already)}). Thanks!</div>`; return; }
  sub.innerHTML = '<option value="">Choose a teammate…</option>' + out.options.map(o => `<option value="${o.id}" ${o.recent ? 'disabled' : ''}>${esc(o.name)}${o.recent ? ' — rated recently, pick someone else' : ''}</option>`).join('');
  if (!out.options.some(o => !o.recent)) notice.innerHTML = '<div class="notice">Nobody left to rate this week — you\'ve rated everyone recently.</div>';
  form.style.display = ''; document.getElementById('ev_go').disabled = false;
  initPad(document.getElementById('sg_pad'));
}
window.rate = (btn, v) => {
  const wrap = btn.parentElement; evalScores[wrap.dataset.c] = v;
  for (const b of wrap.querySelectorAll('button')) b.classList.toggle('on', Number(b.textContent) <= v);
};
window.submitEval = async () => {
  const err = document.getElementById('ev_err'), go = document.getElementById('ev_go');
  const body = { ...signerFields('ev'), subject_id: Number(document.getElementById('ev_subject').value), scores: evalScores,
    strengths: document.getElementById('ev_strengths').value.trim(), improve: document.getElementById('ev_improve').value.trim(), signature: readSignature() };
  if (signPin) body.pin = signPin;   // typed in step one
  if (!body.subject_id) { err.textContent = 'Choose a teammate to evaluate.'; return; }
  for (const c of data.peer_eval.criteria) if (!evalScores[c]) { err.textContent = `Rate "${c}" first.`; return; }
  if (!body.signature) { err.textContent = 'Add your signature.'; return; }
  go.disabled = true; err.textContent = '';
  const out = await api('/api/board/peer-eval', body);
  go.disabled = false;
  if (out.error) { err.textContent = out.error; return; }
  if (body.staff_id) { lastStaff = body.staff_id; localStorage.setItem('db_me', String(lastStaff)); }
  closeModal(); await loadBoard();
};

const goalCard = canSign => g => {
  const pct = g.target > 0 ? Math.min(100, Math.round(g.actual / g.target * 100)) : (g.actual > 0 ? 100 : 0);
  const met = g.target > 0 && g.actual >= g.target;
  const last = g.entries[g.entries.length - 1];
  // A monthly goal adds up everything logged this month; show how it's pacing.
  const monthly = g.period === 'month';
  let pace = '';
  if (monthly && !met && g.target > 0 && data.today.slice(0, 7) === g.month) {
    const [y, m] = g.month.split('-').map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate(), dom = Number(data.today.slice(8, 10));
    const left = g.target - g.actual, daysLeft = dim - dom + 1, ahead = g.actual >= g.target * dom / dim;
    pace = `<div class="mini" style="margin-top:6px">${esc(fmtAmt(left, g.unit))} to go · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left · about ${esc(fmtAmt(left / daysLeft, g.unit))} a day <span class="chip ${ahead ? 'sms' : 'due'}">${ahead ? 'on pace' : 'behind pace'}</span></div>`;
  }
  const monthName = monthly ? new Date(g.month + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) : '';
  return `<div class="goal ${met ? 'met' : ''}">
    ${met ? '<div class="met-tag">MET ✓</div>' : ''}
    <div class="lbl">${esc(g.label)}${monthly ? ` <span class="chip">${esc(monthName)}</span>` : ''}${g.baseline != null ? ` <span class="chip" title="Last year's number this goal is based on">LY ${esc(fmtAmt(g.baseline, g.unit))}</span>` : ''}</div>
    <div class="nums">${esc(fmtAmt(g.actual, g.unit))} <small>/ ${esc(fmtAmt(g.target, g.unit))}</small></div>
    <div class="track"><div class="fill" style="width:${pct}%"></div></div>
    ${pace}
    <div class="foot">
      <span class="who">${g.linked ? `From the spreadsheet${g.sheet_at ? ` · updated ${esc(fmtTime(g.sheet_at))}` : ' · waiting for the first read'}` : last ? `Last: ${esc(last.staff_name)} +${esc(fmtAmt(last.amount, g.unit))}` : 'Nothing logged yet'}</span>
      ${canSign && !g.linked ? `<button class="small ${met ? 'green' : ''}" onclick="openSign('goal', ${g.id})">+ Log</button>` : ''}
    </div>
  </div>`;
};

const readByHtml = a => a.acks.length ? `<b>Read by:</b> ${a.acks.map(x => esc(x.staff_name)).join(', ')}` : '';
// Who posted it (a name, not the generic "Manager"), for "Announcement from Harold" / "Task from Jason".
const fromName = n => { n = String(n || '').trim(); return n && !/^manager(ment)?$/i.test(n) ? n : ''; };
const fromLine = (what, n) => fromName(n) ? `<div class="mini" style="margin-bottom:2px">${what} from <b>${esc(fromName(n))}</b></div>` : '';
const annCard = canSign => a => `<div class="ann ${a.pinned ? 'pinned' : ''}" data-ann="${a.id}">
  ${fromLine('Announcement', a.created_by)}
  <div class="head">
    ${a.pinned ? '<span class="chip pin">Pinned</span>' : ''}
    ${a.title ? `<span class="title">${esc(a.title)}</span>` : ''}
    ${a.source === 'sms' ? '<span class="chip sms">Texted in</span>' : ''}
  </div>
  <div class="text">${esc(a.body)}</div>
  ${a.media_url ? `<a href="${attr(a.media_url)}" target="_blank" rel="noopener"><img class="media" src="${attr(a.media_url)}" alt="" loading="lazy" onerror="this.style.display='none'"></a>` : ''}
  <div class="foot">
    <span>${esc(a.created_by || 'Management')} · ${esc(fmtStamp(a.created_at))}${a.expires_on ? ` · until ${esc(fmtShort(a.expires_on))}` : ''}</span>
    <span class="acks">${readByHtml(a)}</span>
    ${canSign && !data.me ? `<button class="mini-btn" onclick="openSign('announcement', ${a.id})">✓ I've read this</button>` : ''}
  </div>
</div>`;

// Someone signed in with their own PIN needn't tap anything: an announcement that has been on
// their screen for a couple of seconds is marked read for them.
let annObserver = null, annQueue = new Set(), annFlush = null;
const annTimers = new Map();
function watchAnnouncements() {
  if (annObserver) annObserver.disconnect();
  for (const t of annTimers.values()) clearTimeout(t);
  annTimers.clear();
  if (!data.me || data.me.skip_ann || !('IntersectionObserver' in window)) return;   // exempt people aren't tracked as readers
  const meName = String(data.me.name).toLowerCase();
  const todo = new Set(data.announcements.filter(a => !a.acks.some(x => String(x.staff_name).toLowerCase() === meName)).map(a => a.id));
  if (!todo.size) return;
  annObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      const id = Number(e.target.dataset.ann);
      const seen = e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= window.innerHeight * 0.4);
      if (seen && !annTimers.has(id)) annTimers.set(id, setTimeout(() => { annTimers.delete(id); if (document.visibilityState === 'visible') markRead(id); }, 2000));
      else if (!seen && annTimers.has(id)) { clearTimeout(annTimers.get(id)); annTimers.delete(id); }
    }
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  for (const el of $app.querySelectorAll('.ann[data-ann]')) if (todo.has(Number(el.dataset.ann))) annObserver.observe(el);
}
function markRead(id) {
  annQueue.add(id); clearTimeout(annFlush);
  annFlush = setTimeout(async () => {
    const ids = [...annQueue]; annQueue = new Set();
    const out = await api('/api/board/read', { ids });
    if (out.error || !data || !data.me) return;
    for (const a of data.announcements) {
      if (!ids.includes(a.id)) continue;
      if (!a.acks.some(x => x.staff_name === data.me.name)) a.acks.push({ staff_name: data.me.name, signed_at: new Date().toISOString() });
      const card = $app.querySelector(`.ann[data-ann="${a.id}"]`);
      if (card) { card.querySelector('.acks').innerHTML = readByHtml(a); if (annObserver) annObserver.unobserve(card); }
    }
  }, 400);
}

// Who a task is for, as a chip. Per-person tasks with one name behave like a normal row locked to that person.
function whoChip(t) {
  if (t.assign !== 'each') return '';
  if (!t.assignees.length) return '<span class="chip who">Everyone</span>';
  if (t.required.length === 1) { const p = data.staff.find(s => s.id === t.required[0]); return `<span class="chip who">${esc(p ? p.name : 'Assigned')}</span>`; }
  return '<span class="chip who">Each person</span>';
}
const taskRow = canSign => t => {
  if (t.assign === 'each' && t.required.length !== 1) return eachRow(canSign, t);
  const c = t.completion || t.completions[0] || null;
  const lock = t.assign === 'each' ? t.required[0] : 0;
  return `<div class="task ${c ? 'done' : ''}">
    <div class="box" ${!c && canSign ? `onclick="openSign('task', ${t.id}, ${lock})" title="Sign off"` : ''}>${c ? '✓' : ''}</div>
    <div class="body">
      <div class="title">${esc(t.title)} ${whoChip(t)}
        ${t.kind === 'weekly' && t.day_of_week != null ? `<span class="chip ${t.due_today ? 'due' : ''}">${t.due_today ? 'Due today' : 'Due ' + DOW_SHORT[t.day_of_week]}</span>` : ''}
        ${t.kind === 'once' ? '<span class="chip">One-time</span>' : ''}
        ${t.source === 'sms' ? '<span class="chip sms">Texted in</span>' : ''}
      </div>
      ${fromLine('Task', t.created_by)}
      ${t.detail ? `<div class="detail">${esc(t.detail)}</div>` : ''}
      ${c ? `<div class="signed">Signed off by ${esc(c.staff_name)} · ${esc(fmtStamp(c.signed_at))}
          ${c.signature_kind === 'drawn' ? `<img src="${attr(c.signature)}" alt="signature">` : `<span class="typed">${esc(c.signature)}</span>`}
          ${c.note ? `<span class="mini">“${esc(c.note)}”</span>` : ''}
          ${canSign ? `<button class="mini-btn danger" onclick="unsign(${c.id}, ${c.staff_id || 0}, '${attr(c.staff_name)}')">undo</button>` : ''}
        </div>` : ''}
    </div>
    ${!c && canSign ? `<div class="act"><button class="small" onclick="openSign('task', ${t.id}, ${lock})">Sign off</button></div>` : ''}
  </div>`;
};
// A task everyone (or several named people) must sign separately: one chip per person.
function eachRow(canSign, t) {
  const people = t.required.map(id => data.staff.find(s => s.id === id)).filter(Boolean);
  const n = people.filter(p => t.completions.some(c => c.staff_id === p.id)).length;
  return `<div class="task each ${t.done ? 'done' : ''}">
    <div class="box">${t.done ? '✓' : `<small>${n}/${people.length}</small>`}</div>
    <div class="body">
      <div class="title">${esc(t.title)} ${whoChip(t)}
        ${t.kind === 'weekly' && t.day_of_week != null ? `<span class="chip ${t.due_today ? 'due' : ''}">${t.due_today ? 'Due today' : 'Due ' + DOW_SHORT[t.day_of_week]}</span>` : ''}
        ${t.kind === 'once' ? '<span class="chip">One-time</span>' : ''}
        ${t.source === 'sms' ? '<span class="chip sms">Texted in</span>' : ''}
      </div>
      ${fromLine('Task', t.created_by)}
      ${t.detail ? `<div class="detail">${esc(t.detail)}</div>` : ''}
      <div class="people">
        ${people.map(p => { const c = t.completions.find(x => x.staff_id === p.id);
          return c ? `<span class="person done" title="Signed ${attr(fmtStamp(c.signed_at))}">✓ ${esc(p.name)}${canSign ? ` <button class="undo" onclick="unsign(${c.id}, ${p.id}, '${attr(p.name)}')" title="Undo">×</button>` : ''}</span>`
            : `<button class="person" ${canSign ? `onclick="openSign('task', ${t.id}, ${p.id})"` : 'disabled'}>${esc(p.name)}</button>`; }).join('')}
        ${!people.length ? '<span class="mini">Nobody on the roster yet — add people under Manager panel → Staff.</span>' : ''}
      </div>
    </div>
  </div>`;
}

// ---------- sign-off dialog with signature pad ----------
let padState = null; // { canvas, ctx, drawn, w, h }
let signPin = '', signWho = '';   // PIN-required sign-offs: step one's PIN and the name it belongs to, held only while the dialog is open
function closeModal() { $modal.innerHTML = ''; padState = null; signPin = ''; signWho = ''; }
window.closeModal = closeModal;

function staffPicker(id, allowed, preselect) {
  // PINs required: no name list — the PIN says who is signing.
  if (data.require_pin) return `<label>Your PIN</label><input class="inline" id="${id}_pin" type="password" inputmode="numeric" autocomplete="off" placeholder="Your personal PIN">`;
  if (!data.staff.length) return `<label>Your name</label><input class="inline" id="${id}_name" placeholder="Type your name" autocomplete="off">`;
  const list = allowed ? data.staff.filter(s => allowed.includes(s.id)) : data.staff;
  const pick = preselect || (list.some(s => s.id === lastStaff) ? lastStaff : 0);
  return `<label>Who's signing?</label>
    <select class="inline" id="${id}_staff" onchange="onStaffPick('${id}')">
      <option value="">Pick your name…</option>
      ${list.map(s => `<option value="${s.id}" data-pin="${s.has_pin ? 1 : 0}" ${s.id === pick ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select>
    <div id="${id}_pinwrap" style="display:none"><label>Your PIN</label><input class="inline" id="${id}_pin" type="password" inputmode="numeric" autocomplete="off" placeholder="4-digit PIN"></div>`;
}
window.onStaffPick = id => {
  const sel = document.getElementById(`${id}_staff`);
  if (!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const wrap = document.getElementById(`${id}_pinwrap`);
  if (wrap) wrap.style.display = opt && opt.dataset.pin === '1' ? 'block' : 'none';
};
function signerFields(id) {
  const out = {};
  const sel = document.getElementById(`${id}_staff`);
  if (sel) { out.staff_id = Number(sel.value) || 0; out.pin = (document.getElementById(`${id}_pin`) || {}).value || ''; }
  else if (data.require_pin) out.pin = (document.getElementById(`${id}_pin`) || {}).value || '';
  else out.staff_name = (document.getElementById(`${id}_name`) || {}).value || '';
  return out;
}

window.openSign = (kind, id, staffId = 0) => {
  let title = '', sub = '', extra = '', allowed = null;
  const noSig = kind === 'announcement' && data.require_pin;   // a read receipt is just the PIN
  if (kind === 'task') {
    const t = [...data.tasks_today, ...data.tasks_week].find(x => x.id === id);
    title = `Sign off: ${t.title}`; sub = t.kind === 'weekly' ? 'Counts for this whole week.' : `For ${fmtDay(viewDate)}.`;
    if (t.assign === 'each') { const signed = t.completions.map(c => c.staff_id); allowed = t.required.filter(x => !signed.includes(x)); sub += ' Each person signs for themselves.'; }
    extra = `<label>Note (optional)</label><input class="inline" id="sg_note" placeholder="Anything worth noting?" maxlength="500">`;
  } else if (kind === 'announcement') {
    const a = data.announcements.find(x => x.id === id);
    title = 'Mark as read'; sub = (a.title || a.body).slice(0, 140);
    if (data.require_pin) sub += ' — just your PIN, no signature needed.';
  } else {
    const g = data.goals.find(x => x.id === id);
    const mon = g.period === 'month', mname = mon ? new Date(g.month + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) : '';
    title = `Log progress: ${g.label}`; sub = `${mon ? mname + ': now' : 'Now'} at ${fmtAmt(g.actual, g.unit)} of ${fmtAmt(g.target, g.unit)}.`;
    extra = `<label>${mon ? (g.unit === 'dollars' ? 'How much revenue to add?' : 'How many units to add?') : 'How much to add?'}</label>
      <div style="display:flex;gap:8px;align-items:center">
        ${g.unit === 'dollars' ? '<span style="font-weight:800;font-size:20px">$</span>' : ''}
        <input class="inline" id="sg_amount" type="number" step="${g.unit === 'dollars' ? '0.01' : '1'}" inputmode="decimal" value="${g.unit === 'dollars' ? '' : '1'}" placeholder="${g.unit === 'dollars' ? '0.00' : '1'}" style="max-width:160px">
        <span class="mini">(a negative number corrects a mistake)</span>
      </div>
      <label>Note (optional)</label><input class="inline" id="sg_note" placeholder="e.g. what was sold, to whom" maxlength="500">`;
  }
  // PINs required: step one is just the PIN; step two recaps who is signing and takes the note + signature.
  const twoStep = data.require_pin && kind !== 'announcement';
  if (twoStep && !signPin) {
    $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal">
      <h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p>
      <form onsubmit="signContinue('${kind}', ${id}); return false">
        ${staffPicker('sg', allowed, staffId)}
        <div class="err" id="sg_err"></div>
        <div class="row"><button type="button" class="small ghost" onclick="closeModal()">Cancel</button><button type="submit" class="small green" id="sg_go">Continue</button></div>
      </form>
    </div></div>`;
    document.getElementById('sg_pin').focus();
    return;
  }
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal">
    <h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p>
    ${twoStep ? `<div class="notice" style="margin:0 0 4px">Signing as <b>${esc(signWho)}</b> · <a href="#" onclick="signBack('${kind}', ${id}); return false">not you?</a></div>` : staffPicker('sg', allowed, staffId)}
    ${extra}
    ${noSig ? '' : `<label>Signature</label>${padHtml()}`}
    <div class="err" id="sg_err"></div>
    <div class="row"><button class="small ghost" onclick="closeModal()">Cancel</button><button class="small green" id="sg_go" onclick="submitSign('${kind}', ${id})">${noSig ? 'Mark as read' : 'Confirm &amp; sign'}</button></div>
  </div></div>`;
  onStaffPick('sg');
  if (!noSig) initPad(document.getElementById('sg_pad'));
  const first = document.getElementById('sg_amount') || document.getElementById('sg_name') || document.getElementById('sg_pin') || document.getElementById('sg_note');
  if (first) first.focus();
};
// Step one done: the server says whose PIN that is (and whether they can sign this); on to the recap screen.
window.signContinue = async (kind, id) => {
  const err = document.getElementById('sg_err'), go = document.getElementById('sg_go');
  const pin = ((document.getElementById('sg_pin') || {}).value || '').trim();
  if (!pin) { err.textContent = 'Enter your PIN.'; return; }
  go.disabled = true; err.textContent = '';
  const out = await api('/api/board/whoami', { pin, kind, id, date: viewDate });
  go.disabled = false;
  if (out.error) { err.textContent = out.error; document.getElementById('sg_pin').select(); return; }
  signPin = pin; signWho = out.name;
  openSign(kind, id);
};
window.signBack = (kind, id) => { signPin = ''; signWho = ''; openSign(kind, id); };

function padHtml() {
  return `<div id="sg_padwrap">
      <div class="pad"><canvas id="sg_pad"></canvas><div class="line"></div><div class="hint">Sign with your finger or mouse</div></div>
      <div class="padbar"><button class="mini-btn" type="button" onclick="padClear()">Clear</button><button class="mini-btn" type="button" onclick="padTyped(true)">Type it instead</button></div>
    </div>
    <div id="sg_typedwrap" style="display:none">
      <input class="inline typed" id="sg_typed" placeholder="Type your full name" maxlength="120" autocomplete="off">
      <div class="padbar"><span class="mini">Typed signatures are recorded with the time and device.</span><button class="mini-btn" type="button" onclick="padTyped(false)">Draw instead</button></div>
    </div>`;
}
function initPad(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
  padState = { canvas, ctx, drawn: false, w, h };
  let drawing = false, last = null;
  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', e => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; padState.drawn = true;
    const hint = canvas.parentElement.querySelector('.hint'); if (hint) hint.style.display = 'none';
    e.preventDefault();
  });
  const stop = () => { drawing = false; last = null; };
  canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop); canvas.addEventListener('pointerleave', stop);
}
window.padClear = () => {
  if (!padState) return;
  padState.ctx.clearRect(0, 0, padState.w, padState.h); padState.drawn = false;
  const hint = padState.canvas.parentElement.querySelector('.hint'); if (hint) hint.style.display = '';
};
window.padTyped = typed => {
  document.getElementById('sg_padwrap').style.display = typed ? 'none' : '';
  document.getElementById('sg_typedwrap').style.display = typed ? '' : 'none';
  if (typed) document.getElementById('sg_typed').focus();
};
function readSignature() {
  const typedOn = document.getElementById('sg_typedwrap').style.display !== 'none';
  if (typedOn) return document.getElementById('sg_typed').value.trim();
  if (!padState || !padState.drawn) return '';
  // Crop to the drawn strokes so the stored PNG stays small.
  const { canvas } = padState;
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++)
    if (img[(y * canvas.width + x) * 4 + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX <= minX || maxY <= minY) return '';
  const pad = 8, out = document.createElement('canvas');
  out.width = maxX - minX + pad * 2; out.height = maxY - minY + pad * 2;
  const octx = out.getContext('2d');
  octx.fillStyle = '#fff'; octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(canvas, minX - pad, minY - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
window.submitSign = async (kind, id) => {
  const err = document.getElementById('sg_err'), go = document.getElementById('sg_go');
  const noSig = kind === 'announcement' && data.require_pin;
  const signature = noSig ? '' : readSignature();
  if (!noSig && !signature) { err.textContent = 'Add your signature first.'; return; }
  const body = { kind, id, date: viewDate, signature, ...signerFields('sg') };
  if (signPin) body.pin = signPin;   // typed in step one
  if (data.require_pin) { if (!body.pin) { err.textContent = 'Enter your PIN.'; return; } }
  else if (data.staff.length && !body.staff_id) { err.textContent = 'Pick your name.'; return; }
  const noteEl = document.getElementById('sg_note'); if (noteEl) body.note = noteEl.value.trim();
  const amtEl = document.getElementById('sg_amount'); if (amtEl) body.amount = Number(amtEl.value);
  go.disabled = true; err.textContent = '';
  const out = await api('/api/board/sign', body);
  go.disabled = false;
  if (out.error) { err.textContent = out.error; return; }
  if (body.staff_id) { lastStaff = body.staff_id; localStorage.setItem('db_me', String(lastStaff)); }
  closeModal();
  await loadBoard();
};

window.unsign = (completionId, staffId, staffName) => {
  if (data.is_manager) {
    if (!confirm(`Clear this sign-off by ${staffName}?`)) return;
    return api('/api/board/unsign', { completion_id: completionId }).then(out => { if (out.error) alert(out.error); return loadBoard(); });
  }
  const s = data.staff.find(x => x.id === staffId);
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal">
    <h3>Undo sign-off</h3><p class="sub">Only ${esc(staffName)} (or a manager) can clear this.</p>
    ${data.require_pin ? `<label>Your PIN</label><input class="inline" id="un_pin" type="password" inputmode="numeric" autocomplete="off">`
      : s && s.has_pin ? `<label>${esc(staffName)}'s PIN</label><input class="inline" id="un_pin" type="password" inputmode="numeric" autocomplete="off">` : ''}
    <div class="err" id="un_err"></div>
    <div class="row"><button class="small ghost" onclick="closeModal()">Cancel</button>
      <button class="small danger" onclick="submitUnsign(${completionId}, ${staffId})">Clear sign-off</button></div>
  </div></div>`;
  const p = document.getElementById('un_pin'); if (p) p.focus();
};
window.submitUnsign = async (completionId, staffId) => {
  const pin = (document.getElementById('un_pin') || {}).value || '';
  const out = await api('/api/board/unsign', { completion_id: completionId, staff_id: staffId, pin });
  if (out.error) { document.getElementById('un_err').textContent = out.error; return; }
  closeModal(); await loadBoard();
};

// ---------- manager panel ----------
window.managerPrompt = () => {
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal">
    <h3>Manager sign-in</h3><p class="sub">Enter the manager PIN to edit goals, tasks, announcements, and staff.</p>
    <form onsubmit="managerPromptGo(); return false">
      <label>Manager PIN</label><input class="inline" id="mp_pin" type="password" inputmode="numeric" autocomplete="current-password">
      <div class="err" id="mp_err"></div>
      <div class="row"><button type="button" class="small ghost" onclick="closeModal()">Cancel</button><button type="submit" class="small">Sign in</button></div>
    </form></div></div>`;
  document.getElementById('mp_pin').focus();
};
window.managerPromptGo = async () => { if (await managerLogin('mp')) { closeModal(); await openManager(); } };
window.openManager = async () => {
  const out = await api('/api/manager/overview');
  if (out.error) { alert(out.error); return; }
  mgr = out; stopTimers(); renderManager();
};
window.closeManager = async () => { mgr = null; await loadBoard(); };
window.mgrTabTo = t => { mgrTab = t; renderManager(); };
window.setMgrName = v => { mgrName = v.trim(); localStorage.setItem('db_mgr_name', mgrName); };
async function reloadMgr() {
  const out = await api('/api/manager/overview');
  if (out.status === 401) { mgr = null; mgrToken = ''; localStorage.removeItem('db_mgr_token'); return loadBoard(); }
  if (!out.error) mgr = out;
  renderManager();
}

function renderManager() {
  const tabs = [['goals', 'Goals'], ['tasks', 'Tasks'], ['announcements', 'Announcements'], ['staff', 'Staff'], ['sms', 'Text-in'], ['activity', 'Activity'], ['highlights', 'Highlights'], ['evals', 'Past evaluations'], ['branding', 'Branding'], ['settings', 'Settings']];
  document.getElementById('topRight').textContent = 'Manager panel'; syncRefreshBtn();
  $app.innerHTML = `
    <div class="bar">
      <div class="date"><small>Manager panel</small>${esc(mgr.branding.business_name || 'Daily Board')}</div>
      <input class="inline" value="${attr(mgrName)}" placeholder="Your name (shown on posts)" onchange="setMgrName(this.value)" style="max-width:220px">
      <div class="spacer"></div>
      <button class="small ghost" onclick="closeManager()">‹ Back to the board</button>
      <button class="mini-btn" onclick="managerLogout()">Sign out</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${mgrTab === k ? 'on' : ''}" onclick="mgrTabTo('${k}')">${l}</button>`).join('')}</div>
    <div class="panel">${({ goals: mgrGoals, tasks: mgrTasks, announcements: mgrAnns, staff: mgrStaff, sms: mgrSms, activity: mgrActivity, highlights: mgrHighlights, evals: mgrEvals, branding: mgrBranding, settings: mgrSettings })[mgrTab]()}</div>`;
  if (mgrTab === 'branding') brandPreview();
}

const onoff = a => a ? '' : '<span class="chip">Off</span>';

function mgrGoals() {
  const todays = mgr.goals.filter(g => g.period !== 'month' && g.date === mgr.today);
  const monthStart = mgr.today.slice(0, 7) + '-01', thisMonth = mgr.goals.filter(g => g.period === 'month' && g.date === monthStart);
  const monthName = new Date(monthStart + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return `<p class="kicker-note">Recurring goals copy onto every new day — or, for a <b>monthly</b> goal (e.g. units or revenue for the month), onto every new month — automatically. This month's and today's copies are listed below; edit one there to change just that period.</p>
    <div class="tools"><b>Recurring goals</b><div class="spacer"></div><button class="small" onclick="editGoalTemplate()">+ Add recurring goal</button></div>
    <table class="list"><tr><th>Goal</th><th>Unit</th><th>Repeats</th><th>Target</th><th></th></tr>
      ${mgr.goal_templates.map(t => `<tr class="${t.active ? '' : 'off'}"><td>${esc(t.label)} ${onoff(t.active)}${t.sheet_map ? ' <span class="chip sms">spreadsheet</span>' : ''}</td><td>${t.unit}</td><td>${t.period === 'month' ? 'every month' : 'every day'}</td><td>${esc(fmtAmt(t.target, t.unit))} <span class="mini">${t.period === 'month' ? 'per month' : 'per day'}</span></td>
        <td class="acts"><button class="mini-btn" onclick="editGoalTemplate(${t.id})">Edit</button> <button class="mini-btn danger" onclick="delGoalTemplate(${t.id})">Delete</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="empty">None yet — add things like "Units sold", "New accounts", "Revenue"…</td></tr>'}
    </table>
    <div class="tools" style="margin-top:22px"><b>This month's goals (${esc(monthName)})</b></div>
    <table class="list"><tr><th>Goal</th><th>Unit</th><th>Month target</th><th></th></tr>
      ${thisMonth.map(g => `<tr><td>${esc(g.label)}</td><td>${g.unit}</td><td>${esc(fmtAmt(g.target, g.unit))}</td>
        <td class="acts"><button class="mini-btn" onclick="editGoalDay(${g.id})">Edit</button> <button class="mini-btn danger" onclick="delGoalDay(${g.id})">Remove</button></td></tr>`).join('')
        || '<tr><td colspan="4" class="empty">No monthly goals. Add a recurring goal and set it to repeat every month.</td></tr>'}
    </table>
    <div class="tools" style="margin-top:22px"><b>Imported daily targets</b><span class="mini">e.g. last year's revenue by day, +5% — overrides the daily target on each date it covers.</span><div class="spacer"></div><button class="small" onclick="importSchedule()">Import from last year…</button></div>
    <table class="list"><tr><th>Goal</th><th>Days covered</th><th>From</th><th>To</th><th></th></tr>
      ${mgr.goal_schedule.map(s => { const t = mgr.goal_templates.find(x => x.id === s.template_id) || { label: '?' };
        return `<tr><td>${esc(t.label)}</td><td>${s.days} <span class="mini">(${s.days_ahead} from today)</span></td><td>${esc(fmtShort(s.from_date))}</td><td>${esc(fmtShort(s.to_date))}</td>
        <td class="acts"><button class="mini-btn" onclick="importSchedule(${s.template_id})">Replace</button> <button class="mini-btn danger" onclick="clearSchedule(${s.template_id})">Clear</button></td></tr>`; }).join('')
        || '<tr><td colspan="5" class="empty">Nothing imported. Add a recurring goal first, then import a list of dates and amounts.</td></tr>'}
    </table>
    <div class="tools" style="margin-top:22px"><b>Today's goals (${esc(fmtShort(mgr.today))})</b><div class="spacer"></div><button class="small ghost" onclick="editGoalDay()">+ One-time goal for a day</button></div>
    <table class="list"><tr><th>Goal</th><th>Unit</th><th>Target</th><th>Source</th><th></th></tr>
      ${todays.map(g => `<tr><td>${esc(g.label)}</td><td>${g.unit}</td><td>${esc(fmtAmt(g.target, g.unit))}${g.baseline != null ? ` <span class="mini">(LY ${esc(fmtAmt(g.baseline, g.unit))})</span>` : ''}</td><td class="mini">${g.source}</td>
        <td class="acts"><button class="mini-btn" onclick="editGoalDay(${g.id})">Edit</button> <button class="mini-btn danger" onclick="delGoalDay(${g.id})">Remove</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="empty">Nothing for today yet (recurring goals appear the first time the board is opened today).</td></tr>'}
    </table>`;
}
window.editGoalTemplate = id => {
  const t = mgr.goal_templates.find(x => x.id === id) || { label: '', unit: 'count', period: 'day', target: 0, sort: mgr.goal_templates.length + 1, active: 1 };
  const sm = (() => { try { return JSON.parse(t.sheet_map || '{}'); } catch { return {}; } })();   // where this goal looks in the spreadsheet
  formModal(id ? 'Edit recurring goal' : 'New recurring goal', [
    { k: 'label', l: 'Goal', v: t.label, ph: 'e.g. Units sold' },
    { k: 'unit', l: 'Unit', v: t.unit, type: 'select', opts: [['count', 'Units / count (e.g. 5 sales)'], ['dollars', 'Revenue — dollars ($)']] },
    { k: 'period', l: 'Repeats', v: t.period || 'day', type: 'select', opts: [['day', 'Every day — a new target each day'], ['month', 'Every month — one target for the whole month']] },
    { k: 'target', l: 'Target (per day, or per month for a monthly goal)', v: t.target, type: 'number' },
    { k: 'sheet_on', l: 'Fill the actual from the spreadsheet?', v: t.sheet_map ? '1' : '0', type: 'select', opts: [['0', 'No — people log it on the board'], ['1', 'Yes — the spreadsheet is the truth (link it under Settings; logging is turned off)']] },
    { k: 'sheet_tab', l: 'Spreadsheet tab (blank = the first tab)', v: sm.tab || '' },
    { k: 'sheet_mode', l: 'Layout', v: sm.mode || 'rows', type: 'select', opts: [['rows', 'A row per day — add up this month\'s rows (or today\'s row, for a daily goal)'], ['cell', 'One cell holds the number']] },
    { k: 'sheet_date_col', l: 'Date column (a letter, e.g. A)', v: sm.dateCol || '' },
    { k: 'sheet_value_col', l: 'Value column (a letter, e.g. C)', v: sm.valueCol || '' },
    { k: 'sheet_first_row', l: 'First data row (skips the header)', v: sm.firstRow || 2, type: 'number' },
    { k: 'sheet_cell', l: 'Cell, for the one-cell layout (e.g. D2)', v: sm.cell || '' },
    { k: 'sort', l: 'Order', v: t.sort, type: 'number' },
    { k: 'active', l: 'Active', v: t.active ? '1' : '0', type: 'select', opts: [['1', 'Yes — on the board every day'], ['0', 'No — paused']] },
  ], f => api('/api/manager/goal-template', { id, ...f, active: f.active === '1' }));
};
window.delGoalTemplate = async id => { if (confirm('Delete this recurring goal? Past days keep their numbers.')) { await api('/api/manager/goal-template', { id, remove: true }); reloadMgr(); } };
window.editGoalDay = id => {
  const g = mgr.goals.find(x => x.id === id) || { date: mgr.today, label: '', unit: 'count', target: 0 };
  formModal(id ? (g.period === 'month' ? `Edit ${new Date(g.date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} goal` : `Edit goal for ${fmtShort(g.date)}`) : 'One-time goal', [
    ...(id ? [] : [{ k: 'date', l: 'Day', v: g.date, type: 'date' }]),
    { k: 'label', l: 'Goal', v: g.label },
    { k: 'unit', l: 'Unit', v: g.unit, type: 'select', opts: [['count', 'Count'], ['dollars', 'Dollars ($)']] },
    { k: 'target', l: 'Target', v: g.target, type: 'number' },
  ], f => api('/api/manager/goal', { id, ...f }));
};
// Import dialog: paste or upload last year's numbers, pick how dates map onto this year, preview, import.
let schedTimer = null;
window.importSchedule = templateId => {
  const tpls = mgr.goal_templates.filter(t => t.active && t.period !== 'month');
  if (!tpls.length) return alert('Add a daily recurring goal first (e.g. "Revenue", dollars), then import its schedule. Imported targets are per day, so monthly goals don\'t use them.');
  const has = id => mgr.goal_schedule.some(s => s.template_id === id);
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal" style="max-width:640px">
    <h3>Import daily targets</h3>
    <p class="sub">Paste or upload last year's numbers — one date and one amount per line (a POS or spreadsheet export works as-is; header and total lines are skipped).</p>
    <label>Which goal</label>
    <select class="inline" id="sc_tpl" onchange="schedPreview()">${tpls.map(t => `<option value="${t.id}" ${t.id === templateId ? 'selected' : ''}>${esc(t.label)} (${t.unit})</option>`).join('')}</select>
    <label>Last year's numbers</label>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <input type="file" id="sc_file" accept=".csv,.txt,.tsv,text/csv,text/plain" style="display:none" onchange="schedFile(this)">
      <button type="button" class="small ghost" onclick="document.getElementById('sc_file').click()">Upload CSV…</button><span class="mini">or paste below</span>
    </div>
    <textarea class="inline" id="sc_text" style="min-height:120px;font-family:ui-monospace,Menlo,monospace;font-size:13px" placeholder="9/17/2025, $1,450.00&#10;9/18/2025, $1,210.50&#10;…" oninput="schedPreviewSoon()"></textarea>
    <label>Those dates are…</label>
    <select class="inline" id="sc_shift" onchange="schedPreview()">
      <option value="year">last year's — use the same calendar date this year (+1 year)</option>
      <option value="52w">last year's — use the same weekday this year (+52 weeks)</option>
      <option value="none">already this year's dates — use as-is</option>
    </select>
    <label>Goal = last year's number plus</label>
    <div style="display:flex;gap:8px;align-items:center"><input class="inline" id="sc_uplift" type="number" step="0.5" value="5" style="max-width:120px" oninput="schedPreviewSoon()"><b>%</b><span class="mini">(0 = match last year, negative to aim lower)</span></div>
    <label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink)"><input type="checkbox" id="sc_replace" ${has(Number(templateId)) ? 'checked' : ''}> Replace this goal's existing imported dates (unchecked = add / update only the dates in this file)</label>
    <div id="sc_preview" class="notice" style="margin-top:12px">Paste or upload to see a preview.</div>
    <div class="err" id="sc_err"></div>
    <div class="row"><button class="small ghost" onclick="closeModal()">Cancel</button><button class="small green" id="sc_go" onclick="schedImport()" disabled>Import</button></div>
  </div></div>`;
};
window.schedFile = input => {
  const f = input.files && input.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => { document.getElementById('sc_text').value = r.result; schedPreview(); }; r.readAsText(f);
  input.value = '';
};
window.schedPreviewSoon = () => { clearTimeout(schedTimer); schedTimer = setTimeout(schedPreview, 400); };
function schedBody(extra) {
  return { template_id: Number(document.getElementById('sc_tpl').value), text: document.getElementById('sc_text').value,
    shift: document.getElementById('sc_shift').value, uplift: Number(document.getElementById('sc_uplift').value) || 0,
    replace: document.getElementById('sc_replace').checked, ...extra };
}
window.schedPreview = async () => {
  const pv = document.getElementById('sc_preview'), go = document.getElementById('sc_go');
  if (!pv) return;
  if (!document.getElementById('sc_text').value.trim()) { pv.textContent = 'Paste or upload to see a preview.'; go.disabled = true; return; }
  const out = await api('/api/manager/goal-schedule', schedBody({ dry_run: true }));
  if (out.error) { pv.textContent = out.error; go.disabled = true; return; }
  const s = out.summary, unit = (mgr.goal_templates.find(t => t.id === Number(document.getElementById('sc_tpl').value)) || {}).unit;
  pv.innerHTML = `<b>${s.rows} day${s.rows === 1 ? '' : 's'}</b> from ${esc(fmtShort(s.from))} to ${esc(fmtShort(s.to))}${s.skipped ? ` · ${s.skipped} line${s.skipped === 1 ? '' : 's'} skipped` : ''}${s.past ? ` · ${s.past} in the past (kept for the record, not shown as goals)` : ''}.
    ${s.sample.length ? '<br>' + s.sample.map(r => `${esc(fmtShort(r.date))}: LY ${esc(fmtAmt(r.baseline, unit))} → goal <b>${esc(fmtAmt(r.target, unit))}</b>`).join(' · ') : ''}`;
  go.disabled = false;
};
window.schedImport = async () => {
  const go = document.getElementById('sc_go'); go.disabled = true;
  const out = await api('/api/manager/goal-schedule', schedBody({}));
  if (out.error) { document.getElementById('sc_err').textContent = out.error; go.disabled = false; return; }
  closeModal(); await reloadMgr();
};
window.clearSchedule = async templateId => {
  if (!confirm('Remove every imported target for this goal? Days go back to the goal\'s normal daily target.')) return;
  await api('/api/manager/goal-schedule', { template_id: templateId, clear: true }); reloadMgr();
};
window.delGoalDay = async id => { if (confirm('Remove this goal from the day (and anything logged toward it)?')) { await api('/api/manager/goal', { id, remove: true }); reloadMgr(); } };

function mgrTasks() {
  const st = {}; for (const s of mgr.task_state || []) st[s.id] = s;
  const kindLabel = { daily: 'Daily', weekly: 'Weekly', once: 'One-time' };
  const row = (t, mode) => { const s = st[t.id];
    return `<tr class="${t.active ? '' : 'off'}"><td>${esc(t.title)} ${onoff(t.active)}${t.detail ? `<div class="mini">${esc(t.detail)}</div>` : ''}</td>
      <td class="mini">${kindLabel[t.kind] || t.kind}${t.kind === 'weekly' ? ' · ' + (t.day_of_week != null ? DOW_SHORT[t.day_of_week] : 'any day') : t.kind === 'once' ? ' · ' + esc(fmtShort(t.due_date)) : ''}</td>
      <td class="mini">${esc(whoLabel(t))}</td>
      <td class="mini">${mode === 'done' ? `✓ ${esc((s.by || []).join(', ') || 'done')}` : mode === 'todo' && s && s.by.length ? `${s.by.length} of ${s.needs} signed: ${esc(s.by.join(', '))}` : mode === 'other' ? (t.active ? 'Not on today\'s board' : 'Switched off') : '—'}</td>
      <td class="mini">${esc(t.created_by)}${t.source === 'sms' ? ' <span class="chip sms">text</span>' : ''}</td>
      <td class="acts"><button class="mini-btn" onclick="editTask(${t.id})">Edit</button> <button class="mini-btn danger" onclick="delTask(${t.id})">Delete</button></td></tr>`; };
  const table = (rows, mode, empty) => `<table class="list"><tr><th>Task</th><th>Type</th><th>Who</th><th>${mode === 'done' ? 'Done by' : mode === 'todo' ? 'Progress' : 'Status'}</th><th>By</th><th></th></tr>
      ${rows.map(t => row(t, mode)).join('') || `<tr><td colspan="6" class="empty">${empty}</td></tr>`}</table>`;
  const onBoard = mgr.tasks.filter(t => t.active && st[t.id]);
  const todo = onBoard.filter(t => !st[t.id].done), done = onBoard.filter(t => st[t.id].done), other = mgr.tasks.filter(t => !(t.active && st[t.id]));
  return `<div class="tools"><div class="spacer"></div><button class="small" onclick="editTask()">+ Add task</button></div>
    <p class="kicker-note">Today's board, split by what's still open and what's finished. Daily tasks reset each day, weekly tasks each week.</p>
    <div class="tools" style="margin-top:14px"><b>Not completed</b><span class="mini">${todo.length} still open today</span></div>
    ${table(todo, 'todo', 'Everything on today\'s board is done ✓')}
    <div class="tools" style="margin-top:18px"><b>Completed</b><span class="mini">${done.length} done (the Activity tab keeps the full history with signatures)</span></div>
    ${table(done, 'done', 'Nothing completed yet today.')}
    <div class="tools" style="margin-top:18px"><b>Not on today's board</b><span class="mini">One-time tasks for other days, and switched-off tasks</span></div>
    ${table(other, 'other', 'None.')}`;
}
function mgrTasksByKind() {
  const groups = [['daily', 'Daily tasks', 'Reset every day.'], ['weekly', 'Weekly tasks', 'Signed once per week (Mon–Sun); optionally due on a weekday.'], ['once', 'One-time tasks', 'Show up on one day only — this is where texted-in TASKs land.']];
  return `<div class="tools"><div class="spacer"></div><button class="small" onclick="editTask()">+ Add task</button></div>
    ${groups.map(([kind, title, note]) => {
      const rows = mgr.tasks.filter(t => t.kind === kind);
      return `<div class="tools" style="margin-top:14px"><b>${title}</b><span class="mini">${note}</span></div>
      <table class="list"><tr><th>Task</th><th>Who</th><th>${kind === 'weekly' ? 'Due' : kind === 'once' ? 'Day' : ''}</th><th>By</th><th></th></tr>
        ${rows.map(t => `<tr class="${t.active ? '' : 'off'}"><td>${esc(t.title)} ${onoff(t.active)}${t.detail ? `<div class="mini">${esc(t.detail)}</div>` : ''}</td>
          <td class="mini">${esc(whoLabel(t))}</td>
          <td>${kind === 'weekly' ? (t.day_of_week != null ? DOW_SHORT[t.day_of_week] : 'Any day') : kind === 'once' ? esc(fmtShort(t.due_date)) : ''}</td>
          <td class="mini">${esc(t.created_by)}${t.source === 'sms' ? ' <span class="chip sms">text</span>' : ''}</td>
          <td class="acts"><button class="mini-btn" onclick="editTask(${t.id})">Edit</button> <button class="mini-btn danger" onclick="delTask(${t.id})">Delete</button></td></tr>`).join('')
          || `<tr><td colspan="5" class="empty">None.</td></tr>`}
      </table>`; }).join('')}`;
}
function taskIds(t) { try { return JSON.parse(t.assignees || '[]').map(Number); } catch { return []; } }
function whoLabel(t) {
  if (t.assign !== 'each') return 'Anyone';
  const ids = taskIds(t);
  if (!ids.length) return 'Everyone (each signs)';
  return ids.map(id => (mgr.staff.find(s => s.id === id) || {}).name || '?').join(', ');
}
window.editTask = id => {
  const t = mgr.tasks.find(x => x.id === id) || { kind: 'daily', title: '', detail: '', day_of_week: '', due_date: mgr.today, sort: 0, active: 1, assign: 'anyone', assignees: '[]' };
  const ids = taskIds(t), who = t.assign === 'each' ? (ids.length ? 'people' : 'everyone') : 'anyone';
  const roster = mgr.staff.filter(s => s.active);
  formModal(id ? 'Edit task' : 'New task', [
    { k: 'title', l: 'Task', v: t.title, ph: 'e.g. Wipe down the counters' },
    { k: 'detail', l: 'Details (optional)', v: t.detail, type: 'textarea' },
    { k: 'who', l: 'Who does this?', v: who, type: 'select', opts: [['anyone', 'Anyone on the team — one sign-off'], ['people', 'Specific people — each signs off'], ['everyone', 'Everyone — each person signs off']] },
    { k: 'assignees', l: 'People (for "specific people")', v: ids.map(String), type: 'checks', opts: roster.map(s => [String(s.id), s.name]), hint: roster.length ? '' : 'Add people under Staff first.' },
    ...(id ? [] : [{ k: 'notify', l: 'Text them about it', v: '1', type: 'select', opts: [['1', mgr.settings.sms_outbound ? 'Yes — text each person on this task now' : 'Yes (needs outbound texting set up — see Text-in)'], ['0', 'No']] }]),
    { k: 'kind', l: 'Repeats', v: t.kind, type: 'select', opts: [['daily', 'Every day'], ['weekly', 'Once a week'], ['once', 'Just once (one day)']] },
    { k: 'day_of_week', l: 'Weekly: due on', v: t.day_of_week ?? '', type: 'select', opts: [['', 'Any day that week'], ...DOW.map((d, i) => [String(i), d])] },
    { k: 'due_date', l: 'One-time: which day', v: t.due_date || mgr.today, type: 'date' },
    { k: 'sort', l: 'Order', v: t.sort, type: 'number' },
    { k: 'active', l: 'Active', v: t.active ? '1' : '0', type: 'select', opts: [['1', 'Yes'], ['0', 'No — hidden']] },
  ], f => {
    if (f.who === 'people' && !(f.assignees || []).length) return Promise.resolve({ error: 'Tick at least one person, or choose "Everyone".' });
    return api('/api/manager/task', { id, ...f, assign: f.who === 'anyone' ? 'anyone' : 'each', assignees: f.who === 'people' ? f.assignees : [],
      notify: f.notify !== '0', active: f.active === '1', created_by: mgrName });
  });
};
window.delTask = async id => { if (confirm('Delete this task and its sign-off history?')) { await api('/api/manager/task', { id, remove: true }); reloadMgr(); } };

function mgrAnns() {
  const days = mgr.settings.announce_days;
  const live = mgr.announcements.filter(a => a.on_board), archived = mgr.announcements.filter(a => !a.on_board);
  const why = a => ({ off: 'switched off', expired: 'expired', aged: `older than ${days} days` })[a.hidden_why] || 'hidden';
  const row = a => `<tr class="${a.on_board ? '' : 'off'}"><td>${a.pinned ? '<span class="chip pin">Pinned</span> ' : ''}${a.title ? `<b>${esc(a.title)}</b><br>` : ''}${esc(a.body).slice(0, 300)} ${a.on_board ? '' : `<span class="chip due">${esc(why(a))}</span>`}
      ${a.media_url ? `<div class="mini"><a href="${attr(a.media_url)}" target="_blank" rel="noopener">photo</a></div>` : ''}${a.expires_on ? `<div class="mini">until ${esc(fmtShort(a.expires_on))}</div>` : ''}
      <div class="mini"><b>Read by ${a.acks.length}:</b> ${a.acks.length ? a.acks.map(x => esc(x.staff_name)).join(', ') : 'nobody yet'}</div>
      ${a.unread && a.unread.length && a.on_board ? `<div class="mini"><b>Not read yet:</b> ${a.unread.map(esc).join(', ')}</div>` : ''}</td>
    <td class="mini">${esc(a.created_by)}${a.source === 'sms' ? ' <span class="chip sms">text</span>' : ''}<br>${esc(fmtStamp(a.created_at))}</td>
    <td class="acts"><button class="mini-btn" onclick="editAnn(${a.id})">Edit</button> <button class="mini-btn danger" onclick="delAnn(${a.id})">Delete</button></td></tr>`;
  return `<div class="tools"><div class="spacer"></div><button class="small" onclick="editAnn()">+ Post announcement</button></div>
    <p class="kicker-note">${days ? `Announcements leave the board on their own after <b>${days} day${days === 1 ? '' : 's'}</b> (pinned ones stay; a "Hide after" date on an announcement wins). Change it under Settings.` : 'Announcements stay on the board until you hide or delete them. You can make them leave on their own under Settings.'}
      Hidden ones are kept below with who read them.</p>
    <b>On the board</b>
    <table class="list"><tr><th>Announcement</th><th>Posted</th><th></th></tr>
      ${live.map(row).join('') || '<tr><td colspan="3" class="empty">Nothing on the board.</td></tr>'}
    </table>
    <b style="display:block;margin-top:18px">Archive — hidden from the board</b>
    <table class="list"><tr><th>Announcement</th><th>Posted</th><th></th></tr>
      ${archived.map(row).join('') || '<tr><td colspan="3" class="empty">Nothing archived yet.</td></tr>'}
    </table>`;
}
window.editAnn = id => {
  const a = mgr.announcements.find(x => x.id === id) || { title: '', body: '', media_url: '', pinned: 0, expires_on: '', active: 1 };
  formModal(id ? 'Edit announcement' : 'Post announcement', [
    { k: 'title', l: 'Headline (optional)', v: a.title },
    { k: 'body', l: 'Message', v: a.body, type: 'textarea' },
    { k: 'media_url', l: 'Image link (optional)', v: a.media_url, ph: 'https://…' },
    ...(id ? [] : [{ k: 'text_everyone', l: 'Text this to everyone', v: mgr.settings.sms_broadcast ? '1' : '0', type: 'select',
      opts: [['1', mgr.settings.sms_outbound ? 'Yes — text every person on the roster now' : 'Yes (needs outbound texting set up — see Text-in)'], ['0', 'No — board only']] }]),
    { k: 'pinned', l: 'Pin to the top', v: a.pinned ? '1' : '0', type: 'select', opts: [['0', 'No'], ['1', 'Yes']] },
    { k: 'expires_on', l: 'Hide after (optional)', v: a.expires_on || '', type: 'date' },
    { k: 'active', l: 'Visible', v: a.active ? '1' : '0', type: 'select', opts: [['1', 'Yes'], ['0', 'No — hidden']] },
  ], f => api('/api/manager/announcement', { id, ...f, pinned: f.pinned === '1', active: f.active === '1', created_by: mgrName, ...(id ? {} : { text_everyone: f.text_everyone === '1' }) }));
};
window.delAnn = async id => { if (confirm('Delete this announcement?')) { await api('/api/manager/announcement', { id, remove: true }); reloadMgr(); } };

function mgrStaff() {
  const pi = mgr.pin_issues || { missing: 0, shared: 0 };
  return `<p class="kicker-note">Everyone who signs things off on the board. Each person's own PIN is how they sign (and how they open the board as themselves on their phone) — it must be unique.
    Turn on <b>Require employee PIN to sign</b> under Settings once everyone has one.
    <b>Managers with a mobile number on file can post to the board by text.</b></p>
    ${pi.missing || pi.shared ? `<div class="notice warn">${pi.missing ? `${pi.missing} active ${pi.missing === 1 ? 'person has' : 'people have'} no PIN yet. ` : ''}${pi.shared ? `${pi.shared} ${pi.shared === 1 ? 'person has a PIN that is' : 'people have PINs that are'} shared or match the manager PIN / board password — give ${pi.shared === 1 ? 'them a new one' : 'them new ones'}.` : ''}</div>` : ''}
    <div class="tools"><div class="spacer"></div><button class="small" onclick="editStaff()">+ Add person</button></div>
    <p class="mini" style="margin:-6px 0 12px">Text opt-in page for staff (also what Twilio asks for as the opt-in policy): <code class="url">${esc(location.origin + '/sms.html')}</code></p>
    <table class="list"><tr><th>Name</th><th>Role</th><th>Phone</th><th>Texts</th><th>PIN</th><th></th></tr>
      ${mgr.staff.map(s => `<tr class="${s.active ? '' : 'off'}"><td>${esc(s.name)} ${onoff(s.active)}${s.skip_ann ? ' <span class="chip" title="Not tracked reading announcements">no reads</span>' : ''}${s.skip_tasks ? ' <span class="chip" title="Not part of tasks for everyone">no team tasks</span>' : ''}${s.n_ann === false || s.n_tasks === false || s.n_hl === false || (s.role === 'manager' && s.n_done === false) ? ' <span class="chip" title="Some notifications are turned off for this person">alerts off</span>' : ''}</td><td>${s.role}</td><td>${esc(s.phone)}</td>
        <td class="mini">${!s.phone ? '—' : s.sms_consent_at ? `<span class="chip sms">opted in</span> ${esc(fmtShort(String(s.sms_consent_at).slice(0, 10)))}` : 'added by manager'}</td><td>${s.pin_shared ? '<span class="chip due">shared</span>' : s.has_pin ? 'set' : s.active ? '<span class="chip due">none</span>' : '—'}</td>
        <td class="acts"><button class="mini-btn" onclick="editStaff(${s.id})">Edit</button> <button class="mini-btn danger" onclick="delStaff(${s.id})">Delete</button></td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">No one yet — until you add people, the board asks signers to type their name.</td></tr>'}
    </table>`;
}
window.editStaff = id => {
  const s = mgr.staff.find(x => x.id === id) || { name: '', role: 'employee', phone: '', active: 1 };
  formModal(id ? 'Edit person' : 'Add person', [
    { k: 'name', l: 'Name', v: s.name },
    { k: 'role', l: 'Role', v: s.role, type: 'select', opts: [['employee', 'Employee'], ['manager', 'Manager (can post by text)']] },
    { k: 'phone', l: 'Mobile number', v: s.phone, ph: '(555) 555-0100', hint: 'Managers text the board from this number.' },
    { k: 'pin', l: id ? 'New PIN (blank = keep current)' : 'PIN (4–8 digits, unique to this person)', v: '', type: 'password', ph: id && s.has_pin ? '••••' : '', gen: true,
      hint: 'Their personal PIN is how they sign things off. PINs are never shown again after saving — write it down for them, or reset it here.' },
    ...(id ? [{ k: 'clear_pin', l: 'Remove PIN', v: '0', type: 'select', opts: [['0', 'No'], ['1', 'Yes — no PIN needed']] }] : []),
    { k: 'n_ann', l: 'Notify: new announcements', v: s.n_ann === false ? '0' : '1', type: 'select', opts: [['1', 'Yes'], ['0', 'No — no notification or text']] },
    { k: 'n_tasks', l: 'Notify: tasks for them / for everyone', v: s.n_tasks === false ? '0' : '1', type: 'select', opts: [['1', 'Yes'], ['0', 'No — no notification or text']] },
    { k: 'n_hl', l: 'Notify: shift highlights & shoutouts', v: s.n_hl === false ? '0' : '1', type: 'select', opts: [['1', 'Yes'], ['0', 'No']] },
    ...(s.role === 'manager' ? [{ k: 'n_done', l: 'Notify: a task was completed (managers)', v: s.n_done === false ? '0' : '1', type: 'select', opts: [['1', 'Yes'], ['0', 'No']] }] : []),
    { k: 'skip_ann', l: 'Exempt from marking announcements read', v: s.skip_ann ? '1' : '0', type: 'select', opts: [['0', 'No — has to read them'], ['1', 'Yes — exempt']] },
    { k: 'skip_tasks', l: 'Exempt from tasks assigned to everyone', v: s.skip_tasks ? '1' : '0', type: 'select', opts: [['0', 'No — has to do them'], ['1', 'Yes — exempt (still gets tasks given to them by name)']] },
    { k: 'active', l: 'Active', v: s.active ? '1' : '0', type: 'select', opts: [['1', 'Yes'], ['0', 'No — hidden from the board']] },
  ], f => {
    const body = { id, name: f.name, role: f.role, phone: f.phone, active: f.active === '1', skip_ann: f.skip_ann === '1', skip_tasks: f.skip_tasks === '1', n_ann: f.n_ann !== '0', n_tasks: f.n_tasks !== '0', n_hl: f.n_hl !== '0' };
    if (f.n_done != null) body.n_done = f.n_done !== '0';
    if (f.clear_pin === '1') body.pin = ''; else if (f.pin) body.pin = f.pin;
    return api('/api/manager/staff', body);
  });
};
// Fill the PIN box with a random unused PIN, shown in the clear so the manager can pass it on.
window.genPin = async () => {
  const out = await api('/api/manager/staff/new-pin');
  const el = $modal.querySelector('[data-k="pin"]');
  if (out.pin && el) { el.type = 'text'; el.value = out.pin; }
  else if (out.error) document.getElementById('fm_err').textContent = out.error;
};
window.delStaff = async id => { if (confirm('Remove this person? Their past sign-offs keep their name.')) { await api('/api/manager/staff', { id, remove: true }); reloadMgr(); } };

function mgrSms() {
  const url = `${location.origin}/api/sms/inbound`;
  const s = mgr.settings;
  return `<p class="kicker-note">Managers can post to the board by text message. Get a number from an SMS provider (Twilio is what this is built for),
    point its incoming-message webhook at this site, and add each manager's mobile number under Staff.</p>
    <ol style="font-size:14px;line-height:1.7;margin:0 0 14px 18px">
      <li>In Twilio: Phone Numbers → your number → Messaging → <i>A message comes in</i> → Webhook, <b>HTTP POST</b>:<br><code class="url">${esc(url)}</code></li>
      <li>On the server, set <code>TWILIO_AUTH_TOKEN</code> (Twilio Console → Account Info) so only real Twilio posts are accepted.
        ${s.sms_secured ? '<span class="chip sms">Secured</span>' : '<span class="chip due">Not set yet</span>'}</li>
      <li>Announcements texted to everyone: ${s.sms_broadcast ? '<span class="chip sms">On</span>' : '<span class="chip">Off</span>'} (Settings). Photos ride along as MMS.</li>
      <li>Texting people about new tasks: ${s.sms_outbound ? '<span class="chip sms">On</span>' : '<span class="chip due">Not set up</span>'} — add <code>TWILIO_ACCOUNT_SID</code> (Console → Account Info) and <code>TWILIO_FROM</code> (this number, e.g. +12085550100) in Vercel and redeploy. Sends need the same registration as replies.</li>
      <li>Replies: ${s.sms_reply ? 'the board texts "Posted ✓" back — a US local number must be on an approved A2P 10DLC campaign in Twilio for those to deliver.' : '<b>off</b> — the board posts silently; nothing to register.'} Change under Settings.</li>
      <li>Under Staff, give each manager the Manager role and their mobile number. Texts from any other number are ignored (they show below as rejected).</li>
      <li>A2P 10DLC campaign registration asks for an opt-in policy: use <code class="url">${esc(location.origin + '/sms.html')}</code> — it states the program, frequency, STOP/HELP, privacy, and has the opt-in form staff fill in.</li>
      <li>Save the number under Settings so the board can show it to everyone.</li>
    </ol>
    <b>Commands</b> — the first word of the text picks where it goes:
    <pre class="cmds">ANNOUNCE  Team meeting Friday at 3 — pizza provided
TASK      Restock the front shelves           (today's list)
DAILY     Wipe down the counters              (repeats every day)
WEEKLY Fri  Deep-clean the back room          (repeats weekly, due Friday)
GOAL      units sold 25                       (sets today's target)
GOAL      revenue $1200
HELP                                          (texts back this list)
TASK ALL  Read the new return policy          (everyone signs separately)
TASK @Sam Call the vendor back                (just Sam)
No keyword → ${s.sms_default_kind === 'task' ? "goes on today's tasks" : 'posted as an announcement'}. Attach a photo to include it.</pre>
    <div class="tools" style="margin-top:18px"><b>Recent texts</b><div class="spacer"></div><button class="mini-btn" onclick="reloadMgr()">Refresh</button></div>
    <table class="list"><tr><th>When</th><th>From</th><th>Message</th><th>Result</th></tr>
      ${mgr.sms_log.map(m => `<tr><td class="mini" style="white-space:nowrap">${esc(fmtStamp(m.created_at))}</td><td>${esc(m.staff_name || m.from_phone)}${m.staff_name ? `<div class="mini">${esc(m.from_phone)}</div>` : ''}</td>
        <td>${esc(m.body)}${m.media_url ? ` <a href="${attr(m.media_url)}" target="_blank" rel="noopener">[photo]</a>` : ''}</td>
        <td><span class="chip ${m.action === 'rejected' ? 'due' : 'sms'}">${esc(m.action)}</span>${m.reply ? `<div class="mini">${esc(m.reply)}</div>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="4" class="empty">No texts yet.</td></tr>'}
    </table>`;
}

// One sign-off in full: who, when, the note, and the signature (drawn or typed).
window.viewSignoff = async id => {
  const c = await api('/api/manager/completion/' + id);
  if (c.error) { alert(c.error); return; }
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal">
    <h3>${esc(c.title)}</h3>
    <p class="sub">${esc(c.kind === 'weekly' ? 'Week of ' + fmtShort(c.period) : fmtDay(c.period))} · signed off by <b>${esc(c.staff_name)}</b> · ${esc(fmtStamp(c.signed_at))}</p>
    ${c.note ? `<p>“${esc(c.note)}”</p>` : ''}
    <label>Signature</label>
    ${c.signature_kind === 'drawn' ? `<div class="pad" style="padding:8px"><img src="${attr(c.signature)}" alt="signature" style="max-width:100%;max-height:160px"></div>` : `<div class="typed" style="font-size:26px">${esc(c.signature)}</div>`}
    <p class="mini">Device address ${esc(c.signed_ip || '—')}</p>
    <div class="row"><button class="small ghost" onclick="closeModal()">Close</button></div>
  </div></div>`;
};

function mgrActivity() {
  return `<p class="kicker-note">Every sign-off and goal entry from the last 30 days — who, what, when. A completed task leaves the board and is kept here;
    <b>View</b> shows the signature. Clear one if it was a mistaken tap (the task comes back on the board). You also get a push when someone completes a task, if your device has notifications on.</p>
    <div class="tools"><div class="spacer"></div><button class="mini-btn" onclick="downloadCsv()">Download CSV</button></div>
    <b>Task sign-offs</b>
    <table class="list"><tr><th>When</th><th>Task</th><th>For</th><th>Who</th><th></th></tr>
      ${mgr.completions.map(c => `<tr><td class="mini" style="white-space:nowrap">${esc(fmtStamp(c.signed_at))}</td><td>${esc(c.title)} <span class="mini">${c.kind}</span></td>
        <td class="mini">${esc(c.kind === 'weekly' ? 'week of ' + fmtShort(c.period) : fmtShort(c.period))}</td><td>${esc(c.staff_name)} <span class="mini">${c.signature_kind}</span>${c.note ? `<div class="mini">“${esc(c.note)}”</div>` : ''}</td>
        <td class="acts"><button class="mini-btn" onclick="viewSignoff(${c.id})">View</button> <button class="mini-btn danger" onclick="clearItem({completion_id:${c.id}})">Clear</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">None yet.</td></tr>'}
    </table>
    <b style="display:block;margin-top:18px">Goal entries</b>
    <table class="list"><tr><th>When</th><th>Goal</th><th>Amount</th><th>Who</th><th></th></tr>
      ${mgr.goal_entries.map(e => `<tr><td class="mini" style="white-space:nowrap">${esc(fmtStamp(e.created_at))}</td><td>${esc(e.label)} <span class="mini">${esc(fmtShort(e.date))}</span></td>
        <td>${esc(fmtAmt(e.amount, e.unit))}</td><td>${esc(e.staff_name)}${e.note ? `<div class="mini">“${esc(e.note)}”</div>` : ''}</td>
        <td class="acts"><button class="mini-btn danger" onclick="clearItem({entry_id:${e.id}})">Clear</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">None yet.</td></tr>'}
    </table>`;
}
window.clearItem = async body => { if (confirm('Clear this entry?')) { await api('/api/manager/clear', body); reloadMgr(); } };
window.downloadCsv = () => {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['type', 'when', 'item', 'period', 'who', 'amount', 'note']];
  for (const c of mgr.completions) rows.push(['task', c.signed_at, c.title, c.period, c.staff_name, '', c.note]);
  for (const e of mgr.goal_entries) rows.push(['goal', e.created_at, e.label, e.date, e.staff_name, e.amount, e.note]);
  const blob = new Blob([rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `board-activity-${mgr.today}.csv`; a.click();
};

// ---------- Evaluations tab ----------
function mgrHighlights() {
  const rows = mgr.highlights || [];
  return `<p class="kicker-note">Shift highlights and peer shoutouts posted from the board (last 90 days). Everyone with notifications on is told when one is posted; the board shows the last 7 days. Remove anything that doesn't belong.</p>
    <table class="list"><tr><th></th><th>What was shared</th><th>When</th><th></th></tr>
      ${rows.map(h => `<tr><td>${h.kind === 'shoutout' ? '👏' : '⭐'}</td><td>${h.kind === 'shoutout' ? `<b>${esc(h.author_name)}</b> → <b>${esc(h.subject_name)}</b><br>` : `<b>${esc(h.author_name)}</b><br>`}${esc(h.body)}</td><td class="mini">${esc(fmtStamp(h.created_at))}</td>
        <td class="acts"><button class="mini-btn danger" onclick="clearItem({highlight_id:${h.id}})">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>'}
    </table>`;
}
let evalWeek = '';
window.evalWeekTo = w => { evalWeek = w; renderManager(); };
function mgrEvals() {
  const es = mgr.eval_settings, thisWeek = weekStartOf(mgr.today);
  const weeks = [...new Set([thisWeek, ...mgr.peer_evals.map(e => e.week)])].sort().reverse();
  if (!weeks.includes(evalWeek)) evalWeek = thisWeek;
  const rows = mgr.peer_evals.filter(e => e.week === evalWeek);
  const crit = es.criteria;
  const bySubject = {};
  for (const e of rows) (bySubject[e.subject_name] = bySubject[e.subject_name] || []).push(e);
  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '—';
  const active = mgr.staff.filter(s => s.active && !s.skip_evals);
  const missing = active.filter(s => !rows.some(e => e.evaluator_id === s.id)).map(s => s.name);
  return `<div class="tools"><b>Week of</b>
      <select class="inline" onchange="evalWeekTo(this.value)">${weeks.map(w => `<option value="${w}" ${w === evalWeek ? 'selected' : ''}>${esc(fmtShort(w))} – ${esc(fmtShort(addDays(w, 6)))}${w === thisWeek ? ' (this week)' : ''}</option>`).join('')}</select>
      <span class="mini">${rows.length} of ${active.length} submitted${missing.length ? ' · waiting on ' + esc(missing.join(', ')) : ''}</span>
      <div class="spacer"></div><button class="mini-btn" onclick="downloadEvalsCsv()">Download CSV (12 weeks)</button></div>
    <b>Averages this week</b>
    <table class="list"><tr><th>Person</th><th>Evals</th>${crit.map(c => `<th>${esc(c)}</th>`).join('')}<th>Overall</th></tr>
      ${Object.entries(bySubject).sort((a, b) => a[0].localeCompare(b[0])).map(([name, evs]) => {
        const all = evs.flatMap(e => crit.map(c => Number(e.scores[c])).filter(Boolean));
        return `<tr><td><b>${esc(name)}</b></td><td>${evs.length}</td>${crit.map(c => `<td>${avg(evs.map(e => Number(e.scores[c])).filter(Boolean))}</td>`).join('')}<td><b>${avg(all)}</b></td></tr>`; }).join('')
        || `<tr><td colspan="${crit.length + 3}" class="empty">No evaluations for this week yet.</td></tr>`}
    </table>
    <b style="display:block;margin-top:18px">Evaluations</b>
    ${rows.map(e => `<div class="eval-card">
      <div class="head"><b>${esc(e.evaluator_name)}</b> <span class="mini">rated</span> <b>${esc(e.subject_name)}</b><span class="mini" style="margin-left:auto">${esc(fmtStamp(e.created_at))} · ${e.signature_kind}</span>
        <button class="mini-btn danger" onclick="clearItem({eval_id:${e.id}})">Remove</button></div>
      <div class="scores">${crit.map(c => `<span class="chip">${esc(c)} <b>${esc(e.scores[c] ?? '—')}</b></span>`).join('')}</div>
      ${e.strengths ? `<div><span class="mini">Doing well:</span> ${esc(e.strengths)}</div>` : ''}
      ${e.improve ? `<div><span class="mini">Work on:</span> ${esc(e.improve)}</div>` : ''}
    </div>`).join('') || '<div class="empty">Nothing yet.</div>'}
    <div class="settings" style="max-width:560px;margin-top:22px"><b>Evaluation settings</b>
      <label for="es_on">Peer evaluations</label>
      <select class="inline" id="es_on" style="width:100%"><option value="1" ${es.enabled ? 'selected' : ''}>On — the board asks each person for one a week</option><option value="0" ${!es.enabled ? 'selected' : ''}>Off</option></select>
      <label for="es_crit">What to rate (one per line, 1–5 each)</label>
      <textarea class="inline" id="es_crit" style="width:100%;min-height:100px">${esc(crit.join('\n'))}</textarea>
      <label for="es_rep">Weeks before someone can rate the same teammate again</label>
      <input class="inline" id="es_rep" type="number" min="0" max="12" value="${es.repeat_weeks}" style="width:120px"><div class="help">1 = not the same person two weeks running; 0 = no rule.</div>
      <div class="err" id="es_err" style="color:var(--red);font-size:13px;margin-top:10px;min-height:1em"></div>
      <div style="margin-top:8px"><button class="small green" onclick="saveEvalSettings()">Save</button></div>
    </div>`;
}
function weekStartOf(d) { const x = new Date(d + 'T00:00:00Z'); return addDays(d, -((x.getUTCDay() + 6) % 7)); }
window.saveEvalSettings = async () => {
  const out = await api('/api/manager/settings', { eval_enabled: document.getElementById('es_on').value, eval_criteria: document.getElementById('es_crit').value, eval_repeat_weeks: document.getElementById('es_rep').value });
  if (out.error) { document.getElementById('es_err').textContent = out.error; return; }
  await reloadMgr();
};
window.downloadEvalsCsv = () => {
  const crit = mgr.eval_settings.criteria, cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['week', 'submitted', 'evaluator', 'subject', ...crit, 'doing well', 'work on']];
  for (const e of mgr.peer_evals) rows.push([e.week, e.created_at, e.evaluator_name, e.subject_name, ...crit.map(c => e.scores[c] ?? ''), e.strengths, e.improve]);
  const blob = new Blob([rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `peer-evaluations-${mgr.today}.csv`; a.click();
};

function mgrSettings() {
  const s = mgr.settings;
  const f = (id, label, val, help, extra = '') => `<label for="${id}">${label}</label><input class="inline" id="${id}" value="${attr(val)}" style="width:100%" ${extra}>${help ? `<div class="help">${help}</div>` : ''}`;
  return `<div class="settings" style="max-width:560px">
    <b>Business</b>
    ${f('st_tz', 'Timezone', s.timezone, 'IANA name, e.g. America/Denver, America/Chicago, America/New_York — decides when "today" rolls over.', 'placeholder="America/Denver"')}
    <div class="help" style="margin-top:8px">Name, logo, colors, and fonts live under the <a href="#" onclick="mgrTabTo('branding'); return false">Branding</a> tab.</div>
    <b style="display:block;margin-top:22px">Access</b>
    ${f('st_pass', 'Board password', s.board_pass, 'What the team enters on the board device. Blank = only managers can open the board. Changing it signs every board device out.')}
    ${f('st_pin', 'Manager PIN', s.manager_pin, 'Unlocks this panel. Change it from the default!')}
    <b style="display:block;margin-top:22px">Announcements</b>
    ${f('st_annDays', 'Hide announcements after (days)', s.announce_days, '0 = never. They leave the board on their own after this many days and move to the archive on the Announcements tab (with who read them). Pinned ones stay; a "Hide after" date on an announcement wins.', 'type="number" min="0" max="365"')}
    <b style="display:block;margin-top:22px">Task reminder</b>
    ${f('st_remind', 'Remind about open tasks at (store time)', s.reminder_time, 'Leave blank for no reminder. Once this time passes, anyone who still owes a task today gets a notification (managers get the full list), at most once a day. The built-in timer checks once a day around 3 PM Mountain, so a time after that only fires if an outside timer also calls /api/cron/reminders (for example cron-job.org every 15 minutes).', 'type="time"')}
    <label for="st_wday">Weekly reminder (open weekly tasks + a nudge to give a shoutout)</label>
    <select class="inline" id="st_wday" style="width:100%">${[['', 'Off'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']].map(([v, l]) => `<option value="${v}" ${String(s.weekly_reminder_day || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="help">Sent on that day at the reminder time above (3 PM if none is set), once a week.</div>
    <div style="margin-top:6px"><button type="button" class="mini-btn" onclick="sendRemindersNow()">Send a daily reminder now</button> <button type="button" class="mini-btn" onclick="sendRemindersNow(true)">Send the weekly reminder now</button> <span class="mini" id="st_remind_out"></span></div>
    <b style="display:block;margin-top:22px">Shift highlights &amp; shoutouts</b>
    ${f('st_hlDays', 'Keep highlights on the board for (days)', s.highlight_days, '0 = keep showing the latest ones. After this many days they leave the board but stay in the manager Highlights tab (90 days).', 'type="number" min="0" max="365"')}
    <b style="display:block;margin-top:22px">Spreadsheet (goal actuals)</b>
    ${f('st_sheet', 'Spreadsheet link', s.sheet_url, 'Share the Excel file as "Anyone with the link can view" (OneDrive / SharePoint), or publish a Google Sheet to the web as CSV, then paste the link. Anyone with the link can read the sheet — keep it private. Then, on a goal under Goals, choose "Fill the actual from the spreadsheet" and say which columns to use.', 'placeholder="https://…"')}
    <div class="help" id="st_sheet_status">${sheetStatusHtml(s.sheet_status)}</div>
    <div style="margin-top:6px"><button type="button" class="mini-btn" onclick="sheetPreview()">Preview the file</button> <button type="button" class="mini-btn" onclick="sheetSync()">Read it now</button></div>
    <b style="display:block;margin-top:22px">Signing</b>
    <label for="st_reqpin">Require employee PIN to sign</label>
    <select class="inline" id="st_reqpin" style="width:100%">
      <option value="0" ${!s.require_pin ? 'selected' : ''}>No — people pick their name (their PIN too, if they have one)</option>
      <option value="1" ${s.require_pin ? 'selected' : ''}>Yes — each sign-off needs the employee's own PIN, which picks their name. The board password can't sign anything.</option>
    </select>
    <div class="help">Give everyone a PIN under Staff first. Employees can also type their PIN on the sign-in screen to open the board as themselves — announcements they see are then marked read for them automatically.</div>
    <b style="display:block;margin-top:22px">Text-in</b>
    ${f('st_num', 'Board phone number (shown on the board)', s.sms_number, '', 'placeholder="(555) 555-0100"')}
    <label for="st_kind">Texts with no keyword become</label>
    <select class="inline" id="st_kind" style="width:100%">
      <option value="announcement" ${s.sms_default_kind !== 'task' ? 'selected' : ''}>An announcement</option>
      <option value="task" ${s.sms_default_kind === 'task' ? 'selected' : ''}>A task on today's list</option>
    </select>
    <label for="st_bcast">Text announcements to everyone</label>
    <select class="inline" id="st_bcast" style="width:100%">
      <option value="1" ${s.sms_broadcast ? 'selected' : ''}>Yes — every new announcement (posted or texted in) is texted to the whole roster</option>
      <option value="0" ${!s.sms_broadcast ? 'selected' : ''}>No — announcements stay on the board (you can still pick "text everyone" per post)</option>
    </select>
    <label for="st_notify">Text people when a task is created for them</label>
    <select class="inline" id="st_notify" style="width:100%">
      <option value="1" ${s.sms_notify ? 'selected' : ''}>Yes — for "specific people" and "everyone" tasks</option>
      <option value="0" ${!s.sms_notify ? 'selected' : ''}>No</option>
    </select>
    <label for="st_reply">Text a confirmation back to the manager</label>
    <select class="inline" id="st_reply" style="width:100%">
      <option value="1" ${s.sms_reply ? 'selected' : ''}>Yes — reply "Posted ✓" (US local numbers need Twilio's A2P 10DLC registration to send)</option>
      <option value="0" ${!s.sms_reply ? 'selected' : ''}>No — inbound only (no registration needed; the Text-in tab still logs every text)</option>
    </select>
    <div class="err" id="st_err" style="color:var(--red);font-size:13px;margin-top:10px;min-height:1em"></div>
    <div style="margin-top:8px"><button class="small green" onclick="saveSettings()">Save settings</button> <span class="mini" id="st_ok"></span></div>
  </div>`;
}
// ---------- spreadsheet link (Settings) ----------
function sheetStatusHtml(st) {
  if (!st) return 'Not read yet. Paste a link, save, then use <b>Read it now</b>.';
  const goals = (st.goals || []).map(g => `<li>${esc(g.label)}: ${g.error ? `<b>problem</b> — ${esc(g.error)}` : `${esc(String(g.value))} <span class="mini">from ${g.rows} row${g.rows === 1 ? '' : 's'}</span>`}</li>`).join('');
  return `${st.ok ? '✓ Last read fine' : '⚠ Last read had a problem'} · ${esc(fmtStamp(st.at))}${st.error ? `<br><b>${esc(st.error)}</b> — goals keep their last good numbers.` : ''}${goals ? `<ul style="margin:6px 0 0 18px">${goals}</ul>` : ''}`;
}
window.sheetPreview = async () => {
  const url = document.getElementById('st_sheet').value.trim();
  const out = await api('/api/manager/sheet-preview', url ? { url } : {});
  if (out.error) { alert(out.error); return; }
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal" style="max-width:780px">
    <h3>What the board sees in your spreadsheet</h3>
    <p class="sub">The first rows of each tab, with column letters across the top. Dates stored as numbers (like 46296) are understood.</p>
    ${out.tabs.map(t => `<b>${esc(t.name)}</b> <span class="mini">${t.total} rows</span>
      <div style="overflow-x:auto;margin-bottom:12px"><table class="list"><tr><th></th>${t.cols.map(c => `<th>${c}</th>`).join('')}</tr>
        ${t.rows.map((r, i) => `<tr><td class="mini">${i + 1}</td>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`).join('')}
    <div class="row"><button class="small ghost" onclick="closeModal()">Close</button></div></div></div>`;
};
window.sheetSync = async () => {
  const out = await api('/api/manager/sheet-sync', {});
  if (out.error) { alert(out.error); return; }
  await reloadMgr();
};
window.saveSettings = async () => {
  const g = id => document.getElementById(id).value.trim();
  const pi = mgr.pin_issues || { missing: 0, shared: 0 };
  if (g('st_reqpin') === '1' && !mgr.settings.require_pin && (pi.missing || pi.shared) &&
      !confirm(`${pi.missing} active ${pi.missing === 1 ? 'person has' : 'people have'} no PIN and ${pi.shared} ${pi.shared === 1 ? 'has' : 'have'} a shared PIN. They won't be able to sign anything until they get one. Turn it on anyway?`)) return;
  const out = await api('/api/manager/settings', {
    timezone: g('st_tz'), board_pass: g('st_pass'), manager_pin: g('st_pin'), require_pin: g('st_reqpin'), announce_days: g('st_annDays'), highlight_days: g('st_hlDays'), reminder_time: g('st_remind'), weekly_reminder_day: g('st_wday'), sheet_url: g('st_sheet'), sms_number: g('st_num'), sms_default_kind: g('st_kind'), sms_reply: g('st_reply'), sms_notify: g('st_notify'), sms_broadcast: g('st_bcast'),
  });
  if (out.error) { document.getElementById('st_err').textContent = out.error; return; }
  if (out.token) { mgrToken = out.token; localStorage.setItem('db_mgr_token', mgrToken); }
  // The board token was minted against the old password; drop it if the password changed.
  if (boardToken && g('st_pass') !== mgr.settings.board_pass) { boardToken = ''; localStorage.removeItem('db_board_token'); }
  await reloadMgr();
};

// ---------- Branding tab ----------
// brandDraft holds the unsaved form state so the preview can follow every keystroke.
let brandDraft = null;
const FONT_CHOICES = ['system', 'Inter', 'Roboto', 'Poppins', 'Nunito', 'Montserrat', 'Lora', 'Work Sans'];
function mgrBranding() {
  const b = mgr.branding;
  brandDraft = { business_name: b.business_name, tagline: b.tagline, welcome_text: b.welcome_text, theme_color: b.theme_color,
    theme_topbar: b.theme_topbar, theme_bg: b.theme_bg, font: b.font, logo_url: b.logo_url, logo_data: b.has_logo_upload ? b.logo : '' };
  const color = (k, label, help) => `<label>${label}</label>
    <div class="color-row"><input type="color" value="${attr(brandDraft[k])}" oninput="brandSet('${k}', this.value)">
    <input class="inline" value="${attr(brandDraft[k])}" maxlength="7" oninput="brandSet('${k}', this.value)" placeholder="#1f6feb"><span class="help">${help}</span></div>`;
  return `<p class="kicker-note">Make the board look like your business. Changes show in the preview as you type; nothing is applied until you save.</p>
  <div class="brand-grid">
    <div class="settings">
      <label>Business name</label><input class="inline" style="width:100%" value="${attr(brandDraft.business_name)}" maxlength="80" oninput="brandSet('business_name', this.value)">
      <label>Tagline (optional)</label><input class="inline" style="width:100%" value="${attr(brandDraft.tagline)}" maxlength="120" placeholder="e.g. Main Street store" oninput="brandSet('tagline', this.value)">
      <div class="help">Shown under the name in the top bar and on the sign-in screen.</div>
      <label>Welcome text on the sign-in screen (optional)</label>
      <textarea class="inline" style="width:100%;min-height:70px" maxlength="600" placeholder="A sentence or two your team sees before opening the board." oninput="brandSet('welcome_text', this.value)">${esc(brandDraft.welcome_text)}</textarea>
      <label>Logo</label>
      <div class="logo-box">
        <div class="thumb" id="br_thumb"></div>
        <div>
          <input type="file" id="br_file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="display:none" onchange="brandLogoFile(this)">
          <button class="small ghost" type="button" onclick="document.getElementById('br_file').click()">Upload image…</button>
          <button class="mini-btn" type="button" onclick="brandLogoClear()">Remove</button>
          <div class="help">PNG, JPEG, WebP, GIF, or SVG. It's shrunk to fit and shown in the top bar, the sign-in screen, and as the browser-tab icon.</div>
        </div>
      </div>
      <label>…or a logo link instead of an upload</label>
      <input class="inline" style="width:100%" value="${attr(brandDraft.logo_url)}" placeholder="https://…/logo.png" oninput="brandSet('logo_url', this.value)">
      ${color('theme_color', 'Accent color', 'buttons, progress bars, highlights')}
      ${color('theme_topbar', 'Top bar color', 'the bar across the top of every screen')}
      ${color('theme_bg', 'Page background', 'behind the cards')}
      <label>Font</label>
      <select class="inline" style="width:100%" onchange="brandSet('font', this.value)">
        ${FONT_CHOICES.map(f => `<option value="${f}" ${brandDraft.font === f ? 'selected' : ''}>${f === 'system' ? 'System default (fastest)' : f}</option>`).join('')}
      </select>
      <div class="help">Named fonts load from Google Fonts.</div>
      <div class="err" id="br_err" style="color:var(--red);font-size:13px;margin-top:10px;min-height:1em"></div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="small green" onclick="saveBranding()">Save branding</button>
        <button class="small ghost" onclick="resetBranding()">Reset to defaults</button>
      </div>
    </div>
    <div>
      <div class="preview" id="br_preview">
        <div class="ptop"><span class="mark" id="bp_mark"></span><span><span id="bp_name"></span><span class="tag" id="bp_tag"></span></span></div>
        <div class="plabel">Preview</div>
        <div class="pbody">
          <div class="panel"><h2>Sales goals <span class="count">1 of 2 met</span></h2>
            <div class="goal met"><div class="met-tag">MET ✓</div><div class="lbl">Units sold</div><div class="nums">27 <small>/ 25</small></div><div class="track"><div class="fill" style="width:100%"></div></div></div>
            <div class="goal" style="margin-top:10px"><div class="lbl">Revenue</div><div class="nums">$640 <small>/ $1,200</small></div><div class="track"><div class="fill" style="width:53%"></div></div>
              <div class="foot"><span class="who">Last: Sam +$120</span><button class="small">+ Log</button></div></div>
          </div>
          <div class="panel"><h2>Today's tasks</h2>
            <div class="task done"><div class="box">✓</div><div class="body"><div class="title">Wipe down the counters</div><div class="signed">Signed off by Sam · 9:12 AM</div></div></div>
            <div class="task"><div class="box"></div><div class="body"><div class="title">Restock the front shelves <span class="chip sms">Texted in</span></div></div><div class="act"><button class="small">Sign off</button></div></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}
window.brandSet = (k, v) => {
  if (!brandDraft) return;
  brandDraft[k] = v;
  if (k === 'logo_url' && v.trim()) brandDraft.logo_data = '';
  if (k.startsWith('theme_')) { // keep the swatch and the hex box in step
    const row = event && event.target && event.target.closest('.color-row');
    if (row && /^#[0-9a-f]{6}$/i.test(v)) for (const i of row.querySelectorAll('input')) if (i !== event.target) i.value = v;
  }
  brandPreview();
};
function brandPreview() {
  if (!brandDraft) return;
  const p = document.getElementById('br_preview');
  if (!p) return;
  const b = { ...brandDraft, logo: brandDraft.logo_data || brandDraft.logo_url.trim() };
  const okHex = c => /^#[0-9a-f]{6}$/i.test(c);
  brandVars(p, { ...b, theme_color: okHex(b.theme_color) ? b.theme_color : DEFAULT_BRAND.theme_color,
    theme_topbar: okHex(b.theme_topbar) ? b.theme_topbar : DEFAULT_BRAND.theme_topbar, theme_bg: okHex(b.theme_bg) ? b.theme_bg : DEFAULT_BRAND.theme_bg });
  document.getElementById('bp_name').textContent = b.business_name || 'Daily Board';
  document.getElementById('bp_tag').textContent = b.tagline || '';
  const mark = document.getElementById('bp_mark'); mark.innerHTML = markHtml(b); mark.classList.toggle('logo', !!b.logo);
  document.getElementById('br_thumb').innerHTML = b.logo ? `<img src="${attr(b.logo)}" alt="">` : '<span>No logo</span>';
}
// Shrinks an uploaded image to at most 512px on its long side and keeps it as a PNG data URL
// (SVGs are kept as-is); the result is stored in the settings table, no file hosting needed.
window.brandLogoFile = async input => {
  const file = input.files && input.files[0];
  if (!file) return;
  const err = document.getElementById('br_err'); err.textContent = '';
  try {
    let dataUrl;
    if (file.type === 'image/svg+xml') {
      if (file.size > 200 * 1024) throw new Error('That SVG is over 200 KB — please simplify it.');
      dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    } else {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file doesn't look like an image.")); i.src = URL.createObjectURL(file); });
      for (const max of [512, 256, 160]) {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        dataUrl = c.toDataURL('image/png');
        if (dataUrl.length <= 380000) break;
      }
      if (dataUrl.length > 380000) throw new Error('That image is too detailed to store — try a simpler or smaller logo.');
    }
    brandDraft.logo_data = dataUrl; brandDraft.logo_url = '';
    const link = document.querySelector('.brand-grid input[placeholder^="https"]'); if (link) link.value = '';
    brandPreview();
  } catch (e) { err.textContent = e.message || 'Could not read that file.'; }
  input.value = '';
};
window.brandLogoClear = () => { brandDraft.logo_data = ''; brandDraft.logo_url = ''; const link = document.querySelector('.brand-grid input[placeholder^="https"]'); if (link) link.value = ''; brandPreview(); };
window.saveBranding = async () => {
  const err = document.getElementById('br_err'); err.textContent = '';
  const out = await api('/api/manager/branding', { ...brandDraft, logo_url: brandDraft.logo_url.trim() });
  if (out.error) { err.textContent = out.error; return; }
  cfg = { ...cfg, ...out.branding }; applyBranding(out.branding);
  await reloadMgr();
};
window.resetBranding = async () => {
  if (!confirm('Reset name, logo, colors, and font to the defaults?')) return;
  const out = await api('/api/manager/branding', { reset: true });
  if (out.error) { alert(out.error); return; }
  cfg = { ...cfg, ...out.branding }; applyBranding(out.branding);
  await reloadMgr();
};

// Generic edit dialog: fields = [{k, l, v, type, opts, ph, hint}]; save(values) returns the API result.
let formSave = null;
function formModal(title, fields, save) {
  formSave = save;
  $modal.innerHTML = `<div class="modal-back" onclick="if(event.target===this)closeModal()"><div class="modal">
    <h3>${esc(title)}</h3>
    <form onsubmit="formSubmit(); return false">
    ${fields.map(f => `<label>${esc(f.l)}</label>${
      f.type === 'select' ? `<select class="inline" data-k="${f.k}">${f.opts.map(([v, l]) => `<option value="${attr(v)}" ${String(f.v) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
      : f.type === 'textarea' ? `<textarea class="inline" data-k="${f.k}" placeholder="${attr(f.ph || '')}">${esc(f.v)}</textarea>`
      : f.type === 'checks' ? `<div class="checks" data-k="${f.k}" data-multi="1">${f.opts.map(([v, l]) => `<label class="chk"><input type="checkbox" value="${attr(v)}" ${(f.v || []).includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('') || '<span class="mini">No one yet.</span>'}</div>`
      : `<input class="inline" data-k="${f.k}" type="${f.type || 'text'}" value="${attr(f.v ?? '')}" placeholder="${attr(f.ph || '')}" ${f.type === 'number' ? 'step="any"' : ''} autocomplete="off">`
    }${f.hint ? `<div class="mini" style="margin-top:3px">${esc(f.hint)}</div>` : ''}${f.gen ? `<button type="button" class="mini-btn" style="margin-top:6px" onclick="genPin()">Generate a PIN</button>` : ''}`).join('')}
    <div class="err" id="fm_err"></div>
    <div class="row"><button type="button" class="small ghost" onclick="closeModal()">Cancel</button><button type="submit" class="small green" id="fm_go">Save</button></div>
    </form></div></div>`;
  const first = $modal.querySelector('input, textarea, select'); if (first) first.focus();
}
window.formSubmit = async () => {
  const vals = {};
  for (const el of $modal.querySelectorAll('[data-k]'))
    vals[el.dataset.k] = el.dataset.multi ? [...el.querySelectorAll('input:checked')].map(i => i.value) : (el.value.trim ? el.value.trim() : el.value);
  const go = document.getElementById('fm_go'); go.disabled = true;
  const out = await formSave(vals);
  go.disabled = false;
  if (out.error) { document.getElementById('fm_err').textContent = out.error; return; }
  closeModal(); await reloadMgr();
};

document.addEventListener('keydown', e => { if (e.key === 'Escape' && $modal.innerHTML) closeModal(); });
boot();
