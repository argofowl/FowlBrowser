// Job sites for real-agent rounds (tools/agents/jobs.json), modeled on the jobs people gave FowlBrowser in October 2026:
// a payments dashboard (colour, logo upload, switches, a dropdown, an app shell that scrolls inside and renders late),
// an infinite feed, a kanban board dragged by pointer, a refunds admin (filter, sort, pages), a booking calendar, a
// prototype to QA on a phone and in dark mode, three pricing pages, and a downloads page. All fictional, localhost only.
//   node test/jobs/server.mjs [--port 5430]
// Every page lives under /t/<tag>/<app>/, so each agent's views and actions land in that tag's log:
// GET /t/<tag>/api/log -> {events: [{at, kind, path, detail}], lines: ["<kind> <path> <detail>"]}.
import { createServer } from 'node:http';
import { api2, initialApps2, pages2 } from './apps2.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BASE_STYLE = `
*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;color:#1c1c1e;background:#fff}
a{color:#2457c5}button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid #9a9aa0;background:#f2f2f4;cursor:pointer;color:inherit}
input,select,textarea{font:inherit;padding:6px 8px;border:1px solid #9a9aa0;border-radius:6px}
label{display:block;margin:10px 0 4px}main{padding:20px 24px}h1{margin:0 0 12px;font-size:22px}`;

function frame(title, body, { style = '', script = '', bodyAttrs = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${BASE_STYLE}${style}</style></head><body ${bodyAttrs}>${body}
<script>const BASE = location.pathname.split('/').slice(0, 3).join('/');
const api = (path, body) => fetch(BASE + '/api/' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
</script><script>${script}</script></body></html>`;
}

// --- Studio: a payments dashboard ---

const STUDIO_STYLE = `
html,body{height:100%;overflow:hidden}
.shell{display:grid;grid-template-columns:200px 1fr;height:100%}
nav.side{background:#f5f5f7;border-right:1px solid #ddd;padding:16px}nav.side a{display:block;padding:6px 8px;border-radius:6px;text-decoration:none;color:#1c1c1e}
nav.side a.on{background:#e3e3ea;font-weight:600}
#content{overflow:auto;height:100%;padding:20px 28px}
.row{display:flex;gap:10px;align-items:center}
.swatch-preview{width:28px;height:28px;border-radius:6px;border:1px solid #ccc}
.switch{display:flex;align-items:center;justify-content:space-between;max-width:460px;padding:10px 0;border-bottom:1px solid #eee}
.switch button{width:46px;height:26px;border-radius:13px;padding:0;background:#ccc;border:0;position:relative}
.switch button[aria-checked=true]{background:#34c759}
.switch button::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s}
.switch button[aria-checked=true]::after{left:23px}
.guide p{max-width:620px;color:#555}
#toast{position:fixed;right:20px;bottom:20px;background:#1c1c1e;color:#fff;padding:10px 16px;border-radius:8px;display:none}`;

const STUDIO_SCRIPT = `
const route = location.pathname.split('/').pop() || 'branding';
const root = document.getElementById('root');
const toast = (text) => { const t = document.getElementById('toast'); t.textContent = text; t.style.display = 'block'; setTimeout(() => { t.style.display = 'none'; }, 2500); };
(async () => {
  const state = await api('studio/state');
  const guide = Array.from({ length: 18 }, (_, i) => '<p>Guideline ' + (i + 1) + ': keep the logo clear of other marks by at least its own height, and use the brand colour for primary actions only.</p>').join('');
  const nav = '<nav class="side" aria-label="Dashboard"><strong>Spud Studio</strong><a href="branding"' + (route === 'branding' ? ' class="on"' : '') + '>Branding</a><a href="settings"' + (route === 'settings' ? ' class="on"' : '') + '>Settings</a></nav>';
  if (route === 'settings') {
    const sw = (id, label, on) => '<div class="switch"><span id="' + id + '-label">' + label + '</span><button role="switch" id="' + id + '" aria-labelledby="' + id + '-label" aria-checked="' + on + '"></button></div>';
    root.innerHTML = '<div class="shell">' + nav + '<div id="content"><h1>Settings</h1>' + sw('receipts', 'Email receipts to customers', state.receipts) + sw('notifications', 'Payout notifications', state.notifications) + sw('test', 'Test mode', state.test) +
      '<label for="payout">Payout schedule</label><select id="payout"><option>Daily</option><option>Weekly</option><option>Monthly</option></select>' +
      '<div class="guide"><h2>About payouts</h2>' + guide + '</div><button id="save">Save settings</button></div></div>';
    document.getElementById('payout').value = state.payout;
    for (const b of document.querySelectorAll('[role=switch]')) b.addEventListener('click', () => b.setAttribute('aria-checked', String(b.getAttribute('aria-checked') !== 'true')));
    document.getElementById('save').addEventListener('click', async () => {
      const on = (id) => document.getElementById(id).getAttribute('aria-checked') === 'true';
      await api('studio/settings', { receipts: on('receipts'), notifications: on('notifications'), test: on('test'), payout: document.getElementById('payout').value });
      toast('Settings saved');
    });
    return;
  }
  root.innerHTML = '<div class="shell">' + nav + '<div id="content"><h1>Branding</h1>' +
    '<label for="brand">Brand colour</label><div class="row"><input type="color" id="brand" value="' + state.color + '"><input id="hex" aria-label="Brand colour hex" value="' + state.color + '" size="9"><button id="pick">Pick from screen</button><span class="swatch-preview" id="preview"></span></div>' +
    '<label>Logo</label><div class="row"><span id="logo-name">' + (state.logo || 'No logo yet') + '</span><button id="upload">Upload logo</button><input type="file" id="logo-file" accept="image/*" hidden></div>' +
    '<div class="guide"><h2>Brand guidelines</h2>' + guide + '</div><button id="save">Save branding</button></div></div>';
  const brand = document.getElementById('brand');
  const hex = document.getElementById('hex');
  const preview = () => { document.getElementById('preview').style.background = brand.value; };
  brand.addEventListener('input', () => { hex.value = brand.value; preview(); });
  hex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) { brand.value = hex.value.toLowerCase(); preview(); } });
  preview();
  document.getElementById('pick').addEventListener('click', async () => {
    try { const { sRGBHex } = await new EyeDropper().open(); brand.value = sRGBHex; hex.value = sRGBHex; preview(); } catch (e) { toast('Colour picking was cancelled'); }
  });
  document.getElementById('upload').addEventListener('click', () => document.getElementById('logo-file').click());
  let logo = state.logo;
  document.getElementById('logo-file').addEventListener('change', (e) => { logo = e.target.files[0]?.name ?? logo; document.getElementById('logo-name').textContent = logo; });
  document.getElementById('save').addEventListener('click', async () => { await api('studio/branding', { color: brand.value, logo }); toast('Branding saved'); });
})();`;

// --- Feed: an infinite timeline ---

const AUTHORS = [['spudlabs', 'Spud Labs'], ['frybot', 'Fry Bot'], ['mashy', 'Mashy'], ['tuberworks', 'Tuber Works']];
const LINES = ['Shipping notes for the week.', 'Thread: what we learned from support tickets.', 'Hiring a designer, DMs open.', 'Small fix rolling out today.',
  'Our community call is on Thursday.', 'Reading list for the weekend.', 'New docs for the API are up.', 'A look behind the scenes at the studio.'];
// Oct 14 back to Sep 15, 2026: 3 posts a day at 9:00, 13:00 and 18:00 UTC. Planted: three @spudlabs launch posts on Oct
// 3-9 (the answer), and decoys around them.
const POSTS = (() => {
  const posts = [];
  let n = 0;
  for (let day = 14 + 30; day >= 15; day--) {
    const date = day > 30 ? new Date(Date.UTC(2026, 9, day - 30)) : new Date(Date.UTC(2026, 8, day));
    for (const hour of [18, 13, 9]) {
      n++;
      const at = new Date(date.getTime() + hour * 3600_000);
      const [handle, name] = AUTHORS[(n * 7 + day) % AUTHORS.length];
      posts.push({ id: `p${1000 + n}`, handle, name, at: at.toISOString(), text: LINES[(n + day) % LINES.length] });
    }
  }
  const plant = (iso, handle, text) => { const p = posts.find((x) => x.at.startsWith(iso)); Object.assign(p, { handle, name: AUTHORS.find(([h]) => h === handle)[1], text }); return p.id; };
  plant('2026-10-03T13', 'spudlabs', 'Launch day: Spudnote 2 is out for everyone. Thank you for testing it with us!');
  plant('2026-10-06T18', 'spudlabs', 'Two weeks until the Spudcut launch. Here is a first look at the timeline editor.');
  plant('2026-10-09T09', 'spudlabs', 'We just launched the Spud API beta: keys are in your dashboard.');
  plant('2026-10-10T13', 'spudlabs', 'Launch recap and what is next.'); // the day after the window
  plant('2026-10-02T18', 'spudlabs', 'Getting ready for tomorrow\'s launch.'); // the day before
  plant('2026-10-05T13', 'frybot', 'Our launch of Fry Bot 3 went great.'); // another author
  plant('2026-10-07T09', 'spudlabs', 'Office hours moved to Friday.'); // in the window, no launch
  return posts;
})();
export const FEED_ANSWER = ['2026-10-03T13', '2026-10-06T18', '2026-10-09T09'].map((iso) => POSTS.find((p) => p.at.startsWith(iso)).id);
export const FEED_DECOYS = ['2026-10-10T13', '2026-10-02T18', '2026-10-05T13', '2026-10-07T09'].map((iso) => POSTS.find((p) => p.at.startsWith(iso)).id);

const FEED_STYLE = `main{max-width:640px;margin:0 auto}article{border-bottom:1px solid #e5e5ea;padding:14px 4px}
article header{display:flex;gap:8px;color:#636366;font-size:14px}article header strong{color:#1c1c1e}#more{padding:24px;text-align:center;color:#8e8e93}`;
const FEED_SCRIPT = `
let page = 0; let loading = false; let done = false;
const list = document.getElementById('list');
const fmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
async function more() {
  if (loading || done) return;
  loading = true;
  const { posts, last } = await api('feed?page=' + page++);
  for (const p of posts) {
    const a = document.createElement('article');
    a.innerHTML = '<header><strong>' + p.name + '</strong><span>@' + p.handle + '</span><span>·</span><a href="post/' + p.id + '"><time datetime="' + p.at + '">' + fmt(p.at) + '</time></a></header><p></p>';
    a.querySelector('p').textContent = p.text;
    list.appendChild(a);
  }
  done = last;
  if (done) document.getElementById('more').textContent = 'You are all caught up.';
  loading = false;
}
new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: '300px' }).observe(document.getElementById('more'));`;

// --- Board: kanban dragged by pointer ---

const CARDS = [['write-notes', 'Write release notes', 'todo'], ['fix-login', 'Fix login bug', 'todo'], ['icons', 'Draw new icons', 'todo'],
  ['perf', 'Speed up search', 'doing'], ['onboard', 'Onboarding emails', 'doing'], ['pricing', 'Pricing page copy', 'done']];
const BOARD_STYLE = `.cols{display:grid;grid-template-columns:repeat(3,260px);gap:16px}.col{background:#f2f2f6;border-radius:10px;padding:10px;min-height:340px}
.col h2{font-size:15px;margin:0 0 8px}.card{background:#fff;border:1px solid #d1d1d6;border-radius:8px;padding:10px;margin:8px 0;cursor:grab;user-select:none;touch-action:none}
.card.lifted{opacity:.85;box-shadow:0 6px 18px rgba(0,0,0,.2);position:fixed;pointer-events:none;width:240px;z-index:5}.col.over{outline:2px dashed #2457c5}`;
const BOARD_SCRIPT = `
const cols = { todo: 'To do', doing: 'Doing', done: 'Done' };
(async () => {
  const { cards } = await api('board/state');
  const root = document.getElementById('cols');
  for (const [id, name] of Object.entries(cols)) root.insertAdjacentHTML('beforeend', '<section class="col" data-col="' + id + '" aria-label="' + name + '"><h2>' + name + '</h2></section>');
  for (const c of cards) document.querySelector('[data-col=' + c.col + ']').insertAdjacentHTML('beforeend', '<div class="card" data-id="' + c.id + '">' + c.title + '</div>');
  // Pointer drag (no HTML5 drag and drop): press on a card, move, release over a column.
  let drag = null;
  addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card'); if (!card) return;
    drag = { card, dx: e.clientX - card.getBoundingClientRect().left, dy: e.clientY - card.getBoundingClientRect().top, moved: 0 };
    card.setPointerCapture?.(e.pointerId);
  });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.moved++;
    if (drag.moved === 2) drag.card.classList.add('lifted');
    drag.card.style.left = (e.clientX - drag.dx) + 'px'; drag.card.style.top = (e.clientY - drag.dy) + 'px';
    for (const col of document.querySelectorAll('.col')) { const r = col.getBoundingClientRect(); col.classList.toggle('over', e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom); }
  });
  addEventListener('pointerup', async (e) => {
    if (!drag) return;
    const { card } = drag; drag = null;
    card.classList.remove('lifted'); card.style.left = card.style.top = '';
    const col = [...document.querySelectorAll('.col')].find((c) => { const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
    for (const c of document.querySelectorAll('.col')) c.classList.remove('over');
    if (!col || col.contains(card) && card.parentElement === col) return;
    col.appendChild(card);
    await api('board/move', { id: card.dataset.id, col: col.dataset.col });
  });
})();`;

// --- Admin: refunds with a month filter, sorting and pages ---

const PEOPLE = ['Ana Lima', 'Ben Okafor', 'Chloe Martin', 'Dev Patel', 'Elif Kaya', 'Femi Adeyemi', 'Grace Chen', 'Hugo Silva', 'Ines Moreau', 'Jun Park',
  'Kofi Mensah', 'Lena Vogel', 'Mateo Ruiz', 'Nora Lind', 'Omar Haddad', 'Priya Natarajan', 'Quinn Doyle', 'Rosa Bianchi', 'Sven Berg', 'Tara Singh'];
const REASONS = ['Damaged in transit', 'Wrong size', 'Duplicate charge', 'Not as described', 'Changed mind', 'Late delivery'];
const REFUNDS = (() => {
  const rows = [];
  for (let i = 0; i < 180; i++) {
    const month = 6 + (i % 4); // July..October 2026
    const day = 1 + ((i * 7) % 28);
    const amount = Math.round(((i * 7919) % 120000) / 100 + 20) + ((i * 13) % 100) / 100;
    rows.push({ id: `R-${5000 + i}`, date: `2026-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`, customer: PEOPLE[(i * 3) % PEOPLE.length],
      order: `#${88000 + i * 3}`, amount: Math.min(amount, 1200), reason: REASONS[i % REASONS.length] });
  }
  // September's largest (the answer), and larger ones in other months.
  rows[37] = { ...rows[37], date: '2026-09-17', customer: 'Priya Natarajan', amount: 1842.5, reason: 'Duplicate charge' };
  rows[52] = { ...rows[52], date: '2026-08-29', customer: 'Hugo Silva', amount: 2310, reason: 'Not as described' };
  rows[101] = { ...rows[101], date: '2026-10-02', customer: 'Lena Vogel', amount: 1999, reason: 'Wrong size' };
  return rows;
})();
const ADMIN_SCRIPT = `
let rows = []; let page = 0; let sort = null; const per = 20;
const body = document.querySelector('tbody'); const month = document.getElementById('month');
function view() {
  let shown = rows.filter((r) => !month.value || r.date.slice(5, 7) === month.value);
  if (sort) shown = [...shown].sort((a, b) => (a.amount - b.amount) * sort);
  const pages = Math.max(1, Math.ceil(shown.length / per)); page = Math.min(page, pages - 1);
  body.innerHTML = shown.slice(page * per, page * per + per).map((r) => '<tr><td>' + r.date + '</td><td>' + r.customer + '</td><td>' + r.order + '</td><td>$' + r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '</td><td>' + r.reason + '</td></tr>').join('');
  document.getElementById('status').textContent = 'Page ' + (page + 1) + ' of ' + pages + ' · ' + shown.length + ' refunds';
  document.getElementById('prev').disabled = page === 0; document.getElementById('next').disabled = page >= pages - 1;
}
(async () => { rows = (await api('admin/refunds')).rows; view(); })();
month.addEventListener('change', () => { page = 0; view(); });
document.getElementById('prev').addEventListener('click', () => { page--; view(); });
document.getElementById('next').addEventListener('click', () => { page++; view(); });
document.getElementById('sort').addEventListener('click', (e) => { sort = sort === -1 ? 1 : -1; e.target.textContent = 'Amount ' + (sort === -1 ? '↓' : '↑'); view(); });`;

// --- Book: a calendar with slots and a confirmation step ---

const TAKEN = { '2026-10-20': ['12:00', '12:30', '13:00', '15:00'] };
const SLOTS = Array.from({ length: 18 }, (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const BOOK_STYLE = `.cal{display:grid;grid-template-columns:repeat(7,44px);gap:6px;margin:12px 0}.cal button{padding:8px 0}.cal .dow{text-align:center;color:#8e8e93;font-size:12px}
#slots{display:flex;flex-wrap:wrap;gap:8px;max-width:520px}#slots button[disabled]{text-decoration:line-through;opacity:.45}.picked{outline:2px solid #2457c5}
dialog{border-radius:12px;border:1px solid #ccc;padding:20px}`;
const BOOK_SCRIPT = `
let shown = new Date(Date.UTC(2026, 9, 1)); let date = null; let slot = null;
const cal = document.getElementById('cal');
function month() {
  document.getElementById('month').textContent = shown.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  cal.innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => '<span class="dow">' + d + '</span>').join('');
  const first = (shown.getUTCDay() + 6) % 7;
  for (let i = 0; i < first; i++) cal.insertAdjacentHTML('beforeend', '<span></span>');
  const days = new Date(Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth() + 1, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const at = new Date(Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth(), d));
    const label = at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    cal.insertAdjacentHTML('beforeend', '<button data-date="' + at.toISOString().slice(0, 10) + '" aria-label="' + label + '">' + d + '</button>');
  }
}
cal.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-date]'); if (!b) return;
  date = b.dataset.date; slot = null;
  for (const x of cal.querySelectorAll('button')) x.classList.toggle('picked', x === b);
  const { slots } = await api('book/slots?date=' + date);
  document.getElementById('slots').innerHTML = slots.map((s) => '<button data-slot="' + s.time + '"' + (s.free ? '' : ' disabled') + '>' + s.time + '</button>').join('');
  document.getElementById('details').hidden = true;
});
document.getElementById('slots').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-slot]'); if (!b) return;
  slot = b.dataset.slot;
  for (const x of document.querySelectorAll('#slots button')) x.classList.toggle('picked', x === b);
  document.getElementById('details').hidden = false;
});
document.getElementById('prevm').addEventListener('click', () => { shown = new Date(Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth() - 1, 1)); month(); });
document.getElementById('nextm').addEventListener('click', () => { shown = new Date(Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth() + 1, 1)); month(); });
document.getElementById('continue').addEventListener('click', async () => {
  const name = document.getElementById('name').value; const email = document.getElementById('email').value;
  if (!date || !slot || !name || !email) return alert('Pick a day and a time, and fill in your name and email.');
  await api('book/continue', { date, slot, name, email });
  document.getElementById('summary').textContent = '30-minute call on ' + date + ' at ' + slot + ' for ' + name + ' (' + email + ')';
  document.getElementById('confirm-dialog').showModal();
});
document.getElementById('confirm').addEventListener('click', async () => { await api('book/confirm', { date, slot }); document.getElementById('confirm-dialog').close(); document.getElementById('done').hidden = false; });
document.getElementById('back').addEventListener('click', () => document.getElementById('confirm-dialog').close());
month();`;

// --- Proto: a prototype with three variants to QA ---

const PROTO_STYLE = {
  A: `.card{max-width:420px;margin:40px auto;padding:24px;border-radius:14px;border:1px solid #ddd}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.card{border-color:#333}}`,
  B: `.card{max-width:420px;margin:40px auto;padding:24px;border-radius:14px;border:1px solid #ddd}.promo{width:480px;background:#ffe9a8;padding:10px;border-radius:8px}`,
  C: `.card{max-width:420px;margin:40px auto;padding:24px;border-radius:14px;border:1px solid #ddd}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.card{border-color:#333}}`,
};

// --- Pricing: three vendors, three layouts ---

const PRICING = {
  north: (b) => frame('Northwind Notes pricing', `<main><h1>Northwind Notes</h1><table border="1" cellpadding="8"><tr><th>Plan</th><th>Per month</th></tr>
<tr><td>Free</td><td>$0</td></tr><tr><td>Pro</td><td>$14</td></tr><tr><td>Team</td><td>$22 per seat</td></tr></table></main>`),
  // Yearly prices by default; monthly behind a toggle.
  quill: (b) => frame('Quill pricing', `<main><h1>Quill</h1><div role="radiogroup" aria-label="Billing"><button role="radio" aria-checked="true" id="yearly">Yearly</button>
<button role="radio" aria-checked="false" id="monthly">Monthly</button></div><div class="plans"><section><h2>Pro</h2><p class="price" data-y="$96 / year" data-m="$11 / month">$96 / year</p></section>
<section><h2>Business</h2><p class="price" data-y="$192 / year" data-m="$19 / month">$192 / year</p></section></div></main>`, { script: `
for (const id of ['yearly', 'monthly']) document.getElementById(id).addEventListener('click', () => {
  for (const r of document.querySelectorAll('[role=radio]')) r.setAttribute('aria-checked', String(r.id === id));
  for (const p of document.querySelectorAll('.price')) p.textContent = id === 'yearly' ? p.dataset.y : p.dataset.m;
});` }),
  // Prices inside collapsed details.
  ledger: (b) => frame('Ledgerly pricing', `<main><h1>Ledgerly</h1><details><summary>Starter</summary><p>$6 per month, billed monthly.</p></details>
<details><summary>Pro</summary><p>$12.50 per month, billed monthly. Unlimited notebooks.</p></details><details><summary>Enterprise</summary><p>Talk to us.</p></details></main>`),
};

// --- Downloads ---

const APPS = [['spudnote', 'Spudnote', 'Spudnote-2.4.1.dmg'], ['spudcut', 'Spudcut', 'Spudcut-1.0.3.dmg'], ['spudbar', 'Spudbar', 'Spudbar-0.9.dmg']];

// --- Server ---

export function logLines(events) {
  return events.map((e) => [e.kind, e.path, e.detail].filter((x) => x !== undefined && x !== '').join(' '));
}

function initialState() {
  return {
    events: [],
    studio: { color: '#5b5bd6', logo: '', receipts: false, notifications: false, test: true, payout: 'Daily' },
    board: CARDS.map(([id, title, col]) => ({ id, title, col })),
    apps2: initialApps2(),
  };
}

export function startServer({ port = 5430 } = {}) {
  const tags = new Map();
  const stateOf = (tag) => { if (!tags.has(tag)) tags.set(tag, initialState()); return tags.get(tag); };

  async function handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const m = /^\/t\/([\w-]+)\/(\w+)\/?(.*)$/.exec(url.pathname);
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
    const html = (body) => send(200, 'text/html; charset=utf-8', body);
    const json = (value) => send(200, 'application/json', JSON.stringify(value));
    if (!m) return send(404, 'text/plain', 'not found');
    const [, tag, area, route] = m;
    const state = stateOf(tag);
    const log = (kind, path, detail = '') => state.events.push({ at: Date.now(), kind, path, detail: String(detail) });
    if (area === 'api') {
      if (route === 'log') return json({ events: state.events, lines: logLines(state.events) });
      const body = req.method === 'POST' ? JSON.parse(await new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => resolve(d || '{}')); })) : {};
      if (route.startsWith('apps2/')) {
        const value = await api2(route.slice('apps2/'.length), { body, url, state, log });
        if (value !== undefined) return json(value);
      }
      if (route === 'studio/state') { await sleep(700); return json(state.studio); }
      if (route === 'studio/branding') {
        Object.assign(state.studio, { color: String(body.color).toLowerCase(), logo: String(body.logo ?? '') });
        log('action', '/studio/branding', `color=${state.studio.color} logo=${state.studio.logo}`);
        return json({ ok: true });
      }
      if (route === 'studio/settings') {
        Object.assign(state.studio, { receipts: !!body.receipts, notifications: !!body.notifications, test: !!body.test, payout: String(body.payout) });
        const on = (v) => (v ? 'on' : 'off');
        log('action', '/studio/settings', `receipts=${on(body.receipts)} notifications=${on(body.notifications)} test=${on(body.test)} payout=${String(body.payout).toLowerCase()}`);
        return json({ ok: true });
      }
      if (route === 'feed') {
        const page = Number(url.searchParams.get('page')) || 0;
        await sleep(250);
        log('load', '/feed', `page ${page}`);
        return json({ posts: POSTS.slice(page * 10, page * 10 + 10), last: page * 10 + 10 >= POSTS.length });
      }
      if (route === 'board/state') return json({ cards: state.board });
      if (route === 'board/move') {
        const card = state.board.find((c) => c.id === body.id);
        if (card) { card.col = String(body.col); log('action', '/board/move', `${card.id} ${card.col}`); }
        return json({ ok: !!card });
      }
      if (route === 'admin/refunds') { await sleep(400); return json({ rows: REFUNDS }); }
      if (route === 'book/slots') {
        const date = url.searchParams.get('date');
        await sleep(300);
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        return json({ slots: weekday === 0 || weekday === 6 ? [] : SLOTS.map((time) => ({ time, free: !(TAKEN[date] ?? []).includes(time) })) });
      }
      if (route === 'size') {
        state.events.push({ at: Date.now(), kind: 'size', path: String(body.path), detail: `${body.width}x${body.height}`, width: Number(body.width), height: Number(body.height) });
        return json({ ok: true });
      }
      if (route === 'book/continue') { log('action', '/book/continue', `${body.date} ${body.slot} ${body.name} ${body.email}`); return json({ ok: true }); }
      if (route === 'book/confirm') { log('action', '/book/confirm', `${body.date} ${body.slot}`); return json({ ok: true }); }
      return send(404, 'text/plain', 'no such api');
    }
    log('view', `/${area}/${route}`.replace(/\/$/, '') || '/');
    const second = pages2(frame)[area];
    if (second) return html(second());
    if (area === 'studio') return html(frame('Spud Studio', '<div id="root" class="loading"></div><div id="toast" role="status"></div>', { style: STUDIO_STYLE, script: STUDIO_SCRIPT }));
    if (area === 'feed') {
      const post = /^post\/(p\d+)$/.exec(route);
      if (post) {
        const p = POSTS.find((x) => x.id === post[1]);
        if (!p) return send(404, 'text/plain', 'no such post');
        return html(frame(`${p.name} on Spudnet`, `<main><article><header><strong>${esc(p.name)}</strong> @${esc(p.handle)} · <time datetime="${p.at}">${p.at.slice(0, 10)}</time></header><p>${esc(p.text)}</p></article><a href="../">Back to the feed</a></main>`, { style: FEED_STYLE }));
      }
      return html(frame('Spudnet', '<main><h1>Home</h1><div id="list" role="feed" aria-label="Posts"></div><div id="more">Loading more…</div></main>', { style: FEED_STYLE, script: FEED_SCRIPT }));
    }
    if (area === 'board') return html(frame('Team board', '<main><h1>Team board</h1><div class="cols" id="cols"></div></main>', { style: BOARD_STYLE, script: BOARD_SCRIPT }));
    if (area === 'admin') {
      const months = [['', 'All months'], ['07', 'July 2026'], ['08', 'August 2026'], ['09', 'September 2026'], ['10', 'October 2026']];
      return html(frame('Refunds · Admin', `<main><h1>Refunds</h1><label for="month">Month</label><select id="month">${months.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
<table><thead><tr><th>Date</th><th>Customer</th><th>Order</th><th><button id="sort">Amount</button></th><th>Reason</th></tr></thead><tbody></tbody></table>
<p><button id="prev">Previous</button> <span id="status"></span> <button id="next">Next</button></p></main>`, { style: 'td,th{padding:6px 10px;border-bottom:1px solid #e5e5ea;text-align:left}table{border-collapse:collapse;margin-top:12px}', script: ADMIN_SCRIPT }));
    }
    if (area === 'book') {
      return html(frame('Book a call', `<main><h1>Book a 30-minute call</h1><p><button id="prevm" aria-label="Previous month">‹</button> <strong id="month"></strong> <button id="nextm" aria-label="Next month">›</button></p>
<div class="cal" id="cal" role="group" aria-label="Days"></div><h2>Times</h2><div id="slots" role="group" aria-label="Times"><p>Pick a day first.</p></div>
<div id="details" hidden><label for="name">Your name</label><input id="name" autocomplete="name"><label for="email">Email</label><input id="email" type="email" autocomplete="email"><p><button id="continue">Continue</button></p></div>
<p id="done" hidden>Booked! See you then.</p>
<dialog id="confirm-dialog"><h2>Confirm your booking</h2><p id="summary"></p><button id="back">Back</button> <button id="confirm">Confirm booking</button></dialog></main>`, { style: BOOK_STYLE, script: BOOK_SCRIPT }));
    }
    if (area === 'proto') {
      const variant = ['A', 'B', 'C'].includes(url.searchParams.get('variant')) ? url.searchParams.get('variant') : 'A';
      const promo = variant === 'B' ? '<div class="promo">Join 40,000 cooks planning their week with Spudnote</div>' : '<p>Join 40,000 cooks planning their week.</p>';
      // The page reports its size on load and after a resize (the grader checks a phone width was reached and undone).
      const size = "let sized = ''; const size = () => { const s = innerWidth + 'x' + innerHeight; if (s !== sized) { sized = s; api('size', { path: location.pathname.slice(BASE.length), width: innerWidth, height: innerHeight }); } }; let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(size, 150); }); size();";
      const script = size + (variant === 'C' ? "console.error('Failed to load avatar sprite: /sprites/avatars@2x.png (404)'); fetch(BASE + '/proto/sprites/avatars@2x.png');" : '');
      return html(frame(`Sign up · variant ${variant}`, `<div class="card"><h1>Create your account</h1>${promo}<label for="em">Email</label><input id="em" type="email" style="width:100%"><label for="pw">Password</label><input id="pw" type="password" style="width:100%"><p><button>Sign up</button></p></div>`, { style: PROTO_STYLE[variant], script }));
    }
    if (area === 'motion') {
      // A menu drawer that slides in (A), or that just appears with no transition (B): only seen while it moves.
      const variant = url.searchParams.get('variant') === 'B' ? 'B' : 'A';
      const style = `.drawer{position:fixed;inset:0 auto 0 0;width:280px;background:#1c1c1e;color:#fff;padding:24px;transform:translateX(-100%);${variant === 'A' ? 'transition:transform 450ms cubic-bezier(.2,.8,.2,1);' : ''}}
.drawer.open{transform:none}.drawer a{display:block;color:#fff;margin:12px 0}`;
      return html(frame(`Spudnote · variant ${variant}`, `<main style="margin-left:300px"><h1>Spudnote</h1><p><button id="menu" aria-expanded="false">Open menu</button></p><p>This week's plan: 5 recipes.</p></main>
<nav class="drawer" id="drawer" aria-label="Menu"><a href="#">Plans</a><a href="#">Recipes</a><a href="#">Shopping list</a><p><button id="close">Close menu</button></p></nav>`,
        { style, script: `const d = document.getElementById('drawer'), m = document.getElementById('menu');
const set = (open) => { d.classList.toggle('open', open); m.setAttribute('aria-expanded', String(open)); };
m.addEventListener('click', () => set(true)); document.getElementById('close').addEventListener('click', () => set(false));` }));
    }
    if (area === 'pricing' && PRICING[route]) return html(PRICING[route]());
    if (area === 'apps') {
      const file = /^files\/([\w.-]+\.dmg)$/.exec(route);
      if (file) {
        log('download', '/apps/files', file[1]);
        return send(200, 'application/octet-stream', `fictional disk image ${file[1]}\n`, { 'content-disposition': `attachment; filename="${file[1]}"` });
      }
      // The buttons start the download from script (no plain link to copy).
      return html(frame('Spud apps', `<main><h1>Our apps</h1>${APPS.map(([id, name]) => `<section><h2>${name}</h2><button data-app="${id}">Download for Mac</button> <button data-app="${id}" data-win>Download for Windows</button></section>`).join('')}</main>`,
        { script: `const files = ${JSON.stringify(Object.fromEntries(APPS.map(([id, , f]) => [id, f])))};
for (const b of document.querySelectorAll('button[data-app]')) b.addEventListener('click', () => {
  if (b.hasAttribute('data-win')) return alert('The Windows version is coming soon.');
  const a = document.createElement('a'); a.href = 'files/' + files[b.dataset.app]; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
});` }));
    }
    return send(404, 'text/plain', 'not found');
  }

  const server = createServer((req, res) => handle(req, res).catch((error) => { res.writeHead(500); res.end(String(error?.message ?? error)); }));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 5430;
  await startServer({ port });
  console.log(`jobs site on http://127.0.0.1:${port}/t/<tag>/{studio/branding,feed/,board/,admin/,book/,proto/?variant=A,motion/?variant=A,pricing/north,apps/}`);
}
