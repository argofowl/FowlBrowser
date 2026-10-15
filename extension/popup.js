// FowlBrowser popup: connection status, the name agents see for this browser profile, and a setup prompt per agent.
import { AGENTS } from './setup-prompts.js';

const NAMES = { chrome: 'Chrome', helium: 'Helium', chromium: 'Chromium', brave: 'Brave', edge: 'Edge' };
// The app to reopen without the debugging bar (`open -a`), by browser.
const APPS = { chrome: 'Google Chrome', helium: 'Helium', chromium: 'Chromium', brave: 'Brave Browser', edge: 'Microsoft Edge', vivaldi: 'Vivaldi' };
const SAVE_DELAY_MS = 300;
const COPIED_MS = 1500;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const labelEl = $('label');
const setupEl = $('setup');
const promptEl = $('prompt');
const tabs = [...document.querySelectorAll('.agents button')];

let status = { state: 'connecting' };
let agent = 'claude';
let setupDecided = false;

// "Chrome (Work)": what browser_list and every tool result call this browser.
function seenAs() {
  const app = NAMES[status.browser] ?? (status.browser ? status.browser : null);
  if (!app) return 'this browser';
  const label = labelEl.value.trim();
  const n = status.key?.match(/-(\d+)$/)?.[1];
  return app + (label ? ` (${label})` : n ? ` (${n})` : '');
}

function render() {
  statusEl.dataset.state = status.state;
  statusEl.lastElementChild.textContent = { connected: 'Connected', missing: 'Not set up', broken: 'Can’t start' }[status.state] ?? 'Connecting…';
  $('problem').hidden = status.state !== 'broken';
  const preview = $('preview');
  preview.textContent = 'Agents see this browser as ';
  const name = document.createElement('b');
  name.textContent = seenAs();
  preview.append(name, '.');
  for (const tab of tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.agent === agent));
    tab.tabIndex = tab.dataset.agent === agent ? 0 : -1; // Tab reaches the selected one; arrows move between them
  }
  $('prompt-text').textContent = AGENTS[agent].prompt;
  $('prompt-hint').textContent = AGENTS[agent].hint;
  // Started without the flag (a Dock launch or an update relaunch drops it): the browser shows its debugging bar while
  // an agent works, and Cancel there takes the tab from the agent. Said only when the helper knows (newer hosts).
  const app = APPS[status.browser];
  $('bar').hidden = !(status.state === 'connected' && status.silentDebugger === false && app);
  if (app) {
    const name = NAMES[status.browser] ?? app;
    $('bar-text').textContent = `While an agent works, ${name} shows a “started debugging this browser” bar, and Cancel there stops the agent. ` +
      `To hide it, quit ${name} (⌘Q), then run this in Terminal (your tabs come back). ` +
      `It hides that bar for every extension that uses the debugger, not only FowlBrowser:`;
    // Lines break between words only, never inside a flag or the quoted app name.
    $('bar-command-text').replaceChildren(...barCommand(app).match(/"[^"]*"|\S+/g).flatMap((word, i) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = word;
      return i ? [' ', span] : [span];
    }));
  }
}

const barCommand = (app) => `open -a "${app}" --args --silent-debugger-extension-api --restore-last-session`;

let saveTimer = null;
function saveLabel() {
  clearTimeout(saveTimer);
  saveTimer = null;
  chrome.storage.local.set({ label: labelEl.value.trim() });
}

labelEl.addEventListener('input', () => {
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLabel, SAVE_DELAY_MS);
});
labelEl.addEventListener('keydown', (event) => { if (event.key === 'Enter') { saveLabel(); labelEl.blur(); } });
labelEl.addEventListener('blur', () => { if (saveTimer) saveLabel(); });
addEventListener('pagehide', () => { if (saveTimer) saveLabel(); });

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    agent = tab.dataset.agent;
    chrome.storage.local.set({ agent });
    render();
  });
}

// Left and right arrows move between the agent tabs.
$('setup').querySelector('.agents').addEventListener('keydown', (event) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const from = tabs.includes(document.activeElement) ? tabs.indexOf(document.activeElement) : tabs.findIndex((t) => t.dataset.agent === agent);
  const next = tabs[(from + step + tabs.length) % tabs.length];
  next.focus();
  next.click();
});

// A copy button: its text to the clipboard and a check mark for a moment, plus "Copied." in its hint when it has one.
// The debugging-bar note's has none: its paragraph would shrink to that one word and the popup jump up and back.
function copies(button, text, hint) {
  let timer = null;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text());
    } catch {
      if (hint) hint.textContent = 'Could not copy. Select the text and press ⌘C.';
      return;
    }
    button.classList.add('copied');
    const before = hint?.textContent;
    if (hint) hint.textContent = 'Copied.';
    clearTimeout(timer);
    timer = setTimeout(() => { button.classList.remove('copied'); if (hint) hint.textContent = before; render(); }, COPIED_MS);
  });
}
copies(promptEl, () => AGENTS[agent].prompt, $('prompt-hint'));
copies($('bar-command'), () => barCommand(APPS[status.browser]));

async function refreshStatus() {
  const next = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  if (!next) return;
  status = next;
  // Setup starts open while it is needed and folded away once this browser is connected; then it is the user's.
  if (!setupDecided && status.state !== 'connecting') {
    setupDecided = true;
    setupEl.open = status.state === 'missing' || status.state === 'broken';
  }
  render();
}

const stored = await chrome.storage.local.get(['label', 'agent']);
labelEl.value = stored.label ?? '';
if (AGENTS[stored.agent]) agent = stored.agent;
render();
await refreshStatus();
setInterval(refreshStatus, 1000);
