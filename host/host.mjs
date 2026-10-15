// FowlBrowser native messaging host: bridges the extension (stdio) to many local socket clients.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.FOWLBROWSER_DIR || path.join(os.homedir(), '.fowlbrowser');
const LOG_LIMIT = 5 * 1024 * 1024;
const CHUNK_THRESHOLD = 900_000;
// Characters per chunk: worst case 3 UTF-8 bytes per UTF-16 unit stays under Chrome's 1 MB cap.
const CHUNK_CHARS = 250_000;
// Socket limits: one client can't make the host shared by every session hold unbounded memory.
const MAX_FRAME = 64 * 1024 * 1024;
const MAX_AUTH_FRAME = 4096; // before host.auth: a client that can't read the token gets no more than this
const MAX_BACKLOG = 64 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5000;
const SAME_NAME_WAIT_MS = 500;
// Requests toward the extension: per-client cap, how long a route waits for its reply, how much may wait unsent.
const MAX_IN_FLIGHT = 256;
const ROUTE_TIMEOUT_MS = Number(process.env.FOWLBROWSER_ROUTE_TIMEOUT_MS) || 120_000;
const MAX_NATIVE_BACKLOG = 64 * 1024 * 1024;
// host.hello waits this long for the extension's hello, so clients get the real user agent.
const HELLO_WAIT_MS = 5000;

// --- Browser identity (from the parent process, which is the browser) ---

const browserPid = process.ppid;
const ps = (field) => {
  try { return execFileSync('ps', ['-o', `${field}=`, '-p', String(browserPid)], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
const browserPath = ps('comm');
const browserArgs = ps('args');
const browser = browserNameFrom(browserPath);
const silentDebugger = browserArgs.includes('--silent-debugger-extension-api');

function browserNameFrom(p) {
  if (p.includes('Helium')) return 'helium';
  if (p.includes('Google Chrome Beta')) return 'chrome-beta';
  if (p.includes('Google Chrome Canary')) return 'chrome-canary';
  if (p.includes('Google Chrome')) return 'chrome';
  if (p.includes('Chromium')) return 'chromium';
  if (p.includes('Brave')) return 'brave';
  if (p.includes('Microsoft Edge')) return 'edge';
  const app = p.match(/([^/]+)\.app(\/|$)/)?.[1] ?? path.basename(p);
  return (app || 'unknown').toLowerCase().replace(/\s+/g, '-');
}

// --- Logging ---

fs.mkdirSync(path.join(DIR, 'logs'), { recursive: true, mode: 0o700 });
fs.chmodSync(DIR, 0o700);
const logFile = path.join(DIR, 'logs', `${browser}.log`);

function log(...parts) {
  try {
    if (fs.statSync(logFile, { throwIfNoEntry: false })?.size > LOG_LIMIT) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${parts.join(' ')}\n`);
  } catch {}
}

// --- Framing ---

// Calls onMessage for each complete frame; readLength picks the endianness of the 4-byte header.
// An oversized frame, bad JSON or a throwing onMessage stops the reader and goes to onError.
// Chunks are joined only once a frame is whole: a multi-megabyte message arrives in many small chunks, and joining
// on each would copy it again and again.
function frameReader(readLength, onMessage, onError, maxFrame = () => Infinity) {
  let chunks = [];
  let bytes = 0;
  let length = null;
  let failed = false;
  // The next n bytes of the chunks, joined once; what is left stays queued.
  const take = (n) => {
    const joined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    chunks = joined.length > n ? [joined.subarray(n)] : [];
    bytes = joined.length - n;
    return joined.subarray(0, n);
  };
  return (chunk) => {
    if (failed) return;
    chunks.push(chunk);
    bytes += chunk.length;
    try {
      for (;;) {
        if (length === null) {
          if (bytes < 4) break;
          length = readLength(take(4));
          if (length > maxFrame()) throw new Error(`frame of ${length} bytes is over the limit`);
        }
        if (bytes < length) break;
        const body = take(length).toString('utf8');
        length = null;
        onMessage(JSON.parse(body));
      }
    } catch (error) {
      failed = true;
      chunks = [];
      onError(error);
    }
  };
}

function frame(json, writeLength) {
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  writeLength(header, body.length);
  return Buffer.concat([header, body]);
}

const nativeLE = os.endianness() === 'LE';
const readNative = (b) => (nativeLE ? b.readUInt32LE(0) : b.readUInt32BE(0));
const writeNative = (b, n) => (nativeLE ? b.writeUInt32LE(n, 0) : b.writeUInt32BE(n, 0));
const readLE = (b) => b.readUInt32LE(0);
const writeLE = (b, n) => b.writeUInt32LE(n, 0);

// --- Extension side (stdio) ---

let chunkSeq = 0;
function sendToExtension(message) {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json) <= CHUNK_THRESHOLD) {
    process.stdout.write(frame(json, writeNative));
    return;
  }
  const id = `chunk-${++chunkSeq}`;
  const parts = [];
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + CHUNK_CHARS, json.length);
    // Never split a surrogate pair: each half would travel as a lone, escaped surrogate.
    const last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(json.slice(start, end));
    start = end;
  }
  parts.forEach((data, index) => {
    process.stdout.write(frame(JSON.stringify({ method: 'host.chunk', params: { id, index, total: parts.length, data } }), writeNative));
  });
}

let extensionHello = null;
const clients = new Map(); // clientId -> socket
const pending = new Map(); // host request id -> { clientId, id: the client's original id, at }
const inFlight = new Map(); // clientId -> number of its routes in `pending`
const waitingForHello = new Set(); // greet functions of clients authed before extension.hello arrived
const greetedClients = new Set(); // sockets that got host.hello; a later extension.hello (label changed) goes to them
let requestSeq = 0;

function takeRoute(key) {
  const route = pending.get(key);
  if (!route) return null;
  pending.delete(key);
  const left = (inFlight.get(route.clientId) ?? 1) - 1;
  if (left > 0) inFlight.set(route.clientId, left);
  else inFlight.delete(route.clientId);
  return route;
}

// A route nobody answered in time (the extension lost the request, or is stuck) gets an error reply.
setInterval(() => {
  const cutoff = Date.now() - ROUTE_TIMEOUT_MS;
  for (const [key, route] of pending) {
    if (route.at > cutoff) continue;
    takeRoute(key);
    const socket = clients.get(route.clientId);
    if (socket) sendToClient(socket, { id: route.id, error: { message: `No reply from the extension in ${ROUTE_TIMEOUT_MS / 1000} s` } });
  }
}, Math.min(ROUTE_TIMEOUT_MS, 10_000)).unref();

// A client that stops reading is dropped before its unsent backlog can exhaust the host.
function sendToClient(socket, message) {
  if (socket.destroyed) return;
  socket.write(frame(JSON.stringify(message), writeLE));
  if (socket.writableLength > MAX_BACKLOG) {
    log('client dropped: write backlog', socket.writableLength);
    socket.destroy();
  }
}

function onExtensionMessage(message) {
  if (message.method === 'extension.log') return log('ext:', message.params?.text ?? '');
  if (message.method === 'extension.hello') {
    extensionHello = message.params ?? null;
    log('extension.hello', JSON.stringify(extensionHello));
    for (const socket of greetedClients) sendToClient(socket, { method: 'extension.hello', params: extensionHello });
    for (const greet of waitingForHello) greet();
    return;
  }
  if (message.id !== undefined) {
    const route = takeRoute(message.id);
    if (!route) return log('response for unknown id', String(message.id));
    const socket = clients.get(route.clientId);
    if (!socket) return;
    const { client, ...response } = message;
    sendToClient(socket, { ...response, id: route.id });
    return;
  }
  const { client, ...event } = message;
  if (client !== undefined) {
    const socket = clients.get(client);
    if (socket) sendToClient(socket, event);
  } else {
    for (const socket of clients.values()) sendToClient(socket, event);
  }
}

process.stdin.on('data', frameReader(readNative, onExtensionMessage, (error) => {
  log('bad extension frame', error.message);
  shutdown('bad extension frame');
}));
process.stdin.on('end', () => shutdown('stdin closed'));
process.stdout.on('error', () => shutdown('stdout error'));

// --- Socket side ---

// Clients must prove they can read ~/.fowlbrowser/token (0600) before anything reaches the browser.
const tokenFile = path.join(DIR, 'token');
// Only 64 hex characters count as a token: an empty file would let any client in with an empty one.
const readToken = () => {
  try {
    const value = fs.readFileSync(tokenFile, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(value) ? Buffer.from(value) : null;
  } catch { return null; }
};
// Two hosts starting at once (Chrome and Helium at login) may both create it: each writes its own file and links it
// into place, so the token appears whole in one step and the loser (EEXIST) reads the winner's. A file that holds no
// token is replaced in one step (rename); two hosts doing that at once leave the later one's, which is why the token
// is read again at every auth instead of kept from startup.
if (!readToken()) {
  const draft = `${tokenFile}.${process.pid}`;
  fs.writeFileSync(draft, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  try {
    if (fs.existsSync(tokenFile)) { fs.renameSync(draft, tokenFile); log('token file held no token: replaced'); }
    else fs.linkSync(draft, tokenFile);
  }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { fs.rmSync(draft, { force: true }); }
}
const tokenMatches = (value) => {
  const token = readToken();
  const given = Buffer.from(String(value ?? ''));
  return token !== null && given.length === token.length && crypto.timingSafeEqual(given, token);
};

let nextClientId = 1;

function onClient(socket) {
  const clientId = nextClientId++;
  let authed = false;
  let helloTimer = null;
  let greeted = false;
  const greet = () => {
    if (greeted) return;
    greeted = true;
    waitingForHello.delete(greet);
    clearTimeout(helloTimer);
    greetedClients.add(socket);
    sendToClient(socket, { method: 'host.hello', params: { browser, browserPath, browserPid, silentDebugger, extension: extensionHello } });
  };
  const authTimer = setTimeout(() => {
    if (!authed) { log('client refused: no auth in time', clientId); socket.destroy(); }
  }, AUTH_TIMEOUT_MS);

  socket.on('data', frameReader(readLE, (message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      throw new Error('not a request or event');
    }
    if (!authed) {
      if (message.method !== 'host.auth' || !tokenMatches(message.params?.token)) {
        log('client refused', clientId);
        socket.destroy();
        return;
      }
      authed = true;
      clearTimeout(authTimer);
      clients.set(clientId, socket);
      log('client connected', clientId);
      sendToExtension({ method: 'host.clientConnected', params: { client: clientId } });
      if (extensionHello) greet();
      else {
        waitingForHello.add(greet);
        helloTimer = setTimeout(greet, HELLO_WAIT_MS);
      }
      return;
    }
    // host.* messages (chunks, client lifecycle) only ever come from the host itself.
    if (message.method.startsWith('host.')) {
      log('client', clientId, 'sent', message.method, '(dropped)');
      if (message.id !== undefined) sendToClient(socket, { id: message.id, error: { message: `${message.method} is reserved for the host` } });
      return;
    }
    // Bounded work toward the extension: a flooding client gets errors (events are dropped) instead of growing
    // the host's queues.
    const busy = process.stdout.writableLength > MAX_NATIVE_BACKLOG ? 'the browser is not keeping up'
      : (inFlight.get(clientId) ?? 0) >= MAX_IN_FLIGHT ? `over ${MAX_IN_FLIGHT} requests in flight` : null;
    if (message.id === undefined) {
      if (!busy) sendToExtension({ ...message, client: clientId });
      return;
    }
    if (busy) {
      sendToClient(socket, { id: message.id, error: { message: `Request refused: ${busy}` } });
      return;
    }
    const id = ++requestSeq;
    pending.set(id, { clientId, id: message.id, at: Date.now() });
    inFlight.set(clientId, (inFlight.get(clientId) ?? 0) + 1);
    sendToExtension({ ...message, id, client: clientId });
  }, (error) => {
    log('client dropped', clientId, error.message);
    socket.destroy();
  }, () => (authed ? MAX_FRAME : MAX_AUTH_FRAME)));

  let closed = false;
  const close = () => {
    clearTimeout(authTimer);
    if (closed || !authed) return;
    closed = true;
    clients.delete(clientId);
    greetedClients.delete(socket);
    waitingForHello.delete(greet);
    clearTimeout(helloTimer);
    for (const [key, route] of pending) if (route.clientId === clientId) takeRoute(key);
    log('client disconnected', clientId);
    sendToExtension({ method: 'host.clientDisconnected', params: { client: clientId } });
  };
  socket.on('close', close);
  socket.on('error', close);
}

// Resolves true if a live server answers on this path.
function isLive(socketPath) {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

async function listen() {
  for (let n = 1; ; n++) {
    const socketPath = path.join(DIR, n === 1 ? `${browser}.sock` : `${browser}-${n}.sock`);
    if (fs.existsSync(socketPath)) {
      // A previous host for this browser may still be exiting (worker restart): give it a moment to let go of
      // the name, so the browser keeps its socket name instead of becoming <browser>-2.
      let live = await isLive(socketPath);
      for (const end = Date.now() + SAME_NAME_WAIT_MS; live && Date.now() < end;) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        live = fs.existsSync(socketPath) && await isLive(socketPath);
      }
      if (live) continue;
      fs.rmSync(socketPath, { force: true });
    }
    const server = net.createServer(onClient);
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false)); // lost a race for this name: try the next one
      server.listen(socketPath, () => resolve(true));
    });
    if (!ok) continue;
    fs.chmodSync(socketPath, 0o600);
    return { server, socketPath };
  }
}

let listening = null;

function shutdown(reason) {
  log('exit:', reason);
  if (listening) {
    listening.server.close();
    // Only remove the socket file if it is still ours (inode unchanged).
    try {
      if (fs.statSync(listening.socketPath).ino === listening.ino) fs.rmSync(listening.socketPath);
    } catch {}
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', (error) => { log('uncaught', error.stack); shutdown('uncaught exception'); });

listening = await listen();
listening.ino = fs.statSync(listening.socketPath).ino;
// The extension's popup shows this: the host is installed and agents reach this browser as <socket name>.
sendToExtension({ method: 'host.listening', params: { browser, key: path.basename(listening.socketPath, '.sock'), silentDebugger } });
log('listening', listening.socketPath, 'browser', browser, browserPath, 'pid', browserPid, 'silent', silentDebugger);
