// The viewport tool's metrics override, sent as raw CDP through the host: the relay answers Playwright's own
// Emulation.setDeviceMetricsOverride with {} so Playwright never resizes a tab, and this must not go that way.
// The override lives on the Tab (tab.viewport) and is cleared while the debugger is still attached before the tab
// leaves us (release, turn end, handoff). A detach clears it in Chrome anyway; it is never re-applied after one.
import { cdp } from './cdp.mjs';
import { viewportEvent } from './record.mjs';

export const MIN_SIZE = 200;
export const MAX_SIZE = 4000;

// deviceScaleFactor 0 keeps the screen's real one. Touch emulation follows mobile; setEmitTouchEventsForMouse is never
// sent (it would turn Playwright's clicks into touches).
export async function setViewport(tab, { width, height, mobile = false, deviceScaleFactor }) {
  const touchWasOn = tab.viewport?.mobile === true;
  // Remembered before the sends, so a half-applied override is still cleared later.
  tab.viewport = { width, height, mobile, deviceScaleFactor: deviceScaleFactor ?? null };
  tab.browser.relay.viewports.set(tab.tabId, tab.viewport);
  // The browser's zoom for the site (the user's Cmd-minus) scales a desktop override: at 80% a 1100 px wide one lays the
  // page out 1375 CSS px wide, and a scale of 2 gives devicePixelRatio 1.6. So both are sent divided through by it.
  // Mobile emulation leaves the browser's zoom out, and while it is on the page reports none: a desktop size after a
  // mobile one reads the zoom with that override cleared first.
  let zoom = 1;
  if (!mobile) {
    if (touchWasOn) await cdp(tab, 'Emulation.clearDeviceMetricsOverride');
    zoom = (await cdp(tab, 'Page.getLayoutMetrics')).cssVisualViewport?.zoom || 1;
  }
  tab.viewportZoom = zoom;
  await cdp(tab, 'Emulation.setDeviceMetricsOverride', { width: Math.round(width * zoom), height: Math.round(height * zoom),
    deviceScaleFactor: deviceScaleFactor ? deviceScaleFactor / zoom : 0, mobile });
  if (mobile) await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  else if (touchWasOn) await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  viewportEvent('set', tab, tab.viewport, 'tool');
}

// A new document of another site may have another browser zoom (the user's per-site Cmd-minus): a desktop size is
// sent again for it, so the page keeps the size the agent asked for (Browser._onDebuggerEvent).
export async function keepViewportSize(tab) {
  const viewport = tab.viewport;
  if (!viewport || viewport.mobile) return;
  const zoom = (await cdp(tab, 'Page.getLayoutMetrics')).cssVisualViewport?.zoom || 1;
  if (tab.viewport !== viewport || zoom === tab.viewportZoom) return;
  tab.viewportZoom = zoom;
  await cdp(tab, 'Emulation.setDeviceMetricsOverride', { width: Math.round(viewport.width * zoom), height: Math.round(viewport.height * zoom),
    deviceScaleFactor: viewport.deviceScaleFactor ? viewport.deviceScaleFactor / zoom : 0, mobile: false });
}

// The page's colour scheme and reduced-motion preference for the viewport tool, also as raw CDP (the relay answers
// Playwright's own Emulation.setEmulatedMedia, so pages keep the user's real appearance). tab.media holds what is set;
// it is cleared with the metrics.
export async function setMedia(tab, { colorScheme, reducedMotion }) {
  const media = { ...tab.media };
  if (colorScheme !== undefined) media.colorScheme = colorScheme;
  if (reducedMotion !== undefined) media.reducedMotion = reducedMotion;
  tab.media = media;
  const features = [];
  if (media.colorScheme) features.push({ name: 'prefers-color-scheme', value: media.colorScheme });
  if (media.reducedMotion !== undefined) features.push({ name: 'prefers-reduced-motion', value: media.reducedMotion ? 'reduce' : 'no-preference' });
  await cdp(tab, 'Emulation.setEmulatedMedia', { media: '', features });
}

// reason: tool, release, turn end, handoff. Resolves false when no override was set.
export async function clearViewport(tab, reason = 'tool') {
  const media = tab.media;
  if (media) {
    await cdp(tab, 'Emulation.setEmulatedMedia', { media: '', features: [] });
    if (tab.media === media) tab.media = null;
  }
  const was = tab.viewport;
  if (!was) return !!media;
  if (was.clearing) return true; // another clear is at it
  // Forgotten only once Chrome cleared all of it, so a failed reset can be retried (clearing the metrics twice is harmless).
  was.clearing = true;
  try {
    await cdp(tab, 'Emulation.clearDeviceMetricsOverride');
    tab.browser.relay.viewports.delete(tab.tabId);
    if (was.mobile) await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  } catch (error) {
    was.clearing = false;
    throw error;
  }
  if (tab.viewport !== was) return true; // set again meanwhile
  tab.viewport = null;
  viewportEvent('clear', tab, was, reason);
  return true;
}
