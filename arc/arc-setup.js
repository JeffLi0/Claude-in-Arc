/**
 * Arc Setup — asks once for the folder the extension was loaded from, so the
 * updater can write new releases into it. Also re-grants access when the
 * browser has forgotten it (after a restart, Chromium may ask again).
 */

const goButton = document.getElementById('go');
const statusEl = document.getElementById('status');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

async function finish() {
  setStatus('Checking for updates…');
  const res = await chrome.runtime.sendMessage({ type: 'ARC_UPDATE_NOW' }).catch(() => null);
  const messages = {
    current: 'All set. You have the latest version, and future updates will install on their own.',
    updated: 'All set. An update was installed and will apply the next time you step away.',
  };
  setStatus(messages[res?.status] || 'All set. Updates will install on their own.');
  goButton.hidden = true;
}

async function init() {
  const dir = await arcGetExtensionDir();
  if (dir && (await arcIsThisExtension(dir).catch(() => false))) {
    // Already chosen; only the permission needs renewing.
    goButton.textContent = 'Allow updates';
    document.getElementById('title').textContent = 'Allow Claude in Arc to update';
    document.getElementById('intro').textContent =
      'Arc needs you to confirm access to the Claude-in-Arc folder again before an update can be installed.';
    if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') await finish();
  }
}

goButton.addEventListener('click', async () => {
  goButton.disabled = true;
  try {
    let dir = await arcGetExtensionDir();
    if (dir && (await arcIsThisExtension(dir).catch(() => false))) {
      if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        setStatus('Access wasn’t granted, so updates can’t be installed yet.', true);
        return;
      }
    } else {
      dir = await window.showDirectoryPicker({ id: 'claude-in-arc', mode: 'readwrite' });
      if (!(await arcIsThisExtension(dir))) {
        setStatus('That folder isn’t this extension. Choose the Claude-in-Arc folder you loaded in arc://extensions.', true);
        return;
      }
      await arcSetExtensionDir(dir);
    }
    await finish();
  } catch (e) {
    if (e?.name !== 'AbortError') setStatus(`Something went wrong: ${e?.message || e}`, true);
  } finally {
    goButton.disabled = false;
  }
});

init();
