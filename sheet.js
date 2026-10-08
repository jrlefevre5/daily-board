// Spreadsheet actuals: read an Excel workbook (.xlsx) or a CSV into rows, and pull a goal's number out of it.
// No dependencies. An .xlsx is a zip of XML files; the caller supplies `inflate` (raw deflate -> bytes) so this
// file runs anywhere (the server passes Node's zlib).

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---------- cells -> dates and numbers ----------
function mkDate(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}
function parseDateText(s) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return mkDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/))) return mkDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  if ((m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/)) || (m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{4})/))) {
    const [mon, day, year] = /^[A-Za-z]/.test(s) ? [m[1], m[2], m[3]] : [m[2], m[1], m[3]];
    const mi = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
    if (mi >= 0) return mkDate(+year, mi + 1, +day);
  }
  return null;
}
// Excel stores dates as day numbers (1899-12-30 = day 0); 25569 is 1970-01-01.
function serialToDate(n) { return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10); }
function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v >= 25569 && v < 80000 ? serialToDate(v) : null;
  const s = String(v).trim();
  return parseDateText(s) || (/^\d+(\.\d+)?$/.test(s) ? toDate(Number(s)) : null);
}
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()$,\s%]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
function colIndex(letters) { let n = 0; for (const ch of String(letters).toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
function colLetters(i) { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; }

// ---------- reading an .xlsx ----------
const xmlText = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(tag); return m ? xmlText(m[1]) : null; };

async function readZip(buf, inflate) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let e = u.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("That file isn't an Excel workbook (.xlsx) or a CSV.");
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const files = {};
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    files[new TextDecoder().decode(u.subarray(p + 46, p + 46 + nlen))] = { method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) };
    p += 46 + nlen + xlen + clen;
  }
  return {
    async read(name) {
      const f = files[name];
      if (!f) return null;
      const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
      const data = u.subarray(start, start + f.csize);
      return new TextDecoder().decode(f.method === 0 ? data : await inflate(data));
    },
  };
}

function parseSheetXml(xml, shared) {
  const rows = [];
  let rowAuto = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = attr(rm[1], 'r');
    const ri = rAttr ? Number(rAttr) - 1 : rowAuto;
    rowAuto = ri + 1;
    if (!rm[2]) continue;
    let colAuto = 0;
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r'), t = attr(cm[1], 't');
      const ci = ref ? colIndex(ref.replace(/\d+/g, '')) : colAuto;
      colAuto = ci + 1;
      const inner = cm[2] || '';
      let v = null;
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (t === 's') v = raw ? shared[Number(raw[1])] ?? null : null;
      else if (t === 'inlineStr') v = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlText(x[1])).join('');
      else if (t === 'str') v = raw ? xmlText(raw[1]) : null;
      else if (t === 'b') v = raw ? raw[1] === '1' : null;
      else if (t === 'e') v = null;
      else if (raw) { const n = Number(raw[1]); v = Number.isFinite(n) ? n : xmlText(raw[1]); }
      if (v === null || v === '') continue;
      (rows[ri] = rows[ri] || [])[ci] = v;
    }
  }
  return rows;
}

async function parseXlsx(buf, inflate) {
  const zip = await readZip(buf, inflate);
  const wbXml = await zip.read('xl/workbook.xml');
  if (!wbXml) throw new Error("That file isn't an Excel workbook (.xlsx) or a CSV.");
  const target = {};
  for (const m of (await zip.read('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), t = attr(m[0], 'Target');
    if (id && t) target[id] = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
  }
  const shared = [];
  const ss = await zip.read('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(xmlText([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name'), path = target[attr(m[0], 'r:id')];
    const xml = path ? await zip.read(path) : null;
    if (xml) sheets.push({ name, rows: parseSheetXml(xml, shared) });
  }
  if (!sheets.length) throw new Error('No sheets found in that workbook.');
  return { sheets };
}

// ---------- CSV ----------
function parseCsv(text) {
  const first = String(text).split(/\r?\n/, 1)[0];
  const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  const text2 = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text2.length; i++) {
    const ch = text2[i];
    if (q) { if (ch === '"') { if (text2[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text2[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(c => { const n = c.trim(); return n === '' ? undefined : n; }));
}

// A workbook (.xlsx) or a CSV, from the raw bytes of the file.
async function parseWorkbook(buf, inflate) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length > 3 && u[0] === 0x50 && u[1] === 0x4b) return parseXlsx(u, inflate);
  const text = new TextDecoder().decode(u);
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('The link opened a web page instead of the file. Share it as "Anyone with the link can view", then paste that link.');
  return { sheets: [{ name: 'CSV', rows: parseCsv(text) }] };
}

// ---------- links ----------
// Only OneDrive / SharePoint / Google share links are accepted (the server fetches this address).
function downloadUrl(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h.endsWith('.sharepoint.com')) { u.searchParams.set('download', '1'); return u.toString(); }
  if (h === '1drv.ms' || h === 'onedrive.live.com') {
    const b64 = Buffer.from(u.toString()).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    return 'https://api.onedrive.com/v1.0/shares/u!' + b64 + '/root/content';
  }
  if (h === 'docs.google.com') return u.toString();
  return null;
}

// ---------- reading a goal's number ----------
// map = { tab, mode: 'rows' | 'cell', dateCol, valueCol, firstRow, cell }.  key = 'YYYY-MM-DD' (daily goal) or 'YYYY-MM' (monthly).
function sheetOf(wb, tab) {
  const t = String(tab || '').trim().toLowerCase();
  const sh = t ? wb.sheets.find(s => String(s.name).toLowerCase() === t) : wb.sheets[0];
  if (!sh) throw new Error(`Couldn't find a tab named "${tab}" (tabs: ${wb.sheets.map(s => s.name).join(', ')}).`);
  return sh;
}
function readValue(wb, map, period, key) {
  const sh = sheetOf(wb, map.tab);
  if (map.mode === 'cell') {
    const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(String(map.cell || '').trim());
    if (!m) throw new Error('Enter the cell like D2.');
    const v = toNumber(((sh.rows[Number(m[2]) - 1]) || [])[colIndex(m[1])]);
    if (v == null) throw new Error(`Cell ${m[1].toUpperCase()}${m[2]} isn't a number.`);
    return { value: v, rows: 1 };
  }
  if (!/^[A-Za-z]{1,3}$/.test(String(map.dateCol || '')) || !/^[A-Za-z]{1,3}$/.test(String(map.valueCol || ''))) throw new Error('Enter the date column and the value column as letters (like A and C).');
  const dc = colIndex(map.dateCol), vc = colIndex(map.valueCol);
  let sum = 0, rows = 0;
  for (let r = Math.max(1, Number(map.firstRow) || 2) - 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    if (!row) continue;
    const d = toDate(row[dc]);
    if (!d || (period === 'month' ? d.slice(0, 7) !== key : d !== key)) continue;
    const v = toNumber(row[vc]);
    if (v != null) { sum += v; rows++; }
  }
  return { value: Math.round(sum * 100) / 100, rows };
}

// The first rows of every tab, as text, so a manager can see which column is which.
function preview(wb, maxRows = 12, maxCols = 10) {
  return wb.sheets.map(s => ({
    name: s.name, total: s.rows.length,
    cols: Array.from({ length: maxCols }, (_, i) => colLetters(i)),
    rows: Array.from({ length: Math.min(maxRows, s.rows.length) }, (_, r) => Array.from({ length: maxCols }, (_, c) => { const v = (s.rows[r] || [])[c]; return v == null ? '' : String(v).slice(0, 40); })),
  }));
}

module.exports = { parseWorkbook, parseXlsx, parseCsv, downloadUrl, readValue, preview, toDate, toNumber, colIndex, colLetters };
