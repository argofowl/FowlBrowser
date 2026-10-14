/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Vendored from playwright-core/src/tools/mcp/browserModel.ts (Playwright 1.64), ported to JS.
// FowlBrowser changes: `tabIdForTarget()` so the relay can tell Playwright which chrome tab a page is,
// `hasTab()`/`isAttached()` for the server, `disconnectCDP()` returns the attached tab ids and the attachments
// still in flight, a CDP generation fences attachments that land after a disconnect (they detach again instead
// of installing a session), a tab removed while attaching is not installed, `forgetTab()` and `reattach()` for the
// server, and errors are logged to stderr instead of Playwright's debug logger.

const logUnhandledError = (error) => process.stderr.write(`[fowlbrowser] ${error?.stack ?? error}\n`);

/**
 * Browser-side tab model used by the relay. Owns the mapping between chrome tab ids and CDP session ids,
 * and is the single place that translates between the chrome.* dialect spoken by the extension and the
 * CDP dialect spoken by Playwright.
 *
 *  1. The extension pushes `chrome.tabs.onCreated` for each tab we own; the model records them as known.
 *  2. Playwright sends `Target.setAutoAttach` -> `enableAutoAttach()` attaches every known tab and emits
 *     `Target.attachedToTarget` for each.
 *  3. Later creates / detaches / removes flow through the same inputs and become CDP events.
 */
export class BrowserModel {
  _sendToCDPClient = null;
  _knownTabs = new Map();   // tabId -> chrome tab
  _tabSessions = new Map(); // tabId -> { tabId, sessionId, targetInfo, childSessions }
  _autoAttach = false;
  _nextSessionId = 1;
  _generation = 0;           // bumped on every CDP disconnect
  _attaching = new Map();    // tabId -> Promise<tabSession> of an attachment in flight
  gestures = new Map();      // tabId -> calls running now whose evaluations act for the user (FowlBrowser)

  constructor(sendToExtension) {
    this._sendToExtension = sendToExtension;
  }

  connectOverCDP(sendToCDPClient) {
    this._sendToCDPClient = sendToCDPClient;
  }

  // Playwright disconnected: forget sessions so a later connection re-attaches from scratch.
  // Returns the tab ids that were attached, so the relay can detach their debuggers.
  disconnectCDP() {
    this._sendToCDPClient = null;
    this._autoAttach = false;
    this._generation++;
    const tabIds = [...this._tabSessions.keys()];
    this._tabSessions.clear();
    const attaching = [...this._attaching.values()];
    this._attaching.clear();
    return { tabIds, attaching };
  }

  // Tabs this client owns (whether or not they are attached right now).
  hasTab(tabId) {
    return this._knownTabs.has(tabId);
  }

  isAttached(tabId) {
    return this._tabSessions.has(tabId);
  }

  _emit(message) {
    this._sendToCDPClient?.(message);
  }

  // --- Extension -> model inputs ---

  onTabCreated(tab) {
    if (tab.id === undefined)
      return;
    this._knownTabs.set(tab.id, tab);
    if (this._autoAttach)
      void this._attachTab(tab.id).catch(logUnhandledError);
  }

  onTabRemoved(tabId) {
    this._knownTabs.delete(tabId);
    this._detachTab(tabId);
  }

  // The server attaches a tab of ours again whose debugger let go while it stayed ours (takeover.mjs: a link for
  // another app); a new session, so Playwright gets a new page.
  async reattach(tabId) {
    if (!this._knownTabs.has(tabId))
      throw new Error(`Tab ${tabId} is not known`);
    return await this._attachTab(tabId);
  }

  // The server learned the tab is no longer ours (released or closed) even if no event says so.
  forgetTab(tabId) {
    if (this._knownTabs.has(tabId) || this._tabSessions.has(tabId))
      this.onTabRemoved(tabId);
  }

  onDebuggerEvent(source, method, params) {
    if (source.tabId === undefined)
      return;
    const tabSession = this._tabSessions.get(source.tabId);
    if (!tabSession)
      return;
    // Child CDP sessions (workers, oopifs) belong to the same tab and keep their own sessionId.
    const childSessionId = params?.sessionId;
    if (method === 'Target.attachedToTarget' && childSessionId)
      tabSession.childSessions.add(childSessionId);
    else if (method === 'Target.detachedFromTarget' && childSessionId)
      tabSession.childSessions.delete(childSessionId);
    const sessionId = source.sessionId || tabSession.sessionId;
    this._emit({ sessionId, method, params });
  }

  onDebuggerDetach(source) {
    if (source.tabId !== undefined)
      this._detachTab(source.tabId);
  }

  // --- Playwright -> model commands ---

  async enableAutoAttach() {
    this._autoAttach = true;
    const tabIds = [...this._knownTabs.keys()];
    await Promise.all(tabIds.map(tabId => this._attachTab(tabId).catch(logUnhandledError)));
  }

  async createTarget(url) {
    const tab = await this._sendToExtension('chrome.tabs.create', [{ url }]);
    if (tab?.id === undefined)
      throw new Error('Failed to create tab');
    this._knownTabs.set(tab.id, tab);
    const tabSession = await this._attachTab(tab.id);
    return { targetId: tabSession.targetInfo?.targetId };
  }

  async closeTarget(targetId) {
    const tabSession = targetId ? this._findTabSession(s => s.targetInfo?.targetId === targetId) : undefined;
    if (!tabSession)
      return { success: false };
    await this._sendToExtension('chrome.tabs.remove', [tabSession.tabId]);
    return { success: true };
  }

  getTargetInfo(sessionId) {
    if (!sessionId)
      return undefined;
    return this._findTabSession(s => s.sessionId === sessionId)?.targetInfo;
  }

  tabIdForTarget(targetId) {
    return this._findTabSession(s => s.targetInfo?.targetId === targetId)?.tabId;
  }

  tabIdForSession(sessionId) {
    return this._findTabSession(s => s.sessionId === sessionId)?.tabId;
  }

  // Browser-level commands (Storage.*, Browser.*) need a target for chrome.debugger, so route through any
  // attached tab; the command is browser-scoped and returns the same result regardless of the tab.
  async sendBrowserCommand(method, params) {
    const tabSession = this._tabSessions.values().next().value;
    if (!tabSession)
      throw new Error(`No attached tab to forward browser-level command: ${method}`);
    return await this._sendToExtension('chrome.debugger.sendCommand', [{ tabId: tabSession.tabId }, method, params]);
  }

  async sendCommand(sessionId, method, params) {
    // 1. A relay-level tab session (pw-tab-N): route by tabId.
    // 2. A child CDP session (worker, oopif): route to its owning tab and keep the sessionId.
    let tabSession = this._findTabSession(s => s.sessionId === sessionId);
    let cdpSessionId;
    if (!tabSession) {
      tabSession = this._findTabSession(s => s.childSessions.has(sessionId));
      cdpSessionId = sessionId;
    }
    if (!tabSession)
      throw new Error(`No tab found for sessionId: ${sessionId}`);
    // FowlBrowser: Playwright runs every evaluation as if the user had just clicked (userGesture), which leaves the page
    // a user activation for 5 s after a mere snapshot or ref check: a page timer could then open a file chooser (the
    // Mac's panel on the user's screen) or start sound with it. Only calls that ask for it keep it (gestures).
    if ((method === 'Runtime.callFunctionOn' || method === 'Runtime.evaluate') && params?.userGesture && !this.gestures.get(tabSession.tabId))
      params = { ...params, userGesture: false };
    return await this._sendToExtension('chrome.debugger.sendCommand', [
      { tabId: tabSession.tabId, sessionId: cdpSessionId },
      method,
      params,
    ]);
  }

  // --- Internals ---

  async _attachTab(tabId) {
    const existing = this._tabSessions.get(tabId) ?? this._attaching.get(tabId);
    if (existing)
      return existing;
    const attach = this._doAttachTab(tabId, this._generation);
    this._attaching.set(tabId, attach);
    try {
      return await attach;
    } finally {
      if (this._attaching.get(tabId) === attach)
        this._attaching.delete(tabId);
    }
  }

  async _doAttachTab(tabId, generation) {
    let attached = false;
    let targetInfo;
    try {
      await this._sendToExtension('chrome.debugger.attach', [{ tabId }, '1.3']);
      attached = true;
      const result = await this._sendToExtension('chrome.debugger.sendCommand', [{ tabId }, 'Target.getTargetInfo']);
      targetInfo = result?.targetInfo;
    } finally {
      // Landed after Playwright disconnected: undo it before the next connection is served (it waits on this).
      if (attached && generation !== this._generation)
        await this._sendToExtension('chrome.debugger.detach', [{ tabId }]).catch(() => {});
    }
    if (generation !== this._generation)
      throw new Error(`Tab ${tabId} attached after the CDP client disconnected`);
    if (!this._knownTabs.has(tabId))
      throw new Error(`Tab ${tabId} went away while attaching`);
    const sessionId = `pw-tab-${this._nextSessionId++}`;
    const tabSession = { tabId, sessionId, targetInfo, childSessions: new Set() };
    this._tabSessions.set(tabId, tabSession);
    this._emit({
      method: 'Target.attachedToTarget',
      params: { sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false },
    });
    return tabSession;
  }

  _detachTab(tabId) {
    const tabSession = this._tabSessions.get(tabId);
    if (!tabSession)
      return;
    this._tabSessions.delete(tabId);
    this._emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: tabSession.sessionId, targetId: tabSession.targetInfo?.targetId },
    });
  }

  _findTabSession(predicate) {
    for (const session of this._tabSessions.values()) {
      if (predicate(session))
        return session;
    }
    return undefined;
  }
}
