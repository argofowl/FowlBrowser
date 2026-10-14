// console and network show the page the tab shows now: entries carry the document generation, and the new document's
// own response (it comes in before the document commits) counts as the new page's.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';

test('a new document\'s own response is the new page\'s; the old page\'s requests and logs stay with it', () => {
  const page = Object.assign(new EventEmitter(), { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://a.example/' });
  const main = {};
  page.mainFrame = () => main;
  const tab = new Tab({ key: 'chrome' }, 1, page);
  const response = (url, type, frame = main) => {
    const request = { url: () => url, method: () => 'GET', resourceType: () => type, frame: () => frame };
    page.emit('response', { request: () => request, status: () => 200 });
  };
  response('https://a.example/', 'document');
  page.emit('console', { type: () => 'error', text: () => 'old page error', location: () => ({}) });
  response('https://a.example/api', 'fetch');
  response('https://b.example/', 'document'); // B's response, before B commits
  tab._newDocument('https://b.example/');
  response('https://b.example/app.js', 'script');
  assert.deepEqual(tab.network.map((e) => [e.url, e.page]), [['https://a.example/', 0], ['https://a.example/api', 0], ['https://b.example/', 1], ['https://b.example/app.js', 1]]);
  assert.deepEqual(tab.console.map((e) => [e.text, e.page]), [['old page error', 0]]);
});

test('a request the old page made is the old page\'s, even when its answer comes after the new one committed', () => {
  const page = Object.assign(new EventEmitter(), { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://a.example/' });
  const main = {};
  page.mainFrame = () => main;
  const tab = new Tab({ key: 'chrome' }, 1, page);
  const request = (url, type) => ({ url: () => url, method: () => 'POST', resourceType: () => type, frame: () => main, failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
  const beacon = request('https://a.example/log', 'fetch');
  const upload = request('https://a.example/upload', 'xhr');
  page.emit('request', beacon);
  page.emit('request', upload);
  tab._newDocument('https://b.example/');
  page.emit('response', { request: () => beacon, status: () => 204 });
  page.emit('requestfailed', upload);
  assert.deepEqual(tab.network.map((e) => [e.url, e.page]), [['https://a.example/log', 0], ['https://a.example/upload', 0]]);
});
