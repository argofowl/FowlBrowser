// FowlBrowser service worker: native messaging transport plus chrome event wiring.
// The logic lives in core.js so it can be tested without a browser.
import { createCore } from './core.js';

const HOST_NAME = 'com.fowl.browser';
const RECONNECT_DELAY_MS = 1000;
const RECONNECT_ALARM = 'reconnect';

let port = null;
// For the popup: 'connecting', 'connected' (the host is listening as `key`, e.g. "chrome-2"), 'missing' (no host
// installed: setup needed) or 'broken' (installed, but it exits before listening: its node or app folder moved).
let status = { state: 'connecting' };

// A "!" on the toolbar icon while setup is needed, so the user knows to open the popup.
function setStatus(next) {
  status = next;
  chrome.action.setBadgeText({ text: next.state === 'missing' || next.state === 'broken' ? '!' : '' });
}
chrome.action.setBadgeBackgroundColor({ color: '#e8890c' });

const core = createCore({ chrome, send: (msg) => port?.postMessage(msg) });

// The label is the name the user gave this browser profile in the popup ("Work"); agents see "Chrome (Work)".
async function sayHello(current) {
  const [instanceId, { label = '' }] = await Promise.all([core.instanceId(), chrome.storage.local.get('label')]);
  if (port !== current) return;
  current.postMessage({
    method: 'extension.hello',
    params: { version: chrome.runtime.getManifest().version, instanceId, userAgent: navigator.userAgent, label },
  });
}

function connect() {
  if (port) return;
  const current = chrome.runtime.connectNative(HOST_NAME);
  port = current;
  let listened = false;
  current.onMessage.addListener((msg) => {
    if (msg.method !== 'host.listening') return core.handleMessage(msg);
    listened = true;
    setStatus({ state: 'connected', ...msg.params });
  });
  current.onDisconnect.addListener(() => {
    // Host missing or exited; read the error so Chrome doesn't log it as unchecked. A host that ends before it
    // listens can't start at all (Chrome says "Failed to start" or "Native host has exited").
    const missing = /not found|forbidden/i.test(chrome.runtime.lastError?.message ?? '');
    setStatus({ state: missing ? 'missing' : listened ? 'connecting' : 'broken' });
    if (port === current) port = null;
    core.portClosed();
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
  sayHello(current);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'status' && sender.id === chrome.runtime.id) sendResponse(status);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.label && port) sayHello(port);
});

// Listeners are registered synchronously so events wake the worker.
chrome.debugger.onEvent.addListener(core.onDebuggerEvent);
chrome.debugger.onDetach.addListener(core.onDebuggerDetach);
chrome.tabs.onCreated.addListener(core.onTabCreated);
chrome.webNavigation.onCreatedNavigationTarget.addListener(core.onNavigationTarget);
chrome.webNavigation.onCommitted.addListener(core.onNavigationCommitted);
chrome.webNavigation.onBeforeNavigate.addListener(core.onBeforeNavigate);
chrome.webNavigation.onErrorOccurred.addListener(core.onNavigationError);
chrome.tabs.onRemoved.addListener(core.onTabRemoved);
chrome.tabs.onReplaced.addListener(core.onTabReplaced);
chrome.tabs.onActivated.addListener(core.onTabActivated);
chrome.windows.onCreated.addListener(core.onWindowCreated);
chrome.windows.onFocusChanged.addListener(core.onWindowFocusChanged);
chrome.windows.onRemoved.addListener(core.onWindowRemoved);
chrome.downloads.onCreated.addListener(core.onDownloadCreated);
chrome.downloads.onChanged.addListener(core.onDownloadChanged);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();
