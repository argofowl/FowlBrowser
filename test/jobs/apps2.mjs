// The second set of job apps (tools/agents/jobs2.json): the friction real jobs met, each in a fictional app. Mail (row
// actions only on hover, keyboard shortcuts, a right-click menu, a rich-text draft that must not be sent), Files (a
// drop-only upload zone, a right-click rename), Orders (a virtualized table behind a cookie banner), Prefs (native
// date, time, range and colour inputs, a confirmation toast that disappears), Chat (older messages load on scrolling
// up, a composer at the foot of the window, @mention suggestions) and Sheet (cells edited in place, totals recomputed).
// Served by test/jobs/server.mjs under /t/<tag>/<app>/; each app logs to the tag's log through `log(kind, path, detail)`.

export const MAILS = [
  { id: 'm1', from: 'Spud Weekly', subject: 'Issue 41: harvest tips', newsletter: true },
  { id: 'm2', from: 'Dana Reyes', subject: 'Contract draft for review', newsletter: false },
  { id: 'm3', from: 'Sam Ortiz', subject: 'Offsite on Friday?', newsletter: false, body: 'We are planning the offsite for Friday at the lake house. Are you in?' },
  { id: 'm4', from: 'Spud Weekly', subject: 'Issue 42: storage myths', newsletter: true },
  { id: 'm5', from: 'Billing', subject: 'Your invoice INV-7731', newsletter: false },
  { id: 'm6', from: 'Spud Weekly', subject: 'Issue 43: soil and you', newsletter: true },
  { id: 'm7', from: 'Priya Natarajan', subject: 'Lunch next week', newsletter: false },
];

export const ORDERS = Array.from({ length: 600 }, (_, i) => {
  const cities = ['Lisbon', 'Osaka', 'Denver', 'Tallinn', 'Accra', 'Hobart', 'Quito', 'Bergen', 'Pune', 'Leeds'];
  const statuses = ['Delivered', 'Shipped', 'Processing', 'Refunded', 'On hold'];
  return { id: 48000 + i * 7 + (i % 5), customer: `Customer ${String(i + 1).padStart(3, '0')}`, city: cities[(i * 7) % cities.length], status: statuses[(i * 3) % statuses.length], total: 20 + ((i * 37) % 480) };
});
// The one asked for: far down the list.
ORDERS[412] = { ...ORDERS[412], id: 48213, customer: 'Mira Hale', city: 'Bergen', status: 'On hold' };

const CHAT = (() => {
  const people = ['Sam Ortiz', 'Dana Reyes', 'Kofi Mensah', 'Elif Kaya'];
  const lines = ['Morning all', 'Pushed the fix', 'Can someone review my PR?', 'Lunch?', 'Docs are updated', 'Ship it', 'Back in 10', 'Nice work'];
  const msgs = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, who: people[i % 4], text: lines[(i * 3) % lines.length] }));
  msgs[17] = { id: 'c17', who: 'Dana Reyes', text: 'Agreed: the beta goes out on November 4. Locking that date.' };
  msgs[18] = { id: 'c18', who: 'Kofi Mensah', text: 'November 4 works for QA.' };
  msgs[60] = { id: 'c60', who: 'Sam Ortiz', text: 'Was the beta date November 11? I lost track.' }; // a decoy, later
  return msgs; // oldest first
})();

const SHEET = [['Item', 'January', 'February', 'March'], ['Marketing', 3200, 2800, 3900], ['Hosting', 1200, 1200, 1250], ['Salaries', 18000, 18000, 18500], ['Travel', 600, 0, 950]];

export function initialApps2() {
  return {
    mail: { archived: [], unread: ['m2', 'm3', 'm5'], deleted: [], drafts: {} },
    files: { files: [['f1', 'draft-final-v2.docx', 'root'], ['f2', 'logo.png', 'root'], ['f3', 'budget.xlsx', 'root'], ['f4', 'old-report.pdf', 'reports']].map(([id, name, folder]) => ({ id, name, folder })) },
    prefs: {},
    chat: { posted: [] },
    sheet: SHEET.map((row) => [...row]),
  };
}

const STYLE = `
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.rows{border:1px solid #e5e5ea;border-radius:10px;max-width:760px}
.row{display:flex;gap:12px;align-items:center;padding:10px 12px;border-bottom:1px solid #f0f0f3;position:relative;cursor:default}
.row.unread .subject{font-weight:700}.row.sel{background:#eaf1ff}
.row .actions{display:none;position:absolute;right:8px;gap:6px}.row:hover .actions{display:flex}
.menu{position:fixed;background:#fff;border:1px solid #ccc;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15);padding:4px;z-index:20}
.menu button{display:block;width:100%;text-align:left;border:0;background:none;padding:6px 12px}.menu button:hover{background:#eef}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1c1c1e;color:#fff;padding:10px 18px;border-radius:10px}`;

const MAIL_SCRIPT = `
let state = await api('apps2/mail/state');
let sel = 0; let menu = null;
const list = document.getElementById('list');
function draw() {
  const shown = MAILS.filter((m) => !state.archived.includes(m.id) && !state.deleted.includes(m.id));
  sel = Math.min(sel, shown.length - 1);
  list.innerHTML = shown.map((m, i) => '<div class="row' + (state.unread.includes(m.id) ? ' unread' : '') + (i === sel ? ' sel' : '') + '" data-id="' + m.id + '" role="row" tabindex="-1">' +
    '<span class="from">' + m.from + '</span><span class="subject">' + m.subject + '</span>' +
    '<span class="actions"><button data-act="archive" aria-label="Archive">Archive</button><button data-act="delete" aria-label="Delete">Delete</button></span></div>').join('');
}
const act = async (id, action) => { state = await api('apps2/mail/' + action, { id }); draw(); };
list.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); const row = e.target.closest('.row'); if (!row) return;
  if (b) return act(row.dataset.id, b.dataset.act);
  if (row.dataset.id === 'm3') return openMail('m3');
  sel = [...list.children].indexOf(row); draw();
});
list.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  e.preventDefault(); menu?.remove();
  menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'menu');
  menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
  menu.innerHTML = '<button role="menuitem" data-m="unread">Mark as unread</button><button role="menuitem" data-m="read">Mark as read</button><button role="menuitem" data-m="archive">Archive</button>';
  menu.addEventListener('click', (ev) => { const m = ev.target.dataset.m; menu.remove(); menu = null; if (m) act(row.dataset.id, m); });
  document.body.appendChild(menu);
});
addEventListener('click', (e) => { if (menu && !menu.contains(e.target)) { menu.remove(); menu = null; } });
addEventListener('keydown', (e) => {
  if (e.target.closest('input, [contenteditable]')) return;
  const rows = [...list.children];
  if (e.key === 'j') sel = Math.min(rows.length - 1, sel + 1);
  else if (e.key === 'k') sel = Math.max(0, sel - 1);
  else if (e.key === 'e' && rows[sel]) return act(rows[sel].dataset.id, 'archive');
  else if (e.key === '#' && rows[sel]) return act(rows[sel].dataset.id, 'delete');
  else if (e.key === 'Enter' && rows[sel]) return openMail(rows[sel].dataset.id);
  else return;
  draw();
});
function openMail(id) {
  const m = MAILS.find((x) => x.id === id);
  document.getElementById('reader').innerHTML = '<h2>' + m.subject + '</h2><p><strong>' + m.from + '</strong></p><p>' + (m.body ?? '…') + '</p><button id="reply">Reply</button>';
  document.getElementById('reply').addEventListener('click', () => {
    const c = document.getElementById('compose'); c.hidden = false;
    document.getElementById('to').textContent = m.from;
    const editor = document.getElementById('editor');
    let timer; editor.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => api('apps2/mail/draft', { id, html: editor.innerHTML, text: editor.innerText }), 600); });
  });
}
document.getElementById('send').addEventListener('click', async () => { await api('apps2/mail/send', { text: document.getElementById('editor').innerText }); document.getElementById('compose').hidden = true; });
draw();`;

const FILES_SCRIPT = `
let state = await api('apps2/files/state'); let folder = 'root'; let menu = null;
function draw() {
  document.getElementById('where').textContent = folder === 'root' ? 'My files' : 'My files › Reports';
  document.getElementById('grid').innerHTML = (folder === 'root' ? '<div class="row folder" data-folder="reports" role="row">📁 Reports</div>' : '<div class="row folder" data-folder="root" role="row">⬆︎ Back to My files</div>') +
    state.files.filter((f) => f.folder === folder).map((f) => '<div class="row file" data-id="' + f.id + '" role="row">📄 <span class="name">' + f.name + '</span></div>').join('');
}
document.getElementById('grid').addEventListener('dblclick', (e) => { const f = e.target.closest('[data-folder]'); if (f) { folder = f.dataset.folder; draw(); } });
document.getElementById('grid').addEventListener('click', (e) => { const f = e.target.closest('[data-folder]'); if (f) { folder = f.dataset.folder; draw(); } });
document.getElementById('grid').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.file'); if (!row) return;
  e.preventDefault(); menu?.remove();
  menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'menu');
  menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
  menu.innerHTML = '<button role="menuitem" data-m="rename">Rename</button><button role="menuitem" data-m="trash">Move to trash</button>';
  menu.addEventListener('click', async (ev) => {
    const m = ev.target.dataset.m; menu.remove(); menu = null;
    if (m === 'trash') { state = await api('apps2/files/trash', { id: row.dataset.id }); return draw(); }
    const name = row.querySelector('.name'); const input = document.createElement('input'); input.value = name.textContent; input.setAttribute('aria-label', 'New name');
    name.replaceWith(input); input.focus(); input.select();
    input.addEventListener('keydown', async (k) => { if (k.key === 'Enter') { state = await api('apps2/files/rename', { id: row.dataset.id, name: input.value }); draw(); } if (k.key === 'Escape') draw(); });
  });
  document.body.appendChild(menu);
});
addEventListener('click', (e) => { if (menu && !menu.contains(e.target)) { menu.remove(); menu = null; } });
const zone = document.getElementById('zone');
zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('over'));
zone.addEventListener('drop', async (e) => {
  e.preventDefault(); zone.classList.remove('over');
  for (const file of e.dataTransfer.files) state = await api('apps2/files/upload', { name: file.name, size: file.size, folder });
  draw();
});
draw();`;

const ORDERS_SCRIPT = `
const { rows } = await api('apps2/orders/rows');
const box = document.getElementById('box'); const inner = document.getElementById('inner');
const H = 36; inner.style.height = rows.length * H + 'px';
function draw() {
  const first = Math.max(0, Math.floor(box.scrollTop / H) - 3); const last = Math.min(rows.length, first + Math.ceil(box.clientHeight / H) + 6);
  inner.innerHTML = rows.slice(first, last).map((r, i) => '<div class="orow" role="row" style="top:' + (first + i) * H + 'px"><span role="cell">#' + r.id + '</span><span role="cell">' + r.customer + '</span><span role="cell">' + r.city + '</span><span role="cell">' + r.status + '</span><span role="cell">$' + r.total + '</span></div>').join('');
}
box.addEventListener('scroll', draw); draw();
document.getElementById('accept').addEventListener('click', () => { document.getElementById('cookies').remove(); api('apps2/orders/cookies', { choice: 'accept' }); });
document.getElementById('reject').addEventListener('click', () => { document.getElementById('cookies').remove(); api('apps2/orders/cookies', { choice: 'reject' }); });`;

const PREFS_SCRIPT = `
document.getElementById('save').addEventListener('click', async () => {
  const v = (id) => document.getElementById(id).value;
  const { ref } = await api('apps2/prefs/save', { birthday: v('birthday'), quiet: v('quiet'), volume: v('volume'), accent: v('accent'), language: v('language') });
  const t = document.getElementById('toast'); t.textContent = 'Saved · reference ' + ref; t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 3000);
});`;

const CHAT_SCRIPT = `
const box = document.getElementById('msgs'); let oldest = null; let loading = false;
async function older() {
  if (loading || oldest === 0) return; loading = true;
  const { msgs, from } = await api('apps2/chat/history?before=' + (oldest ?? ''));
  const keep = box.scrollHeight - box.scrollTop;
  box.insertAdjacentHTML('afterbegin', msgs.map((m) => '<div class="msg" role="article"><strong>' + m.who + '</strong> ' + m.text + '</div>').join(''));
  box.scrollTop = box.scrollHeight - keep; oldest = from; loading = false;
}
box.addEventListener('scroll', () => { if (box.scrollTop < 60) older(); });
await older(); box.scrollTop = box.scrollHeight;
const input = document.getElementById('composer'); const pop = document.getElementById('mentions');
const people = ['Sam Ortiz', 'Dana Reyes', 'Kofi Mensah', 'Elif Kaya'];
input.addEventListener('input', () => {
  const m = /@(\\w*)$/.exec(input.value);
  if (!m) { pop.hidden = true; return; }
  const hits = people.filter((p) => p.toLowerCase().startsWith(m[1].toLowerCase()));
  pop.innerHTML = hits.map((p) => '<button role="option" data-p="' + p + '">' + p + '</button>').join(''); pop.hidden = !hits.length;
});
pop.addEventListener('click', (e) => { const p = e.target.dataset.p; if (!p) return; input.value = input.value.replace(/@\\w*$/, '@' + p + ' '); pop.hidden = true; input.focus(); });
input.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !input.value.trim()) return;
  e.preventDefault(); await api('apps2/chat/post', { text: input.value });
  box.insertAdjacentHTML('beforeend', '<div class="msg" role="article"><strong>You</strong> ' + input.value + '</div>'); input.value = ''; box.scrollTop = box.scrollHeight;
});`;

const SHEET_SCRIPT = `
let grid = (await api('apps2/sheet/state')).grid; let at = null;
const table = document.getElementById('sheet');
const total = () => grid.slice(1).reduce((s, row) => s + row.slice(1).reduce((a, b) => a + Number(b), 0), 0);
function draw() {
  table.innerHTML = grid.map((row, r) => '<div role="row">' + row.map((v, c) => '<div role="' + (r === 0 ? 'columnheader' : c === 0 ? 'rowheader' : 'gridcell') + '" data-r="' + r + '" data-c="' + c + '" tabindex="' + (r && c ? 0 : -1) + '" aria-label="' + (r && c ? grid[r][0] + ' ' + grid[0][c] : '') + '">' + (typeof v === 'number' ? v.toLocaleString('en-US') : v) + '</div>').join('') + '</div>').join('') +
    '<div role="row"><div role="rowheader">Q1 total</div><div role="gridcell" id="total">' + total().toLocaleString('en-US') + '</div></div>';
}
function edit(cell) {
  const r = +cell.dataset.r; const c = +cell.dataset.c; if (!r || !c) return;
  const input = document.createElement('input'); input.value = grid[r][c]; input.setAttribute('aria-label', 'Edit ' + grid[r][0] + ' ' + grid[0][c]);
  cell.replaceChildren(input); input.focus(); input.select();
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { const n = Number(input.value.replace(/[,$\\s]/g, '')); if (!Number.isNaN(n)) { grid[r][c] = n; await api('apps2/sheet/set', { r, c, value: n, total: total() }); } draw(); }
    if (e.key === 'Escape') draw();
  });
}
table.addEventListener('dblclick', (e) => { const cell = e.target.closest('[role=gridcell][data-r]'); if (cell) edit(cell); });
table.addEventListener('keydown', (e) => { const cell = e.target.closest('[role=gridcell][data-r]'); if (cell && (e.key === 'Enter' || e.key === 'F2')) { e.preventDefault(); edit(cell); } });
draw();`;

export function pages2(frame) {
  return {
    mail: () => frame('Spudmail', `<main><h1>Inbox</h1><p>Keyboard: j / k to move, e to archive, # to delete, Enter to open.</p><div class="rows" id="list" role="grid" aria-label="Messages"></div>
<section id="reader" style="margin-top:16px"></section><section id="compose" hidden style="border:1px solid #ccc;border-radius:10px;padding:12px;max-width:620px;margin-top:12px">
<p>To: <span id="to"></span></p><div id="editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message body" style="min-height:120px;border:1px solid #ddd;padding:8px;border-radius:6px"></div>
<p><button id="send">Send</button> <small>Drafts save automatically.</small></p></section></main>`, { style: STYLE, script: `const MAILS = ${JSON.stringify(MAILS)};\n(async () => {${MAIL_SCRIPT}})();` }),
    files: () => frame('Spudfiles', `<main><h1 id="where">My files</h1><div id="zone" style="border:2px dashed #aaa;border-radius:12px;padding:22px;max-width:520px;margin:10px 0" role="region" aria-label="Upload area">Drop files here to upload them to this folder</div>
<div class="rows" id="grid" role="grid" aria-label="Files"></div><p><small>Right-click a file for more.</small></p></main>`, { style: STYLE + '#zone.over{border-color:#2457c5;background:#f3f7ff}', script: `(async () => {${FILES_SCRIPT}})();` }),
    orders: () => frame('Orders', `<main><h1>Orders</h1><div role="grid" aria-label="Orders" style="max-width:760px"><div class="orow head" role="row"><span role="columnheader">Order</span><span role="columnheader">Customer</span><span role="columnheader">City</span><span role="columnheader">Status</span><span role="columnheader">Total</span></div>
<div id="box" style="height:420px;overflow:auto;position:relative;border:1px solid #e5e5ea"><div id="inner" style="position:relative"></div></div></div></main>
<div id="cookies" role="dialog" aria-label="Cookies" style="position:fixed;left:0;right:0;bottom:0;background:#1c1c1e;color:#fff;padding:18px 24px;display:flex;gap:12px;align-items:center;z-index:30">We use cookies to keep you signed in. <button id="accept">Accept all</button> <button id="reject">Reject optional</button></div>`,
    { style: '.orow{display:grid;grid-template-columns:90px 160px 120px 120px 80px;gap:8px;padding:8px 10px;height:36px;position:absolute;left:0;right:0}.orow.head{position:static;font-weight:600}', script: `(async () => {${ORDERS_SCRIPT}})();` }),
    prefs: () => frame('Preferences', `<main><h1>Preferences</h1>
<label for="birthday">Birthday</label><input id="birthday" type="date">
<label for="quiet">Quiet hours start</label><input id="quiet" type="time">
<label for="volume">Notification volume</label><input id="volume" type="range" min="0" max="100" value="70">
<label for="accent">Accent colour</label><input id="accent" type="color" value="#3366ff">
<label for="language">Language</label><select id="language"><option>English</option><option>Español</option><option>Deutsch</option><option>日本語</option></select>
<p><button id="save">Save preferences</button></p><div id="toast" role="status" hidden></div></main>`, { style: STYLE, script: `(async () => {${PREFS_SCRIPT}})();` }),
    chat: () => frame('#launch · Spudchat', `<div style="display:grid;grid-template-rows:auto 1fr auto;height:100vh"><header style="padding:12px 20px;border-bottom:1px solid #e5e5ea"><strong>#launch</strong></header>
<div id="msgs" role="log" aria-label="Messages" style="overflow:auto;padding:12px 20px"></div>
<div style="padding:10px 20px;border-top:1px solid #e5e5ea;position:relative"><div id="mentions" role="listbox" hidden style="position:absolute;bottom:56px;background:#fff;border:1px solid #ccc;border-radius:8px;padding:4px"></div>
<input id="composer" aria-label="Message #launch" placeholder="Message #launch" style="width:100%"></div></div>`, { style: 'html,body{height:100%;overflow:hidden}.msg{padding:4px 0}#mentions button{display:block;border:0;background:none;padding:6px 10px;width:100%;text-align:left}', script: `(async () => {${CHAT_SCRIPT}})();` }),
    sheet: () => frame('Budget · Spudsheets', `<main><h1>Budget</h1><p>Double-click a cell (or select it and press Enter) to edit; Enter saves.</p><div id="sheet" role="grid" aria-label="Budget" style="display:grid;grid-template-columns:repeat(4,140px)"></div></main>`,
      { style: '[role=row]{display:contents}[role=gridcell],[role=rowheader],[role=columnheader]{padding:8px;border:1px solid #e5e5ea}[role=columnheader]{font-weight:600;background:#f5f5f7}[role=gridcell]:focus{outline:2px solid #2457c5}', script: `(async () => {${SHEET_SCRIPT}})();` }),
  };
}

// The apps' API: route (after /api/apps2/), the request, the tag's state and log. Returns a JSON-able value, or undefined.
export async function api2(route, { body, url, state, log }) {
  const s = state.apps2;
  const mail = s.mail;
  if (route === 'mail/state') return mail;
  if (/^mail\/(archive|delete|unread|read)$/.test(route)) {
    const action = route.split('/')[1];
    const id = String(body.id);
    if (action === 'archive') mail.archived.push(id);
    if (action === 'delete') mail.deleted.push(id);
    if (action === 'unread' && !mail.unread.includes(id)) mail.unread.push(id);
    if (action === 'read') mail.unread = mail.unread.filter((x) => x !== id);
    log('action', `/mail/${action}`, id);
    return mail;
  }
  if (route === 'mail/draft') { mail.drafts[body.id] = body.text; log('action', '/mail/draft', `${body.id} ${String(body.text).replace(/\s+/g, ' ').trim()}`); return { ok: true }; }
  if (route === 'mail/send') { log('action', '/mail/send', String(body.text).replace(/\s+/g, ' ').trim()); return { ok: true }; }
  if (route === 'files/state') return s.files;
  if (route === 'files/upload') { s.files.files.push({ id: `f${s.files.files.length + 1}`, name: String(body.name), folder: String(body.folder) }); log('action', '/files/upload', `${body.folder} ${body.name} ${body.size}`); return s.files; }
  if (route === 'files/rename') { const f = s.files.files.find((x) => x.id === body.id); if (f) { log('action', '/files/rename', `${f.name} -> ${body.name}`); f.name = String(body.name); } return s.files; }
  if (route === 'files/trash') { const f = s.files.files.find((x) => x.id === body.id); if (f) { log('action', '/files/trash', f.name); s.files.files = s.files.files.filter((x) => x !== f); } return s.files; }
  if (route === 'orders/rows') return { rows: ORDERS };
  if (route === 'orders/cookies') { log('action', '/orders/cookies', String(body.choice)); return { ok: true }; }
  if (route === 'prefs/save') {
    const ref = `SX-${4800 + (state.events.length % 97)}`;
    s.prefs = { ...body, ref };
    log('action', '/prefs/save', `birthday=${body.birthday} quiet=${body.quiet} volume=${body.volume} accent=${String(body.accent).toLowerCase()} language=${body.language} ref=${ref}`);
    return { ref };
  }
  if (route === 'chat/history') {
    const before = url.searchParams.get('before');
    const end = before === null || before === '' ? CHAT.length : Number(before);
    const from = Math.max(0, end - 25);
    await new Promise((r) => setTimeout(r, 250));
    log('load', '/chat/history', `${from}-${end}`);
    return { msgs: CHAT.slice(from, end), from };
  }
  if (route === 'chat/post') { s.chat.posted.push(String(body.text)); log('action', '/chat/post', String(body.text)); return { ok: true }; }
  if (route === 'sheet/state') return { grid: s.sheet };
  if (route === 'sheet/set') { s.sheet[body.r][body.c] = Number(body.value); log('action', '/sheet/set', `${s.sheet[body.r][0]} ${s.sheet[0][body.c]} ${body.value} total=${body.total}`); return { ok: true }; }
  return undefined;
}
