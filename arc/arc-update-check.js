/**
 * Arc Update Check — keeps a Load-unpacked install current with no effort.
 *
 * Release builds (from GitHub) check the fork's latest release every few
 * hours, have the offscreen document write it into the folder the user granted
 * on arc-setup.html, and reload once nothing is in progress. Development
 * builds (scripts/build.py on your machine) never download anything; they
 * only reload into a rebuilt dist/ folder.
 */

const _UPDATE_RELEASES_URL = 'https://api.github.com/repos/JeffLi0/Claude-in-Arc/releases/latest';
const _UPDATE_ALARM = 'arc-update-check';
const _DISK_ALARM = 'arc-disk-update-check';
const _IDLE_SECONDS = 30 * 60;
// A task makes a model request at least every few minutes while it runs.
const _QUIET_MS = 15 * 60 * 1000;
const _NOTIFICATION_ID = 'arc-update-needs-access';

const _IS_DEV_BUILD = /\.dev\./.test(chrome.runtime.getManifest().version_name || '');

// ─── Downloading releases into the folder ───
async function _ensureOffscreen() {
  // Upstream's offscreen page carries our updater script and checks
  // hasDocument() before creating it, so either side may create it first.
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.BLOBS],
      justification: 'Keep service worker alive, play notification sounds, generate GIFs, install updates',
    });
  } catch (e) {
    if (!(await chrome.offscreen.hasDocument())) throw e;
  }
}

async function _askForAccess() {
  await chrome.action.setBadgeBackgroundColor({ color: '#D97757' });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.notifications.create(_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: '/icon-128.png',
    title: 'Claude in Arc can’t update',
    message: 'Click to let it update itself.',
    requireInteraction: true,
  }).catch(() => {});
}

async function _clearAccessPrompt() {
  if ((await chrome.action.getBadgeText({})) === '!') await chrome.action.setBadgeText({ text: '' });
  await chrome.notifications.clear(_NOTIFICATION_ID).catch(() => {});
}

async function _checkForUpdate() {
  if (_IS_DEV_BUILD) return { status: 'dev' };
  try {
    const res = await fetch(_UPDATE_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!res.ok) return { status: 'error', error: `GitHub ${res.status}` };
    const asset = (await res.json()).assets?.find((a) => /\.zip$/.test(a.name));
    if (!asset) return { status: 'error', error: 'Release has no ZIP' };
    // The ZIP is replaced in place when only the patches change, so its
    // timestamp, not the tag, identifies a build.
    const marker = `${asset.browser_download_url} ${asset.updated_at}`;
    const { arc_update_marker: seen } = await chrome.storage.local.get('arc_update_marker');
    if (seen === marker) return { status: 'current' };

    await _ensureOffscreen();
    const result = await chrome.runtime.sendMessage({ type: 'ARC_APPLY_UPDATE', url: asset.browser_download_url });
    if (result?.status === 'needs-permission' || result?.status === 'no-folder' || result?.status === 'wrong-folder') {
      await _askForAccess();
      return result;
    }
    if (result?.status === 'updated' || result?.status === 'current') {
      await chrome.storage.local.set({ arc_update_marker: marker, arc_release_files: result.files });
      await _clearAccessPrompt();
      if (result.status === 'updated') _reloadWhenSafe();
    }
    return result;
  } catch (e) {
    return { status: 'error', error: String(e) };
  }
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === _NOTIFICATION_ID) chrome.tabs.create({ url: chrome.runtime.getURL('arc-setup.html') });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ARC_UPDATE_NOW') return false;
  chrome.storage.local.remove('arc_update_marker')
    .then(_checkForUpdate)
    .then(sendResponse);
  return true;
});

// ─── Reloading into new files, without interrupting anything ───
async function _diskBuildChanged() {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    return (await res.json()).version_name !== chrome.runtime.getManifest().version_name;
  } catch (e) {
    return false;
  }
}

// Reloading closes every Claude panel and drops whatever it was doing, so wait
// until the user has stepped away and no task has touched the model or the
// browser for a while. arc-activity.js and the bridge shim record that.
async function _reloadWhenSafe(idleState) {
  if (!(await _diskBuildChanged())) return;
  if ((idleState ?? await chrome.idle.queryState(_IDLE_SECONDS)) === 'active') return;
  const { arc_last_agent_activity: last = 0 } = await chrome.storage.session.get('arc_last_agent_activity');
  if (Date.now() - last < _QUIET_MS) return;
  chrome.runtime.reload();
}

chrome.idle.setDetectionInterval(_IDLE_SECONDS);
chrome.idle.onStateChanged.addListener((state) => { _reloadWhenSafe(state); });

chrome.alarms.get(_UPDATE_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(_UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 6 * 60 });
});
chrome.alarms.get(_DISK_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(_DISK_ALARM, { periodInMinutes: 15 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === _UPDATE_ALARM) _checkForUpdate();
  if (alarm.name === _DISK_ALARM) _reloadWhenSafe();
});

// ─── After installing or reloading ───
async function _reinjectContentScripts() {
  // A reload orphans the content scripts in open tabs, so the panel would stop
  // opening there until each tab is refreshed. Inject the new ones instead.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      // The orphaned injector's panel would block the new one ("Panel already
      // exists"), and its page squeeze would linger.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          document.getElementById('claude-arc-panel-host')?.remove();
          document.getElementById('claude-squeeze-style')?.remove();
        },
      });
      for (const cs of chrome.runtime.getManifest().content_scripts || []) {
        const onClaude = /^https:\/\/([^/]+\.)?claude\.ai\//.test(tab.url || '');
        if (!cs.matches.includes('<all_urls>') && !onClaude) continue;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: !!cs.all_frames },
          files: cs.js,
          world: cs.world || 'ISOLATED',
        }).catch(() => {});
      }
    } catch (e) {}
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !_IS_DEV_BUILD) {
    chrome.tabs.create({ url: chrome.runtime.getURL('arc-setup.html') });
    return;
  }
  if (reason !== 'update') return;
  await _reinjectContentScripts();
  const { arc_release_files: keep } = await chrome.storage.local.get('arc_release_files');
  if (!_IS_DEV_BUILD && keep?.length) {
    await _ensureOffscreen().catch(() => {});
    chrome.runtime.sendMessage({ type: 'ARC_CLEANUP_UPDATE', keep }).catch(() => {});
  }
});
