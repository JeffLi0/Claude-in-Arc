/**
 * Arc Session Tracker
 * Since chrome.tabGroups doesn't work in Arc, the official extension's
 * multi-tab session bookkeeping (which tabs belong to the current task)
 * never resolves. This is a parallel, Arc-only tracker: it records which
 * tabIds are part of "Claude's current session" and tells each tab's
 * content script to show/hide an orange border accordingly.
 *
 * Two ways a tab joins the session:
 *   - "anchor": its side panel is open (arc-panel-injector.js reports this).
 *     Anchors don't expire on their own — they clear when the panel closes
 *     or the tab is closed.
 *   - "touched": a tool call (bridge-intercepted or arc-adapter) acted on it.
 *     Touched tabs expire after TOUCH_TIMEOUT_MS of inactivity, so a tab
 *     Claude visited once doesn't stay bordered forever.
 *
 * State lives in chrome.storage.session (not a JS variable) because the
 * MV3 service worker can be killed and respawned between tool calls.
 */

const SESSION_KEY = 'claude_arc_session_tabs';
const TOUCH_TIMEOUT_MS = 10 * 60 * 1000;
const SWEEP_ALARM = 'arc-session-sweep';

async function getSessionMap() {
  try {
    const r = await chrome.storage.session.get(SESSION_KEY);
    return r[SESSION_KEY] || {};
  } catch (e) {
    return {};
  }
}

async function setSessionMap(map) {
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: map });
  } catch (e) {}
}

function notifyTab(tabId, type) {
  try {
    chrome.tabs.sendMessage(Number(tabId), { type }).catch(() => {});
  } catch (e) {}
}

async function touchSessionTab(tabId, { pinned = false } = {}) {
  if (!tabId) return;
  const map = await getSessionMap();
  const existing = map[tabId];
  map[tabId] = { touchedAt: Date.now(), pinned: pinned || existing?.pinned || false };
  await setSessionMap(map);
  if (!existing) notifyTab(tabId, 'ARC_SESSION_BORDER_SHOW');
}

async function releaseSessionTab(tabId) {
  if (!tabId) return;
  const map = await getSessionMap();
  if (!map[tabId]) return;
  delete map[tabId];
  await setSessionMap(map);
  notifyTab(tabId, 'ARC_SESSION_BORDER_HIDE');
}

async function sweepExpired() {
  const map = await getSessionMap();
  const now = Date.now();
  let changed = false;
  for (const [tabId, info] of Object.entries(map)) {
    if (info.pinned) continue;
    if (now - info.touchedAt > TOUCH_TIMEOUT_MS) {
      delete map[tabId];
      changed = true;
      notifyTab(tabId, 'ARC_SESSION_BORDER_HIDE');
    }
  }
  if (changed) await setSessionMap(map);
}

try {
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
} catch (e) {}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) sweepExpired();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await getSessionMap();
  if (map[tabId]) {
    delete map[tabId];
    await setSessionMap(map);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ARC_SESSION_BORDER_QUERY') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ active: false });
      return false;
    }
    getSessionMap().then((map) => sendResponse({ active: !!map[tabId] }));
    return true;
  }
  if (msg.type === 'ARC_SESSION_ANCHOR_OPEN') {
    touchSessionTab(msg.tabId, { pinned: true });
    return false;
  }
  if (msg.type === 'ARC_SESSION_ANCHOR_CLOSE') {
    releaseSessionTab(msg.tabId);
    return false;
  }
});

self._arcSessionTracker = {
  touch: touchSessionTab,
  release: releaseSessionTab
};
