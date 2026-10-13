// Small helpers shared by the server's modules.

// A local file or view-source: page, parsed as the browser parses it ("fi\tle:" is file: too).
export const isLocalUrl = (url) => ['file:', 'view-source:'].includes(URL.parse(url ?? '')?.protocol);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The promise's value, or `fallback` when it fails or takes longer than ms (the timer is cleared either way).
export function within(promise, ms, fallback) {
  let timer;
  return Promise.race([promise.catch(() => fallback), new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })])
    .finally(() => clearTimeout(timer));
}

// One tab as tabs.listAll describes it (owner, origin, kept, handedOver, parked, windowId, active...), null when it is
// gone; asked for alone (extension tabs.info), from the whole list only on an older extension.
export async function tabInfo(browser, tabId) {
  return browser.host.request('tabs.info', { tabId }).catch(async (error) => {
    if (!/unknown method/i.test(error.message)) throw error;
    return (await browser.host.request('tabs.listAll', {})).find((t) => t.id === tabId) ?? null;
  });
}
