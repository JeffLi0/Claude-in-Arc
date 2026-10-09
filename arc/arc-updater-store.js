/**
 * Arc Updater Store — remembers the folder the extension was loaded from.
 *
 * The user grants it once on arc-setup.html; the offscreen document reads it
 * back to write each new release into place. Shared by both pages.
 */

const _ARC_DB = 'arc-updater';
const _ARC_STORE = 'handles';
const _ARC_DIR_KEY = 'extensionDir';

function _arcOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_ARC_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(_ARC_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function arcGetExtensionDir() {
  const db = await _arcOpenDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(_ARC_STORE).objectStore(_ARC_STORE).get(_ARC_DIR_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function arcSetExtensionDir(handle) {
  const db = await _arcOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_ARC_STORE, 'readwrite');
    tx.objectStore(_ARC_STORE).put(handle, _ARC_DIR_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// True when `dir` holds this extension: same manifest key means same ID.
async function arcIsThisExtension(dir) {
  try {
    const file = await (await dir.getFileHandle('manifest.json')).getFile();
    return JSON.parse(await file.text()).key === chrome.runtime.getManifest().key;
  } catch (e) {
    return false;
  }
}
