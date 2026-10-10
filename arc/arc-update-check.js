/**
 * Arc Update Check — keeps a Load-unpacked install current with no effort.
 *
 * Once a day it checks the fork's latest release, has the offscreen document
 * write it into the folder the user granted on arc-setup.html, and reloads once
 * nothing is in progress. A development build (scripts/build.py on your
 * machine) is replaced only when Anthropic has shipped a newer Claude in
 * Chrome; until then it's newer local work. It also reloads into a rebuilt
 * dist/ within a minute or two.
 */

const _UPDATE_RELEASES_URL = 'https://api.github.com/repos/JeffLi0/Claude-in-Arc/releases/latest';
const _UPDATE_ALARM = 'arc-update-check';
const _DISK_ALARM = 'arc-disk-update-check';
const _IDLE_SECONDS = 30 * 60;
// A task makes a model request at least every few minutes while it runs.
const _QUIET_MS = 15 * 60 * 1000;
const _DEV_QUIET_MS = 2 * 60 * 1000;
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

// A tab in the user's current window. A window the extension opens without
// a click lands behind the others in Arc.
async function _openSetupPrompt() {
  const main = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  await chrome.tabs.create({ url: chrome.runtime.getURL('arc-setup.html'), active: true, windowId: main?.id });
  if (main) chrome.windows.update(main.id, { focused: true }).catch(() => {});
}

async function _askForAccess(status) {
  // "Not now" on the prompt means no reminders either.
  const { arc_update_declined: declined } = await chrome.storage.local.get('arc_update_declined');
  if (declined) return;
  await chrome.action.setBadgeBackgroundColor({ color: '#D97757' });
  await chrome.action.setBadgeText({ text: '!' });
  // Say which of the two causes it is; they need different things from the user.
  const message = status === 'wrong-folder'
    ? 'Its folder has moved or changed. Click to choose the folder it’s loaded from.'
    : 'Click to install it.';
  await chrome.notifications.create(_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: '/icon-128.png',
    title: 'A Claude in Arc update is ready',
    message,
    requireInteraction: true,
  }).catch(() => {});
}

async function _clearAccessPrompt() {
  if ((await chrome.action.getBadgeText({})) === '!') await chrome.action.setBadgeText({ text: '' });
  await chrome.notifications.clear(_NOTIFICATION_ID).catch(() => {});
}

async function _latestRelease() {
  const res = await fetch(_UPDATE_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const asset = (await res.json()).assets?.find((a) => /\.zip$/.test(a.name));
  if (!asset) throw new Error('Release has no ZIP');
  // The ZIP is replaced in place when only the patches change, so its
  // timestamp, not the tag, identifies a build.
  return { url: asset.browser_download_url, marker: `${asset.browser_download_url} ${asset.updated_at}` };
}

async function _recordResult(marker, result) {
  // No folder yet is the prompt's job; only nag when access was granted once
  // and Arc has since forgotten it.
  if (result?.status === 'needs-permission' || result?.status === 'wrong-folder') {
    await _askForAccess(result.status);
  } else if (result?.status === 'updated' || result?.status === 'current') {
    await chrome.storage.local.set({
      arc_update_marker: marker, arc_release_files: result.files, arc_release_build: result.versionName,
    });
    await _clearAccessPrompt();
    if (result.status === 'updated') _reloadWhenSafe();
  }
  return result;
}

// One check at a time: two installs writing the same files would race, and a
// check reading manifest.json mid-write would see a partial file.
let _checkInFlight = null;
function _checkForUpdate() {
  _checkInFlight ??= _runUpdateCheck().finally(() => { _checkInFlight = null; });
  return _checkInFlight;
}

async function _runUpdateCheck() {
  try {
    const { url, marker } = await _latestRelease();
    const { arc_update_marker: seen } = await chrome.storage.local.get('arc_update_marker');
    if (seen === marker) return { status: 'current' };
    await _ensureOffscreen();
    const result = await chrome.runtime.sendMessage({ type: 'ARC_APPLY_UPDATE', url });
    return _recordResult(marker, result);
  } catch (e) {
    return { status: 'error', error: String(e) };
  }
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === _NOTIFICATION_ID) _openSetupPrompt();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'ARC_LATEST_RELEASE':
      // arc-setup.html installs an update itself when Arc has dropped access
      // for the background (see arc-setup.js).
      _latestRelease().then(sendResponse, (e) => sendResponse({ status: 'error', error: String(e) }));
      return true;
    case 'ARC_UPDATE_APPLIED':
      _recordResult(msg.marker, msg.result).then(sendResponse, () => sendResponse(null));
      return true;
    case 'ARC_UPDATE_NOW':
      // From arc-setup.html once a folder is chosen. Answer at once so the tab
      // can close; the install carries on here.
      _checkForUpdate();
      sendResponse({ status: 'started' });
      return false;
    default:
      return false;
  }
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
// A development build reloads as soon as no task is running: after a rebuild
// of dist/, every profile with it loaded switches within a minute or two.
async function _reloadWhenSafe(idleState) {
  if (!(await _diskBuildChanged())) return;
  if (!_IS_DEV_BUILD && (idleState ?? await chrome.idle.queryState(_IDLE_SECONDS)) === 'active') return;
  const { arc_last_agent_activity: last = 0 } = await chrome.storage.session.get('arc_last_agent_activity');
  if (Date.now() - last < (_IS_DEV_BUILD ? _DEV_QUIET_MS : _QUIET_MS)) return;
  chrome.runtime.reload();
}

chrome.idle.setDetectionInterval(_IDLE_SECONDS);
chrome.idle.onStateChanged.addListener((state) => { _reloadWhenSafe(state); });

// Alarms outlive reloads, so re-create one when its interval has changed.
function _ensureAlarm(name, periodInMinutes, delayInMinutes) {
  chrome.alarms.get(name).then((alarm) => {
    if (alarm?.periodInMinutes !== periodInMinutes) chrome.alarms.create(name, { periodInMinutes, delayInMinutes });
  });
}
// Releases come out about weekly; once a day keeps up without being chatty.
_ensureAlarm(_UPDATE_ALARM, 24 * 60, 1);
_ensureAlarm(_DISK_ALARM, _IS_DEV_BUILD ? 1 : 15);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === _UPDATE_ALARM) _checkForUpdate();
  if (alarm.name === _DISK_ALARM) _reloadWhenSafe();
});

// ─── After installing or reloading ───
async function _reinjectContentScripts() {
  // Chromium doesn't inject content scripts into tabs that were already open
  // when the extension was installed or reloaded, so the panel wouldn't open
  // there until each tab is refreshed. Inject them now instead.
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

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.accountUuid?.newValue) return;
  const { arc_update_prompt_after_sign_in: pending } = await chrome.storage.local.get('arc_update_prompt_after_sign_in');
  if (!pending) return;
  await chrome.storage.local.remove('arc_update_prompt_after_sign_in');
  // Let the sign-in window finish redirecting first, so the prompt lands on top.
  setTimeout(() => _openSetupPrompt(), 1500);
});

// Runs whenever this worker starts on a build it hasn't run before: first
// install, a reload into new files, or a browser restart that picked up new
// files. Comparing against the last build seen covers all three, where
// onInstalled's reasons differ between them.
(async () => {
  const build = chrome.runtime.getManifest().version_name;
  const { arc_running_build: previous, arc_update_folder_chosen: chosen, arc_update_declined: declined,
    arc_release_files: keep, arc_release_build: releaseBuild } = await chrome.storage.local.get(
    ['arc_running_build', 'arc_update_folder_chosen', 'arc_update_declined', 'arc_release_files', 'arc_release_build']);
  if (previous === build) return;
  await chrome.storage.local.set({ arc_running_build: build });

  // A "can't update" notification from an earlier install can outlive it.
  if (!chosen) await _clearAccessPrompt().catch(() => {});
  if (!chosen && !declined) {
    // On a fresh install upstream opens the claude.ai sign-in window, and a
    // second window opened alongside it ends up hidden in Arc. Ask once the
    // user has signed in instead (see the storage listener below).
    const { accountUuid } = await chrome.storage.local.get('accountUuid');
    if (accountUuid) _openSetupPrompt();
    else await chrome.storage.local.set({ arc_update_prompt_after_sign_in: true });
  }
  await _reinjectContentScripts();
  // Only once the release it saved the file list for is the build running;
  // after a local rebuild that list would name the wrong files.
  if (previous && keep?.length && releaseBuild === build) {
    await _ensureOffscreen().catch(() => {});
    chrome.runtime.sendMessage({ type: 'ARC_CLEANUP_UPDATE', keep }).catch(() => {});
  }
})();
