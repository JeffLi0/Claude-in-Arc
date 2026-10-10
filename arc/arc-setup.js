/**
 * Arc Setup — the "keep up to date?" prompt, and the "update ready" page.
 *
 * An extension can't learn the folder it was loaded from, and the browser only
 * lets it write to a folder the user picks, so this asks once. Arc drops that
 * access again once no page of the extension is open, and its "Allow on every
 * visit" dialog can't be clicked, so when an update is waiting and access has
 * lapsed, the background sends a notification that opens this page again.
 * There the picker opens at the saved folder, so it's one click on Select,
 * and this page installs the update itself while it holds access.
 */

const goButton = document.getElementById('go');
const laterButton = document.getElementById('later');
const statusEl = document.getElementById('status');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function done(text) {
  goButton.hidden = laterButton.hidden = true;
  document.getElementById('next').hidden = true;
  setStatus(text);
  statusEl.classList.add('done');
}

// The folder Arc is running from: same extension ID and the very build that's
// loaded. An older unzipped copy elsewhere has the same ID, so the build is
// what tells them apart.
async function isLoadedCopy(dir) {
  try {
    const file = await (await dir.getFileHandle('manifest.json')).getFile();
    const m = JSON.parse(await file.text());
    const running = chrome.runtime.getManifest();
    return m.key === running.key && m.version_name === running.version_name;
  } catch (e) {
    return false;
  }
}

// People often pick the folder that contains it (Downloads, say); look one
// level down before giving up.
async function findLoadedCopy(dir) {
  if (await isLoadedCopy(dir)) return dir;
  for await (const [, entry] of dir.entries()) {
    if (entry.kind === 'directory' && (await isLoadedCopy(entry))) return entry;
  }
  return null;
}

async function pick(startIn) {
  const picked = await window.showDirectoryPicker({ id: 'claude-in-arc', mode: 'readwrite', startIn });
  const dir = await findLoadedCopy(picked);
  if (!dir) {
    setStatus('That isn’t the copy Arc is running. In arc://extensions, Claude in Arc shows the folder it was loaded from; choose that one.', true);
    return null;
  }
  await arcSetExtensionDir(dir);
  await chrome.storage.local.set({ arc_update_folder_chosen: true, arc_update_declined: false });
  return dir;
}

// ─── First time: choose the folder ───
async function setUp() {
  // An extension can't learn its own path, so start where most people unzip it.
  if (!(await pick('downloads'))) return;
  // The background installs anything newer; nothing here needs to wait.
  await chrome.runtime.sendMessage({ type: 'ARC_UPDATE_NOW' }).catch(() => {});
  done('Automatic updates are on. You can close this tab.');
}

// ─── Later: an update is waiting and Arc dropped access ───
function showInstallMode() {
  const title = document.getElementById('title');
  title.replaceChildren(Object.assign(document.createElement('b'), { textContent: 'Claude in Arc' }),
    ' has an update ready');
  document.getElementById('next-text').replaceChildren('Click ',
    Object.assign(document.createElement('b'), { textContent: 'Install update' }),
    '. The folder window opens at the Claude-in-Arc folder, so just click ',
    Object.assign(document.createElement('b'), { textContent: 'Select' }), '.');
  document.querySelector('.next .why').textContent =
    'Arc only lets an extension write to its folder while one of its pages is open.';
  goButton.textContent = 'Install update';
  laterButton.textContent = 'Later';
}

async function install(saved) {
  // Opens at the saved folder; the picked one must be it (or the loaded copy).
  if (!(await pick(saved))) return;
  goButton.hidden = laterButton.hidden = true;
  setStatus('Installing… keep this tab open for a few seconds.');
  // This page holds access only while it's open, so it installs the update
  // itself rather than handing it to the background.
  const release = await chrome.runtime.sendMessage({ type: 'ARC_LATEST_RELEASE' });
  if (release?.status === 'error') throw new Error(release.error);
  const result = await _arcApplyUpdate(release.url);
  await chrome.runtime.sendMessage({ type: 'ARC_UPDATE_APPLIED', marker: release.marker, result });
  if (result.status === 'updated') done('Updated. It switches over the next time you step away. You can close this tab.');
  else if (result.status === 'current') done('Already up to date. You can close this tab.');
  else throw new Error(result.error || result.status);
}

let savedDir = null;

goButton.addEventListener('click', async () => {
  goButton.disabled = true;
  try {
    await (savedDir ? install(savedDir) : setUp());
  } catch (e) {
    if (e?.name !== 'AbortError') {
      goButton.hidden = laterButton.hidden = false;
      setStatus(`Something went wrong: ${e?.message || e}`, true);
    }
  } finally {
    goButton.disabled = false;
  }
});

laterButton.addEventListener('click', async () => {
  // "Not now" on first setup means no reminders; "Later" on an update just
  // closes, and the notification comes back with the next check.
  if (!savedDir) await chrome.storage.local.set({ arc_update_declined: true });
  window.close();
});

arcGetExtensionDir().then((dir) => {
  savedDir = dir;
  if (dir) showInstallMode();
});
