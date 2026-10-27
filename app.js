import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, STAFF_LOGIN_DOMAIN } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
const BUCKET = 'appointment-files';
const TZ = 'Asia/Kuwait';
const MAX_PDF = 5 * 1048576;
const MAX_FILES = 5;

// ------------------------------------------------------------------ formatting (always Kuwait time)
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });

const ymd = (d) => ymdFmt.format(d);
const fromYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const dayInfo = (s) => { const d = fromYmd(s); return { ymd: s, dow: DOW[d.getUTCDay()], day: d.getUTCDate(), mon: MON[d.getUTCMonth()], long: DOWL[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONL[d.getUTCMonth()], year: d.getUTCFullYear() }; };
const hhmmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hhmm = (iso) => hhmmFmt.format(new Date(iso));
const fmtTime = (iso) => timeFmt.format(new Date(iso)).replace(/\s/g, ' ');
const whenText = (start, end) => dayInfo(ymd(new Date(start))).long + ' · ' + fmtTime(start) + (end ? ' – ' + fmtTime(end) : '');
const fileSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agendaColor = (n) => (n < 30 ? 'var(--muted)' : n <= 250 ? 'var(--teal)' : 'var(--danger)');
const statusLabel = (s) => ({ Late_Cancel: 'Late cancel', Reschedule_requested: 'Reschedule requested' }[s] || s);

function workingDates(n = 8) {
  const dows = S.settings?.working_dows || [0, 1, 2, 3, 4];
  const out = []; const d = fromYmd(ymd(new Date()));
  while (out.length < n) { if (dows.includes(d.getUTCDay())) out.push(dayInfo(d.toISOString().slice(0, 10))); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const nextYmd = (s) => { const d = fromYmd(s); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const kuwaitMidnight = (s) => s + 'T00:00:00+03:00';

// ------------------------------------------------------------------ server error messages
const ERRORS = {
  BOOKING_TOO_LATE: 'Meetings must be booked at least 1 hour in advance. Please choose a later time.',
  SLOT_TAKEN: 'That time has just been booked by someone else. Please choose another slot.',
  SLOT_IN_PAST: 'That time has already passed. Please choose another slot.',
  INVALID_SLOT: 'That time is outside official meeting hours.',
  AGENDA_TOO_SHORT: 'Describe the agenda in at least 30 characters.',
  AGENDA_TOO_LONG: 'Keep the agenda to 250 characters or fewer.',
  SUPPORT_FILE_REQUIRED: 'Attach at least one supporting document (PDF).',
  FILE_NOT_FOUND: 'One of the documents could not be found. Please attach it again.',
  AGENT_NOT_VERIFIED: 'Please verify your identity before booking.',
  INVALID_EMAIL: 'Enter a valid email address.',
  INVALID_PHONE: 'Enter an 8-digit Kuwait number.',
  MISSING_DETAILS: 'Fill in the name and company fields.',
  ID_EMAIL_MISMATCH: 'This ID is registered to a different email address. Please contact the Ministry reception desk.',
  STAFF_ACCOUNT: 'Staff accounts cannot book as an agent. Use Staff login.',
  NOT_ACTIVE: 'This meeting is no longer active.',
  ALREADY_STARTED: 'This meeting has already started.',
  WEEKLY_LIMIT: 'Each agent can book one meeting per week, and there is already a meeting booked that week. Please choose a different week.',
  NO_CHANGE: 'That is already the meeting time.',
  UNKNOWN_HOST: 'Choose who the meeting is with.',
  QUEUE_CLOSED: 'The admin office queue is open Sunday to Thursday, 8:00 AM to 2:00 PM. Please join during those hours.',
  INVALID_QUEUE_CODE: 'That isn\'t today\'s code. Scan the QR code displayed at the admin office — it changes every day.',
  ALREADY_IN_QUEUE: 'You already have a ticket in today\'s queue.',
  QUEUE_EMPTY: 'Nobody is waiting in the queue.',
  REASON_LENGTH: 'Describe the reason for your visit in 10 to 250 characters.',
  FORBIDDEN: 'You do not have permission to do that.',
};
function errMsg(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (m.startsWith('TIME_CLASH:')) return 'That time overlaps meeting ' + m.split(':')[1] + '. Choose another time, or pick its exact start time to swap the two.';
  if (m.startsWith('AGENT_LOCKED:')) return 'Bookings are locked until ' + m.split(':').slice(1).join(':') + ' (Kuwait time) because of a late cancellation.';
  const key = Object.keys(ERRORS).find((k) => m.includes(k));
  if (key) return ERRORS[key];
  if (/duplicate key.*agents/i.test(m)) return 'An agent with this ID or email is already registered.';
  if (/Invalid login credentials/i.test(m)) return 'Email or password is incorrect.';
  if (/Invalid TOTP|invalid.*code|expired/i.test(m)) return 'That code is incorrect or has expired.';
  if (/rate limit|security purposes/i.test(m)) return 'Too many attempts. Please wait a minute and try again.';
  return m;
}

// ------------------------------------------------------------------ icons (from the design)
const I = {
  director: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  superintendent: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#163d5f" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/></svg>',
  sections: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#163d5f" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.5 0 4.5 1.5 4.5 4.5"/></svg>',
  admins: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#163d5f" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18M5 21V9l7-5 7 5v12"/><path d="M9 21v-5h6v5M9 11h.01M15 11h.01M12 11h.01"/></svg>',
  calendar: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#163d5f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="15" rx="2"/><path d="M3 10h14M7 3v4M13 3v4"/><circle cx="17.5" cy="17.5" r="4" fill="#fff"/><path d="M17.5 15.5v2l1.3 1"/></svg>',
  arrowCircle: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1f6fb5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M8 12h8M13 8.5l3.5 3.5-3.5 3.5"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  chevron: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#163d5f" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  upload: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1f6fb5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  close: (c = '#5b6b7b') => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  tick: (s = 40, w = 2.6) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  arrow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  clock: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8a6512" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7v5.5l3 2"/></svg>',
  lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#163d5f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>',
  resched: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/></svg>',
};

// ------------------------------------------------------------------ state
const EMPTY_FORM = { name: '', agent: '', email: '', phone: '', agenda: '' };
const freshBooking = (extra = {}) => ({ portal: null, section: null, dateIdx: 0, slots: [], slotsLoading: false, slot: null,
  form: { ...EMPTY_FORM }, errors: {}, agreed: false, idType: 'civil', idValue: '', codeStep: false, codeEmail: '', code: '', qcode: '', qcodeScanned: false, files: [], fileErr: '', busy: false, err: '', result: null, ...extra });

const S = {
  stack: ['home'], mode: 'agent', session: null, me: null, role: null,
  sections: [], settings: null, myAppts: [],
  book: freshBooking(),
  st: { id: '', pw: '', err: '', busy: false },
  mfa: { factorId: null, qr: '', secret: '', code: '', err: '', busy: false },
  dash: { view: 'day', dateIdx: 0, appts: [], loading: false },
  openAppt: null, note: '', noteState: '', move: { date: '', time: '', host: '', busy: false, err: '' },
  desk: { lookup: '', msg: '', ok: false, agent: null, section: 'cos', reg: null, busy: false },
  q: { ticket: null, overview: null, busy: false },
  qdesk: { tickets: [], busy: false, loaded: false, code: null },
  scan: { open: false, err: '' },
};
const ticketNo = (n) => 'A-' + String(n).padStart(3, '0');
const ticketActive = (t) => t && (t.status === 'waiting' || t.status === 'called');
const screen = () => S.stack[S.stack.length - 1];
const uid = () => S.session?.user?.id;
const isAgent = () => !!S.me?.agent;
const sectionById = (id) => S.sections.find((x) => x.id === id);
function hostName(key) {
  if (key === 'director') return 'Director of KuFDA';
  if (key === 'superintendent') return 'Superintendent';
  if (key === 'admin') return 'Admin office';
  const s = sectionById(String(key).replace('sec:', '')); return s ? s.section_name + ' department' : 'Department';
}
const shortHost = (key) => ({ director: 'Director', superintendent: 'Superintendent' }[key] || hostName(key).replace('Head of ', ''));
const hostKey = () => (S.book.portal === 'sections' ? 'sec:' + S.book.section : S.book.portal === 'admins' ? 'admin' : S.book.portal);
const roleHostKey = () => S.role === 'section_head' ? 'sec:' + S.me.section_id : S.role;
const PORTALS = { director: 'Director', superintendent: 'Superintendent', sections: 'Departments', admins: 'Admins' };

function go(screenName, mutate) { if (mutate) mutate(); S.stack.push(screenName); render(true); }
function back() { if (S.stack.length > 1) S.stack.pop(); render(true); }
function reset(stack) { S.stack = stack; render(true); }

let toastTimer;
function toast(msg, bad = false) {
  const el = document.getElementById('toast');
  clearTimeout(toastTimer); el.textContent = msg; el.className = bad ? 'bad' : '';
  toastTimer = setTimeout(() => { el.textContent = ''; }, 4200);
}
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ------------------------------------------------------------------ data
async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  if (!session) { S.me = null; S.role = null; return; }
  const { data, error } = await sb.rpc('whoami');
  if (error) throw error;
  S.me = data;
  S.role = data.role && data.role !== 'agent' && (data.aal === 'aal2' || !mfaRequired()) ? data.role : null;
}
async function loadMyAppts() {
  if (!isAgent()) { S.myAppts = []; return; }
  const since = new Date(Date.now() - 86400000).toISOString();
  const { data, error } = await sb.from('appointments').select('id, ref, host_key, start_time, end_time, status')
    .gte('start_time', since).order('start_time').limit(30);
  if (!error) S.myAppts = data;
}
async function loadMyTicket() {
  if (!isAgent()) { S.q.ticket = null; return; }
  const { data, error } = await sb.rpc('my_ticket');
  if (!error) S.q.ticket = data;
}
async function loadOverview() {
  const { data, error } = await sb.rpc('queue_overview');
  if (!error) S.q.overview = data;
}
// ------------------------------------------------------------------ daily queue code (QR)
// Accepts the bare code, the in-app QR text "MOHQ-CODE", or a link ending "?q=CODE".
const normQueueCode = (v) => String(v || '').toUpperCase().replace(/^.*(MOHQ-|[?&]Q=)/, '').replace(/[^A-Z0-9]/g, '');
// Once the site is hosted the QR is a link (a phone camera opens the portal with the code filled in);
// opened from a file it is "MOHQ-CODE", scanned with the portal's own scanner.
const queueQrText = (code) => /^https?:$/.test(location.protocol)
  ? location.origin + location.pathname.replace(/[^/]*$/, '') + 'app.html?q=' + code : 'MOHQ-' + code;
const scripts = {};
function loadScript(src) {
  return scripts[src] ||= new Promise((ok, fail) => {
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { delete scripts[src]; fail(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
}
const QR_GEN = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const QR_READ = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
async function qrSvg(text) {
  await loadScript(QR_GEN);
  const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}

// Live camera only: a saved photo can't be uploaded, so the person has to be in front of today's code.
let scanStream = null, scanRaf = 0;
async function openScanner() {
  S.scan = { open: true, err: '' };
  const overlay = document.getElementById('overlay');
  overlay.innerHTML = `<div class="scan-overlay" role="dialog" aria-modal="true" aria-label="Scan today's QR code">
    <div class="pdf-bar"><span>Scan the QR code at the admin office</span><button class="icon-btn" data-act="closeScan" aria-label="Close">${I.close('#fff')}</button></div>
    <div class="scan-body"><video id="scanVideo" playsinline muted></video><div class="scan-frame"></div></div>
    <div class="scan-note" id="scanNote">Starting the camera…</div></div>`;
  const note = (t) => { const n = document.getElementById('scanNote'); if (n) n.textContent = t; };
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the camera.');
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = document.getElementById('scanVideo'); if (!video) return closeScanner();
    video.srcObject = scanStream; await video.play();
    note('Point the camera at the QR code.');
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    if (!detector) await loadScript(QR_READ);
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (!scanStream) return;
      let text = null;
      if (video.readyState >= 2) {
        if (detector) { const found = await detector.detect(video).catch(() => []); text = found[0]?.rawValue || null; }
        else {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight; ctx.drawImage(video, 0, 0);
          text = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data || null;
        }
      }
      const code = text && /MOHQ-|[?&]q=/i.test(text) ? normQueueCode(text) : '';
      if (code.length === 6) { S.book.qcode = code; S.book.qcodeScanned = true; delete S.book.errors.qcode; closeScanner(); render(); toast('Code scanned.'); return; }
      if (text) note('That is not the Ministry queue QR code. Point the camera at the code at the admin office.');
      scanRaf = requestAnimationFrame(tick);
    };
    scanRaf = requestAnimationFrame(tick);
  } catch (e) {
    note((e && e.name === 'NotAllowedError' ? 'Camera access was blocked.' : errMsg(e)) + ' You can type the 6-character code printed under the QR instead.');
    if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  }
}
function closeScanner() {
  cancelAnimationFrame(scanRaf);
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  S.scan = { open: false, err: '' }; document.getElementById('overlay').innerHTML = '';
}

async function printQueueQr() {
  const c = S.qdesk.code; if (!c?.code) return;
  const svg = await qrSvg(queueQrText(c.code));
  // Print through a hidden frame (pop-up blockers can't stop it).
  document.getElementById('qrPrintFrame')?.remove();
  const frame = Object.assign(document.createElement('iframe'), { id: 'qrPrintFrame', title: 'QR code print sheet' });
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(frame);
  const w = frame.contentWindow;
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Admin office queue · ${esc(dayInfo(c.day).long)}</title>
    <style>@page{size:A4;margin:18mm}body{font-family:Arial,sans-serif;text-align:center;color:#102c48;margin:0}
    h1{font-size:30px;margin:0 0 4px}h2{font-size:22px;margin:0 0 18px;font-weight:600}.ar{font-family:"Noto Naskh Arabic",Tahoma,serif;direction:rtl}
    .qr{width:120mm;height:120mm;margin:8mm auto}.qr svg{width:100%;height:100%}.code{font:700 30px monospace;letter-spacing:.3em;margin:4mm 0}
    .day{font-size:20px;font-weight:700;background:#102c48;color:#fff;display:inline-block;padding:6px 18px;border-radius:6px}
    p{font-size:16px;line-height:1.5;max-width:150mm;margin:6px auto}</style></head><body>
    <h1>Ministry of Health · Admin Office Queue</h1><h2 class="ar">وزارة الصحة · طابور مكتب الإدارة</h2>
    <div class="day">Valid only on ${esc(dayInfo(c.day).long)} ${dayInfo(c.day).year}</div>
    <div class="qr">${svg}</div><div class="code">${esc(c.code)}</div>
    <p>Open the MOH Meeting Portal, choose <b>Admins</b>, then tap <b>Scan QR code</b> and point your camera at this code. If the camera doesn't work, type the code above.</p>
    <p class="ar">افتح بوابة مواعيد وزارة الصحة، اختر <b>الإدارة</b>، ثم امسح هذا الرمز بالكاميرا.</p></body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 300);
}

async function loadQueueDesk() {
  const [{ data, error }, codeRes] = await Promise.all([
    sb.from('queue_tickets').select('*').eq('queue_day', ymd(new Date())).order('number'),
    sb.rpc('today_queue_code'),
  ]);
  if (!codeRes.error && codeRes.data) {
    const code = codeRes.data.code;
    if (code && S.qdesk.code?.code !== code) S.qdesk.qr = await qrSvg(queueQrText(code)).catch(() => null);
    S.qdesk.code = codeRes.data;
  }
  if (error) return toast(errMsg(error), true);
  S.qdesk.tickets = data; S.qdesk.loaded = true;
}
// Ticket and queue screens refresh themselves while open.
let pollTimer = null;
function syncPolling() {
  const sc = screen(); const want = sc === 'ticket' || sc === 'queueDesk' || sc === 'qjoin';
  if (want && !pollTimer) {
    pollTimer = setInterval(async () => {
      const now = screen();
      if (now === 'ticket') await loadMyTicket();
      else if (now === 'queueDesk') await loadQueueDesk();
      else if (now === 'qjoin') await loadOverview();
      else return;
      if (!document.querySelector('input:focus, textarea:focus, select:focus')) render();
    }, 15000);
  } else if (!want && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
async function loadSlots() {
  const b = S.book; const d = workingDates()[b.dateIdx];
  b.slotsLoading = true; render();
  const { data, error } = await sb.rpc('available_slots', { p_host: hostKey(), p_day: d.ymd });
  b.slotsLoading = false; b.slots = error ? [] : data;
  if (error) toast(errMsg(error), true);
  if (screen() === 'slot') render();
}
async function loadDash() {
  const dates = workingDates(); S.dash.loading = true; render();
  const { data, error } = await sb.from('appointments').select('*, appointment_files(id, kind, storage_path, file_name, size_bytes)')
    .gte('start_time', kuwaitMidnight(dates[0].ymd)).lt('start_time', kuwaitMidnight(nextYmd(dates[dates.length - 1].ymd)))
    .order('start_time');
  S.dash.loading = false;
  if (error) toast(errMsg(error), true); else S.dash.appts = data;
  render();
}

// ------------------------------------------------------------------ actions
const ACT = {
  home: (el, ev) => { ev.preventDefault(); S.book = freshBooking(); S.mode = S.role === 'admin' ? 'desk' : 'agent'; reset(['home']); if (isAgent()) Promise.all([loadMyAppts(), loadMyTicket()]).then(() => render()); },
  back: () => (screen() === 'done' ? ACT.doneNext() : back()),
  staffLogin: () => go('staffLogin', () => { S.st.err = ''; }),
  toWorkspace: () => { if (S.role === 'admin') startIntake(); else openDashboard(); },
  timetable: () => openDashboard(),
  signOut: async () => {
    await sb.auth.signOut();
    Object.assign(S, { me: null, role: null, session: null, mode: 'agent', myAppts: [], openAppt: null, book: freshBooking() });
    S.st = { id: '', pw: '', err: '', busy: false }; S.mfa = { factorId: null, qr: '', secret: '', code: '', err: '', busy: false };
    reset(['home']);
  },
  portal: (el) => {
    const portal = el.dataset.portal;
    S.mode = 'agent'; S.book = freshBooking({ portal });
    if (isAgent()) prefillFromAgent();
    if (portal === 'admins') {
      if (ticketActive(S.q.ticket)) return go('ticket');
      go('qjoin'); loadOverview().then(() => screen() === 'qjoin' && render());
      return;
    }
    const next = portal === 'sections' ? 'sections' : 'slot';
    go(next); if (next === 'slot') loadSlots();
  },
  openTicket: () => go('ticket'),
  refreshTicket: async () => { await loadMyTicket(); render(); },
  leaveQueue: async () => {
    const t = S.q.ticket; if (!t) return;
    if (!confirm(`Leave the queue? Ticket ${ticketNo(t.number)} will be cancelled.`)) return;
    const { error } = await sb.rpc('leave_queue', { p_id: t.id });
    if (error) return toast(errMsg(error), true);
    await loadMyTicket(); render(); toast('You have left the queue.');
  },
  queueDesk: async () => { reset(['home', 'queueDesk']); await loadQueueDesk(); render(); },
  callNext: async () => {
    const q = S.qdesk; if (q.busy) return;
    q.busy = true; render();
    const { data, error } = await sb.rpc('queue_call_next');
    q.busy = false;
    if (error) { toast(errMsg(error), true); return render(); }
    await loadQueueDesk(); render(); toast(`Now serving ${ticketNo(data.number)}.`);
  },
  finishTicket: async (el) => {
    const { error } = await sb.rpc('queue_finish', { p_id: el.dataset.id, p_status: el.dataset.status });
    if (error) return toast(errMsg(error), true);
    await loadQueueDesk(); render();
  },
  deskQueue: async () => {
    const a = S.desk.agent;
    if (!a) { S.desk.msg = 'Look up the agent first.'; S.desk.ok = false; return render(); }
    const { data, error } = await sb.rpc('join_queue', { p_name: a.full_name, p_company: a.company, p_email: a.email, p_phone: a.phone, p_reason: 'Walk-in at the reception desk', p_agent: a.id });
    if (error) return toast(errMsg(error), true);
    S.desk.msg = `${a.full_name} added to the admin office queue as ${ticketNo(data.number)} (${data.ahead} ahead).`; S.desk.ok = true; render();
  },
  resendCode: async () => {
    const b = S.book; b.code = ''; b.err = '';
    const { error } = await sb.auth.signInWithOtp({ email: b.codeEmail, options: { shouldCreateUser: true } });
    if (error) b.err = errMsg(error); else toast('A new code has been sent to ' + b.codeEmail);
    render();
  },
  staffContinue: async () => {
    const st = S.st;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(st.id.trim()) || !st.pw) { st.err = 'Enter your work email and password'; return render(); }
    st.busy = true; st.err = ''; render();
    if (S.session) await sb.auth.signOut();
    const { error } = await sb.auth.signInWithPassword({ email: st.id.trim().toLowerCase(), password: st.pw });
    if (error) { st.busy = false; st.err = errMsg(error); return render(); }
    await loadMe();
    if (!S.me?.role || S.me.role === 'agent') { await sb.auth.signOut(); st.busy = false; st.err = 'This is not a staff account.'; return render(); }
    st.busy = false; st.pw = '';
    if (!mfaRequired()) return S.role === 'admin' ? startIntake() : openDashboard();
    try { await prepareMfa(); } catch (e) { st.err = errMsg(e); return render(); }
    go('otp');
  },
  mfaVerify: async () => {
    const m = S.mfa;
    if (!/^\d{6}$/.test(m.code)) { m.err = 'Enter the 6-digit code'; return render(); }
    m.busy = true; m.err = ''; render();
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: m.factorId, code: m.code });
    m.busy = false;
    if (error) { m.err = errMsg(error); return render(); }
    await loadMe();
    S.mfa = { factorId: null, qr: '', secret: '', code: '', err: '', busy: false };
    if (S.role === 'admin') startIntake(); else openDashboard();
  },
  section: (el) => { S.book.section = el.dataset.id; S.book.slot = null; S.book.dateIdx = 0; go('slot'); loadSlots(); },
  date: (el) => { S.book.dateIdx = Number(el.dataset.i); S.book.slot = null; loadSlots(); },
  slot: (el) => { S.book.slot = el.dataset.ts; render(); },
  primary: () => PRIMARY[screen()]?.(),
  removeFile: (el) => { S.book.files = S.book.files.filter((f) => f.id !== el.dataset.id); S.book.fileErr = ''; render(); },
  agree: (el) => { S.book.agreed = el.checked; render(); },
  doneNext: () => {
    if (S.mode === 'desk') startIntake();
    else { S.book = freshBooking(); reset(['home']); loadMyAppts().then(() => render()); }
  },
  dashView: (el) => { S.dash.view = el.dataset.v; render(); },
  dashDate: (el) => { S.dash.dateIdx = Number(el.dataset.i); render(); },
  openAppt: async (el) => {
    S.openAppt = S.dash.appts.find((a) => a.id === el.dataset.id); S.note = ''; S.noteState = '';
    resetMove(); go('appt');
    const { data } = await sb.from('private_notes').select('body').eq('appointment_id', S.openAppt.id).maybeSingle();
    S.note = data?.body || ''; if (screen() === 'appt') render();
  },
  openPdf: async (el) => {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(el.dataset.path, 300);
    if (error) return toast(errMsg(error), true);
    document.getElementById('overlay').innerHTML = `<div class="pdf-overlay" role="dialog" aria-modal="true" aria-label="${esc(el.dataset.name)}">
      <div class="pdf-bar"><span>${esc(el.dataset.name)}</span><a href="${esc(data.signedUrl)}" target="_blank" rel="noopener">Open in new tab</a>
      <button class="icon-btn" data-act="closePdf" aria-label="Close">${I.close('#fff')}</button></div>
      <iframe class="pdf-frame" src="${esc(data.signedUrl)}" title="${esc(el.dataset.name)}"></iframe></div>`;
  },
  closePdf: () => closeScanner(),
  scanQr: () => openScanner(),
  closeScan: () => closeScanner(),
  printQr: () => printQueueQr(),
  // One button: make a fresh code for today (the old one stops working), show it and print it.
  generateCode: async () => {
    const q = S.qdesk; if (q.genBusy) return;
    if (q.code?.code && !confirm('Generate a new code? The current QR sheet will stop working straight away.')) return;
    q.genBusy = true; render();
    const { data, error } = await sb.rpc('generate_queue_code');
    if (error) { q.genBusy = false; toast(errMsg(error), true); return render(); }
    q.code = data; q.qr = await qrSvg(queueQrText(data.code)).catch(() => null);
    q.genBusy = false; render();
    toast('New code ' + data.code + ' is ready. The print window is opening.');
    printQueueQr();
  },
  moveAppt: async () => {
    const a = S.openAppt; const m = S.move; if (!a || m.busy) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date) || !/^\d{2}:\d{2}$/.test(m.time)) { m.err = 'Choose a date and time'; return render(); }
    m.busy = true; m.err = ''; render();
    const { data, error } = await sb.rpc('move_appointment', { p_id: a.id, p_start: `${m.date}T${m.time}:00+03:00`, p_host: m.host });
    m.busy = false;
    if (error) { m.err = errMsg(error); return render(); }
    await refreshOpenAppt(a.id);
    toast(`${data.ref} moved to ${whenText(data.start_time)}` + (data.swapped_with ? ` · swapped with ${data.swapped_with}` : '') + '. The agent will be notified by SMS.');
  },
  cancelAppt: async () => {
    const a = S.openAppt; if (!a) return;
    if (!confirm(`Cancel meeting ${a.ref} with ${a.company} on ${whenText(a.start_time)}? The agent will be notified by SMS.`)) return;
    const { error } = await sb.rpc('cancel_appointment', { p_id: a.id });
    if (error) return toast(errMsg(error), true);
    await refreshOpenAppt(a.id);
    toast(`${a.ref} cancelled. The agent will be notified by SMS.`);
  },
  lookup: async () => {
    const d = S.desk; const v = d.lookup.trim();
    if (!/^\d{12}$/.test(v)) { Object.assign(d, { ok: false, msg: 'Enter the agent\'s 12-digit Civil ID.', agent: null, reg: null }); return render(); }
    const { data, error } = await sb.rpc('lookup_agent', { p_value: v });
    if (error) { Object.assign(d, { ok: false, msg: errMsg(error) }); return render(); }
    if (!data) {
      Object.assign(d, { ok: false, agent: null, msg: 'No record found. Register the agent below.', reg: { civil: v, name: '', company: '', email: '', phone: '', err: '' } });
    } else setDeskAgent(data);
    render();
  },
  deskRegister: async () => {
    const r = S.desk.reg;
    if (!/^\d{12}$/.test(r.civil.trim())) { r.err = 'Enter a 12-digit Civil ID'; return render(); }
    if (!r.name.trim() || !r.company.trim()) { r.err = 'Enter the agent name and company'; return render(); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.email.trim())) { r.err = 'Enter a valid email address'; return render(); }
    if (r.phone.replace(/\D/g, '').length !== 8) { r.err = 'Enter an 8-digit Kuwait number'; return render(); }
    const { data, error } = await sb.rpc('desk_register_agent', { p_civil: r.civil, p_licence: '', p_name: r.name, p_company: r.company, p_email: r.email, p_phone: r.phone });
    if (error) { r.err = errMsg(error); return render(); }
    setDeskAgent(data); S.desk.msg = 'Registered: ' + data.full_name + ', ' + data.company + '. Details pre-filled.'; render();
  },
  deskVerify: async () => {
    const { error } = await sb.rpc('desk_verify_agent', { p_agent: S.desk.agent.id });
    if (error) return toast(errMsg(error), true);
    S.desk.agent.verified = true; S.desk.msg = 'Agent verified. Their pending bookings are now confirmed.'; render();
  },
  deskNext: async () => {
    if (!deskReady()) return;
    const dates = workingDates(); S.desk.busy = true; render();
    for (let i = 0; i < dates.length; i++) {
      const { data } = await sb.rpc('available_slots', { p_host: hostKey(), p_day: dates[i].ymd });
      const free = (data || []).find((t) => t.state === 'open' || t.state === 'too_soon');
      if (free) { S.desk.busy = false; Object.assign(S.book, { dateIdx: i, slots: data, slot: free.start_time }); S.stack.push('slot'); go('details'); return; }
    }
    S.desk.busy = false; toast('No free slots in the next 8 working days for this section.', true); render();
  },
  deskSchedule: () => { if (!deskReady()) return; S.book.slot = null; S.book.dateIdx = 0; go('slot'); loadSlots(); },
};

// Bottom-right / sidebar primary button per screen
const PRIMARY = {
  slot: () => S.book.slot && go('details'),
  details: () => {
    const b = S.book; const f = b.form; const e = validateContact(b);
    if (f.agenda.trim().length < 30) e.agenda = 'Describe the agenda in at least 30 characters';
    else if (f.agenda.trim().length > 250) e.agenda = 'Keep the agenda to 250 characters or fewer';
    b.errors = e;
    if (!b.files.length) b.fileErr = 'Attach at least one supporting document (PDF)';
    if (Object.keys(e).length || !b.files.length) return render();
    go('review', () => { b.err = ''; b.codeStep = false; });
  },
  review: async () => {
    const b = S.book; if (!b.agreed || b.busy) return;
    b.busy = true; b.err = ''; render();
    try {
      if (!(await verifyIdentity(b))) return;
      const files = await uploadFiles();
      const { data, error } = await sb.rpc('book_appointment', {
        p_host: hostKey(), p_start: b.slot, p_agenda: b.form.agenda, p_name: b.form.name, p_company: b.form.agent,
        p_email: b.form.email, p_phone: b.form.phone, p_files: files, p_agent: S.mode === 'desk' ? S.desk.agent.id : null,
      });
      if (error) throw error;
      b.result = data; await loadMyAppts(); go('done');
    } catch (e) { b.err = errMsg(e); } finally { b.busy = false; if (screen() === 'review') render(); }
  },
  done: () => ACT.doneNext(),
  qjoin: async () => {
    const b = S.book; if (b.busy) return;
    if (!b.codeStep) {
      const e = validateContact(b);
      const n = b.form.agenda.trim().length;
      if (n < 10 || n > 250) e.agenda = 'Describe the reason for your visit in 10 to 250 characters';
      if (normQueueCode(b.qcode).length !== 6) e.qcode = 'Scan the QR code at the admin office, or type the 6-character code printed under it';
      b.errors = e;
      if (Object.keys(e).length) return render();
    }
    b.busy = true; b.err = ''; render();
    try {
      if (!(await verifyIdentity(b))) return;
      const { data, error } = await sb.rpc('join_queue', { p_name: b.form.name, p_company: b.form.agent, p_email: b.form.email, p_phone: b.form.phone, p_reason: b.form.agenda, p_code: normQueueCode(b.qcode) });
      if (error) throw error;
      S.q.ticket = data; S.book = freshBooking(); reset(['home', 'ticket']);
    } catch (e) { b.err = errMsg(e); } finally { b.busy = false; if (screen() === 'qjoin') render(); }
  },
};

const needsIdCheck = () => S.mode !== 'desk' && !isAgent();
// Agents confirm who they are with an emailed one-time code, then their Civil ID is linked to that email.
// Returns true once the agent is signed in and linked; false after sending the code (the form then shows a code box).
async function verifyIdentity(b) {
  if (!needsIdCheck()) return true;
  if (!b.codeStep) {
    const email = b.form.email.trim().toLowerCase();
    if (S.session) { await sb.auth.signOut(); S.session = null; S.me = null; }
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw error;
    Object.assign(b, { codeStep: true, codeEmail: email, code: '' });
    return false;
  }
  if (!/^\d{6,8}$/.test(b.code)) throw new Error('Enter the code from the email');
  const v = await sb.auth.verifyOtp({ email: b.codeEmail, token: b.code, type: 'email' });
  if (v.error) throw v.error;
  const c = await sb.rpc('claim_agent', { p_type: b.idType, p_value: b.idValue.trim() });
  if (c.error) { await sb.auth.signOut(); b.codeStep = false; throw c.error; }
  if (c.data.status === 'not_registered') {
    const r = await sb.rpc('register_self', { p_type: b.idType, p_value: b.idValue.trim(), p_name: b.form.name, p_company: b.form.agent, p_phone: b.form.phone });
    if (r.error) throw r.error;
  }
  await loadMe(); b.codeStep = false;
  return true;
}
function validateContact(b) {
  const f = b.form; const e = {};
  if (needsIdCheck()) {
    const id = b.idValue.trim();
    if (!/^\d{12}$/.test(id)) e.id = 'Civil ID must be 12 digits';
  }
  if (!f.name.trim()) e.name = 'Enter your full name';
  if (!f.agent.trim()) e.agent = 'Enter the agent name';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) e.email = 'Enter a valid email address';
  if (f.phone.replace(/\D/g, '').length !== 8) e.phone = 'Enter an 8-digit Kuwait number';
  return e;
}
function prefillFromAgent() {
  const a = S.me?.agent; if (!a) return;
  Object.assign(S.book.form, { name: a.full_name, agent: a.company, email: a.email, phone: a.phone });
}
// PDFs stay in the browser until the booking is confirmed, then upload into the signed-in user's folder.
async function uploadFiles() {
  const out = [];
  for (const f of S.book.files) {
    if (!f.path) {
      const path = uid() + '/' + crypto.randomUUID() + '.pdf';
      const { error } = await sb.storage.from(BUCKET).upload(path, f.file, { contentType: 'application/pdf', upsert: false });
      if (error) throw new Error('Upload of ' + f.name + ' failed: ' + errMsg(error));
      f.path = path;
    }
    out.push({ kind: 'support', path: f.path, name: f.name });
  }
  return out;
}
// Staff 2FA is a database setting (settings.staff_mfa_required); currently off.
const mfaRequired = () => S.settings?.staff_mfa_required !== false;
async function prepareMfa() {
  const { data, error } = await sb.auth.mfa.listFactors(); if (error) throw error;
  const verified = data.totp.find((f) => f.status === 'verified');
  if (verified) { S.mfa = { factorId: verified.id, qr: '', secret: '', code: '', err: '', busy: false }; return; }
  for (const f of data.all.filter((f) => f.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id });
  const en = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'MOH Meeting Portal ' + Date.now() });
  if (en.error) throw en.error;
  S.mfa = { factorId: en.data.id, qr: en.data.totp.qr_code, secret: en.data.totp.secret, code: '', err: '', busy: false };
}
const canManage = () => S.role === 'director' || S.role === 'superintendent';
function resetMove() {
  const a = S.openAppt; if (!a) return;
  S.move = { date: ymd(new Date(a.start_time)), time: hhmm(a.start_time), host: a.host_key, busy: false, err: '' };
}
async function refreshOpenAppt(id) {
  const { data } = await sb.from('appointments').select('*, appointment_files(id, kind, storage_path, file_name, size_bytes)').eq('id', id).maybeSingle();
  if (data) S.openAppt = data;
  resetMove(); render(); loadDash();
}
function openDashboard() { S.mode = 'agent'; S.dash.view = 'day'; S.dash.dateIdx = 0; reset(['home', 'dashboard']); loadDash(); }
function startIntake() {
  S.mode = 'desk'; S.book = freshBooking({ portal: 'sections', section: S.desk.section || 'cos' });
  S.desk = { lookup: '', msg: '', ok: false, agent: null, section: S.book.section, reg: null, busy: false };
  reset(['home', 'intake']);
}
function setDeskAgent(a) {
  const d = S.desk;
  Object.assign(d, { agent: a, ok: true, reg: null, msg: 'Found: ' + a.full_name + ', ' + a.company.replace(/\.$/, '') + '. Details pre-filled.' });
  Object.assign(S.book.form, { name: a.full_name, agent: a.company, email: a.email, phone: a.phone });
}
function deskReady() {
  if (!S.desk.agent) { S.desk.msg = 'Look up the agent before booking.'; S.desk.ok = false; render(); return false; }
  if (S.desk.agent.locked_until) { S.desk.msg = 'This agent is locked from new bookings until ' + whenText(S.desk.agent.locked_until) + '.'; S.desk.ok = false; render(); return false; }
  S.book.section = S.desk.section; S.book.portal = 'sections'; return true;
}
function pickFiles(list) {
  const b = S.book; b.fileErr = '';
  for (const file of list) {
    if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) { b.fileErr = file.name + ': only PDF files are accepted'; continue; }
    if (file.size > MAX_PDF) { b.fileErr = file.name + ' is larger than 5 MB'; continue; }
    if (b.files.length >= MAX_FILES) { b.fileErr = 'You can attach up to ' + MAX_FILES + ' documents'; break; }
    b.files.push({ id: crypto.randomUUID(), name: file.name, size: fileSize(file.size), file, path: null });
  }
  render();
}

// ------------------------------------------------------------------ views
const field = (label, inner, err, extra = '') => `<label class="field ${extra}"><span class="lbl">${label}</span>${inner}${err ? `<span class="err">${esc(err)}</span>` : ''}</label>`;
const input = (model, value, attrs = '', bad = false) => `<input class="input${bad ? ' bad' : ''}" data-model="${model}" value="${esc(value)}" ${attrs}>`;
const cta = (label, { act = 'primary', disabled = false, arrow = false, cls = '' } = {}) =>
  `<button class="cta ${cls}" data-act="${act}" ${disabled ? 'disabled' : ''}><span>${esc(label)}</span>${arrow ? I.arrow : ''}</button>`;
const kv = (rows) => `<div class="kv-grid">${rows.map((r) => `<div class="kv"><span class="k">${esc(r.k)}</span><span class="v">${esc(r.v)}</span></div>`).join('')}</div>`;

function viewHome() {
  const locked = S.me?.agent?.locked_until;
  const meetings = S.myAppts.map((a) => {
    const active = ['Pending', 'Confirmed', 'Reschedule_requested'].includes(a.status) && new Date(a.start_time) > Date.now();
    return `<div class="meeting">${I.arrowCircle}<div class="meeting-txt"><span class="meeting-host">${esc(hostName(a.host_key))}</span>
      <span class="meeting-when">${esc(whenText(a.start_time, a.end_time))}</span>
      <span class="meeting-ref${active ? '' : ' off'}">${esc(a.ref)} · ${esc(statusLabel(a.status).toUpperCase())}</span></div>
      </div>`;
  }).join('');
  const t = S.q.ticket;
  const ticketCard = ticketActive(t) ? `<button class="meeting ticket-card" data-act="openTicket">${I.arrowCircle}<span class="meeting-txt"><span class="meeting-host">Admin office queue · ${ticketNo(t.number)}</span>
      <span class="meeting-when">${t.status === 'called' ? 'It\x27s your turn — go to the admin office now' : (t.ahead ? t.ahead + ' ahead of you' : 'You are next')}</span><span class="meeting-ref">VIEW TICKET</span></span></button>` : '';
  const ag = S.me?.agent;
  return `
  <section class="hero">
    <div class="wrap hero-in"><h1>Appointments</h1></div></section>
  <div class="section-title"><h2>MEETING PORTALS</h2><div class="rule"></div></div>
  <div class="wrap portals">
    <button class="portal primary" data-act="portal" data-portal="director">${I.director}<span class="portal-name">DIRECTOR OF KuFDA</span></button>
    <button class="portal" data-act="portal" data-portal="superintendent">${I.superintendent}<span class="portal-name">SUPERINTENDENT</span></button>
    <button class="portal" data-act="portal" data-portal="sections">${I.sections}<span class="portal-name">DEPARTMENTS</span></button>
    <button class="portal" data-act="portal" data-portal="admins">${I.admins}<span class="portal-name">ADMINS</span><span class="portal-desc">Join the admin office queue</span></button>
  </div>
  <div class="wrap mine-wrap"><div class="card mine">
    <div class="mine-head">${I.calendar}<h3>My meetings</h3>
      ${ag ? `<span class="verified">Verified · ${esc(ag.civil_id ? 'Civil ID ' + ag.civil_id : 'Licence ' + ag.licence_no)}</span>` : ''}</div>
    <div class="mine-body">
      ${locked ? `<div class="banner bad"><div><b>Bookings locked</b>A late cancellation means you cannot book new meetings until ${esc(whenText(locked))}.</div></div>` : ''}
      ${ag && !ag.verified ? `<div class="banner info"><div><b>Identity check pending</b>Your bookings stay pending until the Ministry reception verifies your Civil ID.</div></div>` : ''}
      ${S.role ? `<span class="muted">You are signed in as Ministry staff. <button class="text-btn" data-act="toWorkspace">Go to ${S.role === 'admin' ? 'the intake desk' : 'your timetable'}</button></span>`
        : meetings || ticketCard ? `<div class="mine-grid">${ticketCard}${meetings}</div>`
        : `<span class="muted" style="font-size:16px">${ag ? 'You have no upcoming meetings. Choose a portal above to book one.' : 'Choose a portal above to book a meeting. You will add your Civil ID with the meeting details.'}</span>`}
    </div></div></div>`;
}

function viewStaffLogin() {
  const st = S.st;
  return `<div style="display:flex;justify-content:center"><img src="assets/moh-logo.jpg" alt="Ministry of Health, State of Kuwait" style="width:150px;height:auto"></div>
    ${field('Email', input('st.id', st.id, 'type="email" placeholder="name@moh.gov.kw" autocomplete="username"'))}
    ${field('Password', `<input class="input" type="password" data-model="st.pw" value="${esc(st.pw)}" autocomplete="current-password">`)}
    ${st.err ? `<span class="err">${esc(st.err)}</span>` : ''}
    ${cta(st.busy ? 'Signing in…' : 'Continue', { act: 'staffContinue', disabled: st.busy })}`;
}

function viewOtp() {
  const m = S.mfa;
  return `${m.qr ? `<p class="lead">Two-factor authentication is required for Ministry staff. Scan this code with an authenticator app (Microsoft Authenticator, Google Authenticator), then enter the 6-digit code it shows.</p>
      <div class="qr"><img src="${esc(m.qr)}" alt="Authenticator setup QR code"><span class="hint">Can't scan? Enter this key:</span><code>${esc(m.secret)}</code></div>`
    : `<p class="lead">Enter the 6-digit code from your authenticator app.</p>`}
    <input class="input otp${m.err ? ' bad' : ''}" data-model="mfa.code" value="${esc(m.code)}" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" aria-label="6-digit code">
    ${m.err ? `<span class="err">${esc(m.err)}</span>` : ''}
    ${cta(m.busy ? 'Checking…' : 'Sign in', { act: 'mfaVerify', disabled: m.busy })}`;
}

function sidebar() {
  const b = S.book; const sc = screen();
  const host = hostName(hostKey()); const sec = sectionById(b.section);
  const sel = b.slot ? whenText(b.slot, new Date(new Date(b.slot).getTime() + (S.settings?.slot_minutes ?? 30) * 60000).toISOString()) : '';
  const intro = sc === 'sections' ? 'Choose the department you would like to meet.' : 'Meeting with the ' + host + (sec && !host.includes(sec.section_name) ? ' (' + sec.section_name + ')' : '') + '.';
  let btn = '';
  if (sc === 'slot') btn = cta('Continue', { disabled: !b.slot, arrow: true });
  if (sc === 'details') btn = cta('Review booking', { arrow: true });
  if (sc === 'review') btn = cta(b.busy ? (b.codeStep || !needsIdCheck() ? 'Booking…' : 'Sending code…') : b.codeStep ? 'Verify code & confirm' : 'Confirm booking', { disabled: !b.agreed || b.busy, arrow: true });
  const codeBox = sc === 'review' && b.codeStep ? `<div class="field" style="padding-top:12px;border-top:1px solid var(--line-soft)">
      <span class="lbl">Enter the code sent to ${esc(b.codeEmail)}</span>
      <input class="input otp" data-model="book.code" value="${esc(b.code)}" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="••••••" aria-label="Email code">
      <button class="text-btn" data-act="resendCode" style="align-self:flex-start">Resend code</button></div>` : '';
  if (sc === 'done') btn = cta(S.mode === 'desk' ? 'New intake' : 'Back to home', { arrow: true });
  return `<aside class="side"><div class="card side-card">
      <span class="side-label">${S.mode === 'desk' ? 'DESK BOOKING' : 'YOUR BOOKING'}</span>
      <span class="side-intro">${esc(intro)}</span>
      ${S.mode === 'desk' && S.desk.agent ? `<span class="muted" style="font-size:14px">Agent: ${esc(S.desk.agent.full_name)}, ${esc(S.desk.agent.company)}</span>` : ''}
      ${sel ? `<span class="side-when">${esc(sel)}</span>` : ''}
      ${sc === 'review' ? `<label class="agree"><input type="checkbox" data-act="agree" ${b.agreed ? 'checked' : ''}><span>I agree to the late-arrival and cancellation policy below</span></label>` : ''}
      ${codeBox}
      ${b.err ? `<span class="err">${esc(b.err)}</span>` : ''}
      ${btn}
    </div>
    <div class="banner warn">${I.clock}<div><b>Please arrive on time</b>If you are more than ${S.settings?.late_arrival_minutes ?? 10} minutes late, your meeting will be cancelled. Each agent can book one meeting per week.</div></div>
  </aside>`;
}

function viewSections() {
  return `<div class="stack" style="gap:16px"><p class="lead">Your meeting will be booked with the head of the department you choose.</p>
    <div class="section-grid">${S.sections.map((s) => `<button class="section-card" data-act="section" data-id="${esc(s.id)}">${I.arrowCircle.replace('22', '24').replace('22', '24')}<span class="nm">${esc(s.section_name)}</span></button>`).join('')}</div></div>`;
}

function viewSlot() {
  const b = S.book; const dates = workingDates(); const d = dates[b.dateIdx]; const desk = S.mode === 'desk';
  const chips = dates.map((x, i) => `<button class="chip${i === b.dateIdx ? ' on' : ''}" data-act="date" data-i="${i}" aria-pressed="${i === b.dateIdx}"><span class="dow">${x.dow}</span><span class="dd">${x.day}</span><span class="mon">${x.mon}</span></button>`).join('');
  let slots;
  if (b.slotsLoading) slots = '<span class="muted">Loading availability…</span>';
  else if (!b.slots.length) slots = '<span class="muted">No meeting hours on this day.</span>';
  else slots = `<div class="slots">${b.slots.map((t) => {
    const walk = desk && t.state === 'too_soon'; const off = !(t.state === 'open' || walk); const on = b.slot === t.start_time;
    const note = t.state === 'taken' ? 'BOOKED' : t.state === 'past' ? 'PASSED' : off ? 'UNAVAILABLE' : walk ? 'WALK-IN' : fmtTime(t.start_time).slice(-2);
    return `<button class="slot${on ? ' on' : ''}${walk ? ' walk' : ''}${t.state === 'taken' ? ' taken' : ''}" data-act="slot" data-ts="${esc(t.start_time)}" ${off ? 'disabled' : ''} aria-pressed="${on}"><span class="t">${esc(fmtTime(t.start_time).replace(/ [AP]M$/, ''))}</span><span class="n">${note}</span></button>`;
  }).join('')}</div>`;
  return `<div class="stack"><div class="chips">${chips}</div><span class="date-heading">${esc(d.long.toUpperCase())}</span>${slots}
    <span class="rule-note">${desk ? 'Admin override is on: walk-in slots inside the next hour are available.' : 'Meetings must be booked at least 1 hour in advance.'} Each meeting lasts ${S.settings?.slot_minutes ?? 15} minutes. One meeting per agent per week.</span></div>`;
}

function viewDetails() {
  const b = S.book; const f = b.form; const e = b.errors; const n = f.agenda.trim().length;
  const uploads = b.files.map((file) => `<div class="file"><div class="pdf">PDF</div><div class="file-txt"><span class="nm">${esc(file.name)}</span><span class="sz">Supporting document · ${esc(file.size)}</span></div><button class="icon-btn" data-act="removeFile" data-id="${file.id}" aria-label="Remove ${esc(file.name)}">${I.close()}</button></div>`).join('')
    + (b.files.length < MAX_FILES ? `<label class="drop${b.fileErr ? ' bad' : ''}">${I.upload}<span><span class="t">${b.files.length ? 'Add another document' : 'Supporting documents'}</span><span class="s">${b.files.length ? 'Optional' : 'Required'} · click to upload</span></span><input type="file" accept="application/pdf,.pdf" multiple data-files></label>` : '');
  const idBlock = civilIdBlock(b, e, 'When you confirm');
  return `<div class="form-grid">
    ${idBlock}
    ${field('Full name of representative', input('book.form.name', f.name, 'placeholder="e.g. Ahmad Hassan" autocomplete="name"', !!e.name), e.name)}
    ${field('Agent name', input('book.form.agent', f.agent, 'placeholder="Commercial agent or company" autocomplete="organization"', !!e.agent), e.agent)}
    ${field('Email', input('book.form.email', f.email, 'type="email" placeholder="name@company.com" autocomplete="email"', !!e.email), e.email)}
    ${field('Contact number', `<div class="phone${e.phone ? ' bad' : ''}"><span>+965</span><input type="tel" data-model="book.form.phone" value="${esc(f.phone)}" placeholder="5000 0000" autocomplete="tel-national"></div>`, e.phone)}
    <label class="field full"><span class="lbl-row"><span class="lbl" style="font-size:14px;font-weight:600">Agenda of the meeting</span><span id="agendaCount" style="font-size:13px;color:${agendaColor(n)}">${n} / 250 · min 30</span></span>
      <textarea class="input${e.agenda ? ' bad' : ''}" data-model="book.form.agenda" rows="4" maxlength="250" placeholder="What would you like to discuss? Include product names or registration numbers.">${esc(f.agenda)}</textarea>
      ${e.agenda ? `<span class="err">${esc(e.agenda)}</span>` : ''}</label>
    <div class="full field"><span class="lbl">Supporting documents <span style="font-weight:400;color:var(--muted)">· PDF only, up to ${MAX_FILES} files, max 5 MB each</span></span><div class="uploads">${uploads}</div>${b.fileErr ? `<span class="err">${esc(b.fileErr)}</span>` : ''}</div>
  </div>`;
}

function viewReview() {
  const b = S.book; const sec = sectionById(b.section);
  const end = new Date(new Date(b.slot).getTime() + (S.settings?.slot_minutes ?? 30) * 60000).toISOString();
  return kv([
    { k: 'Meeting with', v: hostName(hostKey()) },
    { k: 'Date & time', v: whenText(b.slot, end) },
    ...(needsIdCheck() ? [{ k: 'Civil ID', v: b.idValue.trim() }] : []),
    { k: 'Full name of representative', v: b.form.name }, { k: 'Agent name', v: b.form.agent },
    { k: 'Email', v: b.form.email }, { k: 'Contact number', v: '+965 ' + b.form.phone }, { k: 'Agenda', v: b.form.agenda },
    { k: 'Supporting documents', v: b.files.map((f) => f.name).join(', ') },
  ]);
}

function viewDone() {
  const b = S.book; const r = b.result; const pending = r.status === 'Pending';
  return `<div class="done"><div class="done-tick">${I.tick()}</div>
    <h2>${pending ? 'Booking received' : 'Meeting confirmed'}</h2>
    <span class="muted" style="font-size:15px">${pending ? 'Your booking is pending until the Ministry reception verifies your identity.' : 'Please bring your reference number to the Ministry on the day.'}</span>
    <div class="ref-card"><div class="ref-top"><span class="k">REFERENCE</span><span class="v">${esc(r.ref)}</span></div>
      ${[{ k: 'Meeting with', v: hostName(hostKey()) }, { k: 'Date & time', v: whenText(r.start_time, r.end_time) }, { k: 'Agent', v: b.form.agent }, { k: 'Status', v: statusLabel(r.status) }]
        .map((x) => `<div class="ref-row"><span class="k">${x.k}</span><span class="v">${esc(x.v)}</span></div>`).join('')}
    </div></div>`;
}

function apptCard(a) {
  const t = fmtTime(a.start_time).split(' ');
  return `<button class="appt-card" data-act="openAppt" data-id="${a.id}"><span class="appt-time"><b>${t[0]}</b><span>${t[1]}</span></span>
    <span class="appt-txt"><span class="ag">${esc(a.company)}</span><span class="sub">${esc(a.contact_name)} · ${esc(shortHost(a.host_key))}</span>
    <span class="status ${a.status}">${esc(statusLabel(a.status))}</span></span></button>`;
}

function viewDashboard() {
  const d = S.dash; const dates = workingDates(); const r = S.role;
  const scope = r === 'director' ? 'Director, Superintendent and all departments' : r === 'superintendent' ? 'your schedule and all departments' : hostName(roleHostKey()).replace('Head of ', '') + ' only';
  const onDay = (a, x) => ymd(new Date(a.start_time)) === x.ymd;
  const groupDates = d.view === 'day' ? [dates[d.dateIdx]] : dates.slice(0, 5);
  const groups = groupDates.map((x) => { const items = d.appts.filter((a) => onDay(a, x));
    return `<div class="card group"><span class="group-label">${esc(x.long.toUpperCase())}</span>${items.length ? items.map(apptCard).join('') : '<span class="empty">No meetings</span>'}</div>`; }).join('');
  return `<div class="dash">
    <div class="dash-top"><div class="scope">${I.lock}<span>You can see: ${esc(scope)}</span></div>
      <div class="seg small" role="group" aria-label="View"><button class="${d.view === 'day' ? 'on' : ''}" data-act="dashView" data-v="day">Day</button><button class="${d.view === 'week' ? 'on' : ''}" data-act="dashView" data-v="week">Week</button></div></div>
    ${d.view === 'day' ? `<div class="chips">${dates.map((x, i) => { const n = d.appts.filter((a) => onDay(a, x)).length;
      return `<button class="chip dash${i === d.dateIdx ? ' on' : ''}" data-act="dashDate" data-i="${i}"><span class="dow">${x.dow}</span><span class="dd">${x.day}</span><span class="mon">${n ? n + ' mtg' : '—'}</span></button>`; }).join('')}</div>` : ''}
    ${d.loading && !d.appts.length ? '<span class="muted">Loading timetable…</span>' : `<div class="groups">${groups}</div>`}
  </div>`;
}

function viewAppt() {
  const a = S.openAppt; if (!a) return '';
  const active = ['Pending', 'Confirmed', 'Reschedule_requested'].includes(a.status) && new Date(a.start_time) > Date.now();
  const m = S.move;
  const hosts = [...(S.role === 'director' ? ['director'] : []), 'superintendent', ...S.sections.map((s) => 'sec:' + s.id)];
  const manage = !canManage() ? `<div class="banner info"><div>Only the Director or Superintendent can change or cancel this meeting.</div></div>`
    : !active ? `<div class="banner info"><div>This meeting is ${esc(statusLabel(a.status).toLowerCase())} and can no longer be changed.</div></div>`
    : `<div class="card side-card" style="gap:12px"><span class="side-label">CHANGE MEETING</span>
        <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:12px">
          ${field('Date', `<input class="input" type="date" data-model="move.date" value="${esc(m.date)}" min="${ymd(new Date())}">`)}
          ${field('Time', `<input class="input" type="time" data-model="move.time" value="${esc(m.time)}" step="60">`)}
          ${field('Meeting with', `<div class="select-wrap"><select class="input" data-model="move.host">${hosts.map((h) => `<option value="${esc(h)}" ${h === m.host ? 'selected' : ''}>${esc(hostName(h))}</option>`).join('')}</select>${I.chevron}</div>`, '', 'full')}
        </div>
        <span class="hint">Any date and time is allowed. If another meeting already starts at that time, the two meetings swap.</span>
        ${m.err ? `<span class="err">${esc(m.err)}</span>` : ''}
        <button class="cta" data-act="moveAppt" ${m.busy ? 'disabled' : ''}>${I.resched}<span>${m.busy ? 'Saving…' : 'Save change'}</span></button>
        <button class="cta outline" data-act="cancelAppt" style="border-color:var(--danger);color:var(--danger)">Cancel meeting</button>
      </div>`;
  const files = (a.appointment_files || []).map((f) => `<button class="file plain" data-act="openPdf" data-path="${esc(f.storage_path)}" data-name="${esc(f.file_name)}"><div class="pdf" style="width:34px;height:40px;font-size:10px">PDF</div><div class="file-txt"><span class="nm">${esc(f.file_name)}</span><span class="sz">${{ agenda: 'Meeting agenda', auth: 'Authorization letter', support: 'Supporting document' }[f.kind]} · ${esc(fileSize(f.size_bytes))} · Click to view</span></div></button>`).join('');
  return `<div class="appt-layout"><div class="card appt-main">
      <div style="display:flex;flex-direction:column;gap:6px"><span class="status ${a.status}">${esc(statusLabel(a.status))}</span>
      <h2>${esc(a.company)}</h2><span class="muted" style="font-size:15px">${esc(whenText(a.start_time, a.end_time))}</span></div>
      ${kv([{ k: 'Meeting with', v: hostName(a.host_key) }, { k: 'Full name of representative', v: a.contact_name }, { k: 'Email', v: a.email }, { k: 'Contact number', v: '+965 ' + a.phone }, { k: 'Agenda', v: a.agenda_text }, { k: 'Reference', v: a.ref }, { k: 'Booked via', v: a.channel === 'desk' ? 'Reception desk' : 'Online portal' }])}
      <span class="group-label">ATTACHED FILES</span>
      <div class="files-grid">${files || '<span class="empty">No files</span>'}</div>
    </div>
    <div class="side" style="position:static">
      ${manage}
      <label class="card notes"><span class="lbl-row"><span style="font-size:14px;font-weight:700">Private notes</span><span class="note-state" id="noteState">${esc(S.noteState || 'Only visible to you')}</span></span>
        <textarea class="input" data-model="note" rows="8" placeholder="Notes are not shared with the agent or other sections.">${esc(S.note)}</textarea></label>
    </div></div>`;
}

function viewIntake() {
  const d = S.desk; const r = d.reg; const a = d.agent;
  return `<div class="flow"><div class="card panel stack">
      <p class="lead">Book an agent who arrived without an appointment, or schedule a future session.</p>
      <div class="field"><span class="lbl">Agent Civil ID</span>
        <div style="display:flex;gap:8px">${input('desk.lookup', d.lookup, 'placeholder="12 digits" inputmode="numeric" maxlength="12" style="flex:1;min-width:0" data-enter="lookup"')}
        <button class="cta" style="width:auto;height:48px;border-radius:0;padding:0 22px;background:var(--navy)" data-act="lookup">Look up</button></div>
        ${d.msg ? `<span class="${d.ok ? 'ok' : 'err'}">${esc(d.msg)}</span>` : ''}
        ${a && !a.verified ? `<div class="banner info" style="margin-top:6px"><div><b>Self-registered, not yet verified</b>Check the agent's Civil ID in person, then verify. <button class="text-btn" data-act="deskVerify">Mark as verified</button></div></div>` : ''}
        ${a?.locked_until ? `<div class="banner bad" style="margin-top:6px"><div><b>Locked</b>Late-cancellation lockout until ${esc(whenText(a.locked_until))}.</div></div>` : ''}
      </div>
      ${r ? `<div class="form-grid" style="padding:18px;border:1px solid var(--line)">
        ${field('Civil ID', input('desk.reg.civil', r.civil, 'placeholder="12 digits" inputmode="numeric" maxlength="12"'))}
        ${field('Full name of representative', input('desk.reg.name', r.name))}
        ${field('Agent name', input('desk.reg.company', r.company, 'placeholder="Company"'))}
        ${field('Email', input('desk.reg.email', r.email, 'type="email"'))}
        ${field('Contact number', `<div class="phone"><span>+965</span><input type="tel" data-model="desk.reg.phone" value="${esc(r.phone)}" placeholder="5000 0000"></div>`)}
        ${r.err ? `<span class="err full">${esc(r.err)}</span>` : ''}
        <div class="full">${cta('Register agent', { act: 'deskRegister', cls: 'outline' })}</div></div>` : ''}
      ${field('Target section', `<div class="select-wrap"><select class="input" data-model="desk.section">${S.sections.map((s) => `<option value="${esc(s.id)}" ${s.id === d.section ? 'selected' : ''}>${esc(s.section_name)}</option>`).join('')}</select>${I.chevron}</div>`)}
    </div>
    <div class="card side-card" style="gap:12px">
      ${cta('Add to admin office queue', { act: 'deskQueue', cls: 'outline' })}
      ${cta(d.busy ? 'Finding a slot…' : 'Book next available slot', { act: 'deskNext', disabled: d.busy })}
      ${cta('Choose a date and time', { act: 'deskSchedule', cls: 'outline' })}
      <span class="rule-note" style="line-height:1.5">Admin override: same-day slots inside the 1-hour window are bookable from this desk.</span>
    </div></div>`;
}

// Agents identify with their Civil ID only.
function civilIdBlock(b, e, when) {
  const ag = S.me?.agent;
  if (!needsIdCheck()) return ag ? `<span class="ok full">Verified · ${esc(ag.civil_id ? 'Civil ID ' + ag.civil_id : 'Licence ' + ag.licence_no)}</span>` : '';
  return `${field('Civil ID number', input('book.idValue', b.idValue, 'placeholder="12 digits" inputmode="numeric" maxlength="12" autocomplete="off" style="letter-spacing:.04em"', !!e.id), e.id)}
    <span class="hint" style="align-self:end;padding-bottom:6px">${when}, we'll email a one-time code to check it's you.</span>`;
}

function viewQJoin() {
  const b = S.book; const f = b.form; const e = b.errors; const n = f.agenda.trim().length; const o = S.q.overview;
  const idBlock = civilIdBlock(b, e, 'When you join');
  const panel = `<div class="form-grid">
    <p class="lead full">Take a ticket for the admin office. You'll be called in order — keep this page open to see your place in the queue.</p>
    <div class="field full qcode-box${e.qcode ? ' bad' : ''}${b.qcodeScanned ? ' ok-box' : ''}">
      <span class="lbl">Today's code <span style="font-weight:400;color:var(--muted)">· displayed at the admin office, changes every day</span></span>
      ${b.qcodeScanned
        ? `<span class="ok">✓ Code scanned. You're checked in at the Ministry for today.</span>`
        : `<div class="qcode-row"><button class="cta" data-act="scanQr" type="button" style="width:auto;padding:0 22px">Scan QR code</button>
           <span class="muted" style="font-size:13px">or type the code under the QR</span>
           <input class="input" data-model="book.qcode" value="${esc(b.qcode)}" maxlength="6" placeholder="e.g. K7QX4M" autocomplete="off" autocapitalize="characters" spellcheck="false" style="max-width:160px;letter-spacing:.2em;text-transform:uppercase"></div>`}
      ${e.qcode ? `<span class="err">${esc(e.qcode)}</span>` : ''}
    </div>
    ${idBlock}
    ${field('Full name of representative', input('book.form.name', f.name, 'placeholder="e.g. Ahmad Hassan" autocomplete="name"', !!e.name), e.name)}
    ${field('Agent name', input('book.form.agent', f.agent, 'placeholder="Commercial agent or company" autocomplete="organization"', !!e.agent), e.agent)}
    ${field('Email', input('book.form.email', f.email, 'type="email" placeholder="name@company.com" autocomplete="email"', !!e.email), e.email)}
    ${field('Contact number', `<div class="phone${e.phone ? ' bad' : ''}"><span>+965</span><input type="tel" data-model="book.form.phone" value="${esc(f.phone)}" placeholder="5000 0000" autocomplete="tel-national"></div>`, e.phone)}
    <label class="field full"><span class="lbl-row"><span class="lbl" style="font-size:14px;font-weight:600">Reason for your visit</span><span id="agendaCount" data-min="10" style="font-size:13px;color:${n >= 10 && n <= 250 ? 'var(--teal)' : 'var(--muted)'}">${n} / 250 · min 10</span></span>
      <textarea class="input${e.agenda ? ' bad' : ''}" data-model="book.form.agenda" rows="3" maxlength="250" placeholder="e.g. Collect an approval letter, submit registration paperwork.">${esc(f.agenda)}</textarea>
      ${e.agenda ? `<span class="err">${esc(e.agenda)}</span>` : ''}</label>
  </div>`;
  const codeBox = b.codeStep ? `<div class="field" style="padding-top:12px;border-top:1px solid var(--line-soft)">
      <span class="lbl">Enter the code sent to ${esc(b.codeEmail)}</span>
      <input class="input otp" data-model="book.code" value="${esc(b.code)}" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="••••••" aria-label="Email code">
      <button class="text-btn" data-act="resendCode" style="align-self:flex-start">Resend code</button></div>` : '';
  const closed = o && !o.open;
  const side = `<aside class="side"><div class="card side-card">
      <span class="side-label">ADMIN OFFICE QUEUE</span>
      <div class="q-stats"><div><span class="k">Now serving</span><span class="v">${o?.serving ? ticketNo(o.serving) : '—'}</span></div>
        <div><span class="k">Waiting</span><span class="v">${o ? o.waiting : '…'}</span></div></div>
      ${closed ? `<div class="banner warn"><div>The queue is open Sunday to Thursday, 8:00 AM to 2:00 PM.</div></div>` : ''}
      ${codeBox}
      ${b.err ? `<span class="err">${esc(b.err)}</span>` : ''}
      ${cta(b.busy ? (b.codeStep || !needsIdCheck() ? 'Joining…' : 'Sending code…') : b.codeStep ? 'Verify code & join' : 'Join the queue', { disabled: b.busy || closed, arrow: true })}
    </div></aside>`;
  return `<div class="flow"><div class="card panel">${panel}</div>${side}</div>`;
}

function viewTicket() {
  const t = S.q.ticket;
  if (!t) return `<div class="card narrow"><p class="lead">You don't have a ticket for today.</p>${cta('Join the queue', { act: 'portal' }).replace('data-act="portal"', 'data-act="portal" data-portal="admins"')}</div>`;
  const called = t.status === 'called';
  const msg = { waiting: t.ahead ? `${t.ahead} ${t.ahead === 1 ? 'person' : 'people'} ahead of you` : 'You are next', called: 'It\'s your turn — please go to the admin office now',
    served: 'Your visit is complete. Thank you.', no_show: 'You were called but did not arrive. Join again if you still need to visit.', cancelled: 'You left the queue.' }[t.status];
  return `<div class="card narrow ticket${called ? ' called' : ''}">
      <span class="side-label" style="text-align:center">ADMIN OFFICE QUEUE · ${esc(dayInfo(t.queue_day).long.toUpperCase())}</span>
      <div class="ticket-no">${ticketNo(t.number)}</div>
      <div class="ticket-msg">${esc(msg)}</div>
      ${ticketActive(t) ? `<div class="q-stats"><div><span class="k">Now serving</span><span class="v">${t.serving ? ticketNo(t.serving) : '—'}</span></div><div><span class="k">Joined</span><span class="v">${esc(fmtTime(t.created_at))}</span></div></div>` : ''}
      <span class="hint" style="text-align:center">${ticketActive(t) ? 'This page updates automatically.' : ''}</span>
      ${ticketActive(t) ? `<button class="cta outline" data-act="refreshTicket">Refresh now</button><button class="text-btn" data-act="leaveQueue" style="color:var(--danger)">Leave the queue</button>`
        : `${cta('Join again', { act: 'portal' }).replace('data-act="portal"', 'data-act="portal" data-portal="admins"')}`}
    </div>`;
}

function viewQueueDesk() {
  const q = S.qdesk; const list = q.tickets;
  const serving = list.filter((t) => t.status === 'called'); const waiting = list.filter((t) => t.status === 'waiting');
  const done = list.filter((t) => !ticketActive(t)).reverse();
  const row = (t, actions = '') => `<div class="q-row"><span class="q-no">${ticketNo(t.number)}</span>
      <span class="q-txt"><b>${esc(t.company)}</b><span>${esc(t.contact_name)} · +965 ${esc(t.phone)}${t.channel === 'desk' ? ' · Walk-in' : ''}</span><span>${esc(t.reason)}</span></span>
      <span class="q-act">${actions || `<span class="status ${t.status === 'served' ? 'Confirmed' : t.status === 'waiting' ? 'Pending' : 'Cancelled'}">${esc({ waiting: 'Waiting', served: 'Served', no_show: 'No-show', cancelled: 'Left queue' }[t.status] || t.status)}</span>`}</span></div>`;
  return `<div class="dash">
    <div class="dash-top"><div class="scope">Today · ${esc(dayInfo(ymd(new Date())).long)} · ${waiting.length} waiting</div>
      <div style="min-width:240px">${cta(q.busy ? 'Calling…' : 'Call next', { act: 'callNext', disabled: q.busy || !waiting.length, arrow: true })}</div></div>
    <div class="card group"><span class="group-label">NOW SERVING</span>
      ${serving.length ? serving.map((t) => row(t, `<button class="small-btn" data-act="finishTicket" data-id="${t.id}" data-status="served">Served</button><button class="small-btn danger" data-act="finishTicket" data-id="${t.id}" data-status="no_show">No-show</button>`)).join('') : '<span class="empty">Nobody is being served. Press “Call next”.</span>'}</div>
    <div class="card group"><span class="group-label">WAITING (${waiting.length})</span>
      ${waiting.length ? waiting.map((t) => row(t)).join('') : `<span class="empty">${q.loaded ? 'The queue is empty.' : 'Loading…'}</span>`}</div>
    ${done.length ? `<div class="card group"><span class="group-label">FINISHED TODAY</span>${done.map((t) => row(t)).join('')}</div>` : ''}
    <div class="card group qr-card"><span class="group-label">TODAY'S QR CODE</span>
      ${!q.loaded ? '<span class="empty">Loading…</span>'
        : q.code?.code ? `<div class="qr-card-body"><div class="qr-img">${q.qr || ''}</div>
        <div class="qr-info"><span class="code">${esc(q.code.code)}</span>
          <span>Valid on <b>${esc(dayInfo(q.code.day).long)}</b> only. Agents must scan it here, in person, to join the queue online. Generating a new code stops this one working straight away.</span>
          <div class="qr-actions">${cta(q.genBusy ? 'Generating…' : 'Generate new code', { act: 'generateCode', disabled: q.genBusy })}${cta('Print again', { act: 'printQr', cls: 'outline' })}</div></div></div>`
        : `<div class="qr-info"><span>No code has been generated today, so nobody can join the queue online yet. Press the button to make today's code — it prints straight away.</span>
          <div class="qr-actions">${cta(q.genBusy ? 'Generating…' : 'Generate code', { act: 'generateCode', disabled: q.genBusy, arrow: true })}</div></div>`}</div>
    <span class="hint">This screen updates automatically every 15 seconds.</span>
  </div>`;
}

const TITLES = { qjoin: 'Join the queue', ticket: 'Your ticket', queueDesk: 'Admin office queue',staffLogin: 'Staff login', otp: 'Two-factor authentication', dashboard: 'My timetable', appt: 'Meeting details', intake: 'Admin intake desk', sections: 'Choose a department', slot: 'Date & time', details: 'Your details', review: 'Review', done: 'Booking confirmed' };

function viewInner() {
  const sc = screen(); const b = S.book;
  const sec = sectionById(b.section);
  const kicker = ['staffLogin', 'otp'].includes(sc) ? 'Ministry staff'
    : sc === 'queueDesk' ? 'Signed in · Admin office'
    : ['qjoin', 'ticket'].includes(sc) ? 'Admins portal'
    : ['dashboard', 'appt'].includes(sc) ? 'Signed in · ' + hostName(roleHostKey())
    : S.mode === 'desk' ? 'Admin desk' + (sc !== 'intake' && sec ? ' · ' + sec.section_name : '')
    : b.portal ? PORTALS[b.portal] + ' portal' : '';
  const stepIdx = ['slot', 'details', 'review'].indexOf(sc);
  const steps = stepIdx >= 0 ? `<div class="steps" aria-label="Step ${stepIdx + 1} of 3">${['Time', 'Details', 'Review'].map((l, i) => `<div class="step${i <= stepIdx ? ' on' : ''}"><i></i><span>${l}</span></div>`).join('')}</div>` : '';
  const showBack = !['dashboard', 'intake', 'queueDesk'].includes(sc);
  let body;
  if (['staffLogin', 'otp'].includes(sc)) body = `<div class="card narrow">${{ staffLogin: viewStaffLogin, otp: viewOtp }[sc]()}</div>`;
  else if (['sections', 'slot', 'details', 'review', 'done'].includes(sc)) body = `<div class="flow"><div class="card panel">${{ sections: viewSections, slot: viewSlot, details: viewDetails, review: viewReview, done: viewDone }[sc]()}</div>${sidebar()}</div>`;
  else body = { dashboard: viewDashboard, appt: viewAppt, intake: viewIntake, qjoin: viewQJoin, ticket: viewTicket, queueDesk: viewQueueDesk }[sc]();
  return `<div class="inner-head"><div class="wrap">
      ${showBack ? `<button class="back" data-act="back">${I.back}<span>Back</span></button>` : ''}
      <div class="head-row"><div>${kicker ? `<span class="kicker">${esc(kicker)}</span>` : ''}<h1>${esc(TITLES[sc] || '')}</h1></div>${steps}</div>
    </div></div>
    <div class="wrap content">${body}</div>`;
}

let lastScreen = null;
function render(navigated = false) {
  const today = dayInfo(ymd(new Date()));
  document.getElementById('today').textContent = today.long + ' ' + today.year;
  const top = document.getElementById('topAction');
  const sep = '<span class="sep" style="margin:0 12px">|</span>';
  if (S.role) top.innerHTML = (S.role === 'admin' ? `<button class="linkbtn" data-act="toWorkspace">Intake desk</button>${sep}` : '')
    + (S.role === 'admin' ? `<button class="linkbtn" data-act="queueDesk">Queue</button>` : `<button class="linkbtn" data-act="timetable">My timetable</button>`)
    + `${sep}<button class="linkbtn" data-act="signOut">Sign out</button>`;
  else if (isAgent()) top.innerHTML = `<button class="linkbtn" data-act="signOut">Sign out</button>`;
  else top.innerHTML = `<button class="linkbtn" data-act="staffLogin">Staff login</button>`;

  const sc = screen();
  const main = document.getElementById('main');
  main.innerHTML = sc === 'home' ? viewHome() : viewInner();
  document.title = (sc === 'home' ? 'MOH Meeting Portal' : (TITLES[sc] || '') + ' · MOH Meeting Portal');
  if (navigated || sc !== lastScreen) { window.scrollTo(0, 0); if (sc !== lastScreen && lastScreen !== null) main.focus({ preventScroll: true }); }
  lastScreen = sc;
  // The app layout (styles under html[data-layout="app"]) styles some screens differently.
  document.body.dataset.screen = sc;
  syncPolling();
  document.body.classList.toggle('has-cta', ['slot', 'details', 'review', 'done', 'qjoin'].includes(sc));
}

// ------------------------------------------------------------------ event wiring
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  if (el.type === 'checkbox') return;
  const fn = ACT[el.dataset.act]; if (fn) fn(el, ev);
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'agree') return ACT.agree(el);
  if ('files' in el.dataset && el.files?.length) { const list = [...el.files]; el.value = ''; pickFiles(list); }
  if (el.dataset.model === 'desk.section') { S.desk.section = el.value; S.book.section = el.value; S.book.slot = null; }
});
const setPath = (path, value) => { const ks = path.split('.'); let o = S; ks.slice(0, -1).forEach((k) => { o = o[k]; }); o[ks[ks.length - 1]] = value; };
let noteTimer;
document.addEventListener('input', (ev) => {
  const el = ev.target; const m = el.dataset.model; if (!m) return;
  let val = el.value;
  if (m === 'mfa.code') { val = val.replace(/\D/g, '').slice(0, 6); el.value = val; }
  if (m === 'book.code') { val = val.replace(/\D/g, '').slice(0, 8); el.value = val; }
  setPath(m, val);
  // clear inline error as the user corrects a field
  const wrap = el.closest('.field'); if (wrap) { wrap.querySelector('.err')?.remove(); el.classList.remove('bad'); el.closest('.phone')?.classList.remove('bad'); }
  if (m.startsWith('book.form.')) delete S.book.errors[m.split('.').pop()];
  if (m === 'book.idValue') delete S.book.errors.id;
  if (m === 'book.form.agenda') { const n = val.trim().length; const c = document.getElementById('agendaCount'); if (c) { const min = Number(c.dataset.min || 30); c.textContent = n + ' / 250 · min ' + min; c.style.color = n < min ? 'var(--muted)' : n <= 250 ? 'var(--teal)' : 'var(--danger)'; } }
  if (m === 'note') {
    clearTimeout(noteTimer); const st = document.getElementById('noteState'); if (st) st.textContent = 'Saving…';
    const apptId = S.openAppt.id;
    noteTimer = setTimeout(async () => {
      const { error } = await sb.from('private_notes').upsert({ appointment_id: apptId, author_id: uid(), body: S.note, updated_at: new Date().toISOString() });
      S.noteState = error ? 'Not saved: ' + errMsg(error) : 'Saved · only visible to you';
      const s2 = document.getElementById('noteState'); if (s2) s2.textContent = S.noteState;
    }, 700);
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && document.getElementById('overlay').innerHTML) return ACT.closePdf();
  if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
  const enterAct = ev.target.dataset.enter; if (enterAct) { ev.preventDefault(); return ACT[enterAct](); }
  const btn = ev.target.closest('.card')?.querySelector('.cta:not(:disabled)');
  if (btn) { ev.preventDefault(); btn.click(); }
});

// ------------------------------------------------------------------ boot
async function boot() {
  const [sec, set] = await Promise.all([sb.from('sections').select('*').order('sort'), sb.from('settings').select('*').single()]);
  S.sections = sec.data || []; S.settings = set.data;
  try { await loadMe(); } catch (e) { await sb.auth.signOut(); S.session = null; S.me = null; }

  if (S.me?.role && S.me.role !== 'agent' && !S.role) { await sb.auth.signOut(); S.session = null; S.me = null; }
  if (S.role) return S.role === 'admin' ? startIntake() : openDashboard();

  // A code-verified session that never got linked to an agent record is discarded.
  if (S.session && !isAgent()) { await sb.auth.signOut(); S.session = null; S.me = null; }
  await loadMyAppts();
  await loadMyTicket();
  render(true);
  // Opened from the QR link (?q=CODE): go straight to the queue with the code filled in.
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    history.replaceState(null, '', location.pathname);
    S.mode = 'agent'; S.book = freshBooking({ portal: 'admins', qcode: normQueueCode(q), qcodeScanned: true });
    if (isAgent()) prefillFromAgent();
    if (ticketActive(S.q.ticket)) go('ticket'); else { go('qjoin'); loadOverview().then(() => screen() === 'qjoin' && render()); }
  }
}
boot().catch((e) => { document.getElementById('main').innerHTML = `<div class="loading">The portal could not load: ${esc(errMsg(e))}</div>`; });
