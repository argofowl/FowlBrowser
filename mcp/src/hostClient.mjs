// Client for one FowlBrowser host socket: uint32 LE length + UTF-8 JSON frames, host.auth, client.hello.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { debug, debugging } from './debug.mjs';

export const SOCKET_DIR = process.env.FOWLBROWSER_DIR || path.join(os.homedir(), '.fowlbrowser');
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 40_000; // the extension already times CDP commands out at 30 s
// CDP commands that wait on the page (an evaluation's promise, a navigation) have no limit in the extension but the
// host's 120 s (checked every 10 s): they get longer here, so the host's answer comes first.
const COMMAND_TIMEOUT_MS = 135_000;

export function listSockets() {
  if (!fs.existsSync(SOCKET_DIR)) return [];
  return fs.readdirSync(SOCKET_DIR).filter((f) => f.endsWith('.sock')).map((f) => path.join(SOCKET_DIR, f));
}

// Emits 'event' (method, params) and 'close'. `hello` holds the host.hello params once connected.
export class HostClient extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.key = path.basename(socketPath, '.sock'); // the browser's name in tab ids ("chrome" in "chrome:52")
    this.hello = null;
    this.closed = false;
    this._pending = new Map();
    this._nextId = 1;
    this._chunks = []; // socket data not yet a whole frame, and how much of it there is
    this._chunkBytes = 0;
    this._frameLength = null;
    this._inbox = [];
    this._draining = false;
  }

  async connect(label) {
    const token = fs.readFileSync(path.join(SOCKET_DIR, 'token'), 'utf8').trim();
    this._socket = net.connect(this.socketPath);
    this._socket.on('data', (chunk) => this._onData(chunk));
    this._socket.on('close', () => this._onClose());
    this._socket.on('error', () => this._socket.destroy());
    // Every handshake step races one deadline and the socket closing, so a stuck host can't pin this connect.
    let timer, onClose;
    const failed = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`handshake with ${this.socketPath} timed out`)), CONNECT_TIMEOUT_MS);
      onClose = () => reject(new Error(`${this.socketPath} closed during handshake`));
      this.once('close', onClose);
    });
    failed.catch(() => {});
    const hello = new Promise((resolve) => this.once('host.hello', resolve));
    // client.hello replays tabs we own, then extension.initialized.
    const initialized = new Promise((resolve) => this.once('extension.initialized', resolve));
    try {
      this._send({ method: 'host.auth', params: { token } });
      this.hello = await Promise.race([hello, failed]);
      await Promise.race([this.request('client.hello', { label }), failed]);
      await Promise.race([initialized, failed]);
    } finally {
      clearTimeout(timer);
      this.off('close', onClose);
    }
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('browser disconnected'));
    const id = this._nextId++;
    if (method !== 'chrome.debugger.sendCommand') debug('host >', method, params);
    this._send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        debug('host timeout', method);
        reject(new Error(`${method} timed out`));
      }, method === 'chrome.debugger.sendCommand' ? COMMAND_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  close() {
    this._socket?.destroy();
  }

  _send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this._socket.write(Buffer.concat([header, body]));
  }

  // Frames are assembled only once whole: a multi-megabyte message (a trace's events) arrives in hundreds of small
  // chunks, and joining the buffer on each would copy it again and again (the host drops a client whose backlog grows
  // past 64 MB while it is busy copying).
  _onData(chunk) {
    this._chunks.push(chunk);
    this._chunkBytes += chunk.length;
    for (;;) {
      if (this._frameLength === null) {
        if (this._chunkBytes < 4) break;
        this._frameLength = this._take(4).readUInt32LE(0);
      }
      if (this._chunkBytes < this._frameLength) break;
      this._inbox.push(JSON.parse(this._take(this._frameLength).toString('utf8')));
      this._frameLength = null;
    }
    this._drain();
  }

  // The next n bytes of the chunks, joined once; what is left stays queued.
  _take(n) {
    const joined = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks);
    this._chunks = joined.length > n ? [joined.subarray(n)] : [];
    this._chunkBytes = joined.length - n;
    return joined.subarray(0, n);
  }

  // One message per tick, in arrival order. A CDP reply reaches Playwright through a short promise chain while
  // an event goes straight through; handling the next message only after that chain settles keeps replies and
  // events in the order Chrome sent them (Playwright drops execution contexts that arrive before the frame tree).
  _drain() {
    if (this._draining) return;
    this._draining = true;
    const next = () => {
      const message = this._inbox.shift();
      if (!message) { this._draining = false; return; }
      try {
        this._onMessage(message);
      } catch (error) {
        debug('drain error', error?.message);
      } finally {
        setImmediate(next);
      }
    };
    next();
  }

  _onMessage(message) {
    if (message.id !== undefined) {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      // The extension names tabs by Chrome's number; agents know them as "chrome:52".
      if (message.error) pending.reject(new Error(String(message.error.message).replace(/\bTab (\d+)\b/g, `Tab ${this.key}:$1`)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method !== 'chrome.debugger.onEvent') debug('host event', message.method, message.params);
    else if (debugging && /^(Runtime\.execution|Page\.frame|Target\.|Inspector\.)/.test(message.params?.[1])) debug('cdp event', message.params[1], message.params[0], message.params[2]);
    // A rename during the handshake comes before anyone listens for events: keep it in hello.
    if (message.method === 'extension.hello' && this.hello && message.params?.userAgent) this.hello = { ...this.hello, extension: message.params };
    this.emit(message.method, message.params);
    this.emit('event', message.method, message.params);
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error('browser disconnected'));
    }
    this._pending.clear();
    this.emit('close');
  }
}
