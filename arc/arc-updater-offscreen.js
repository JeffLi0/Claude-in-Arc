/**
 * Arc Updater (offscreen document) — writes a new release into the loaded folder.
 *
 * An unpacked extension can't be updated by the browser, but it runs from a
 * folder on disk. With the folder the user granted on arc-setup.html, this
 * downloads the release ZIP, unpacks it, and writes it over the folder. The
 * service worker then reloads the extension once nothing is in progress.
 *
 * Runs in the offscreen document because writing needs a window context, and
 * the service worker has none.
 */

const _ARC_ZIP_ROOT = 'Claude-in-Arc/';

// ─── ZIP reading (stored and deflate entries; that's all build.py writes) ───
async function _arcUnzip(buffer) {
  const view = new DataView(buffer);
  let eocd = buffer.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = new Uint8Array(buffer, start, size);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`Unsupported ZIP compression ${method} for ${name}`);
    files.set(name, data);
  }
  return files;
}

async function _arcWriteFile(dir, path, data) {
  const parts = path.split('/');
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

// Hashed bundles first, then the fixed-name files that point at them, and the
// manifest last: if the write is interrupted, the old manifest still loads a
// consistent set, because no file the old build needs is ever removed here.
function _arcWriteOrder(path) {
  if (path === 'manifest.json') return 3;
  if (!path.includes('/') || /^assets\/arc-|^assets\/(claude-panel-injector|cmd-e-fallback|theme-init|viewport-override)\.js$/.test(path)) return 2;
  return 1;
}

function _arcIsNewerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Whether `installed` (a manifest) already counts as `release`. A local
// development build always differs from the release, so it's only replaced
// once Anthropic has shipped a newer Claude in Chrome; until then it's the
// developer's own, newer work.
function _arcIsUpToDate(installed, release) {
  if (installed.version_name === release.version_name) return true;
  return /\.dev\./.test(installed.version_name || '') && !_arcIsNewerVersion(release.version, installed.version);
}

async function _arcApplyUpdate(url) {
  const dir = await arcGetExtensionDir();
  if (!dir) return { status: 'no-folder' };

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const zipped = await _arcUnzip(await res.arrayBuffer());
  const files = new Map();
  for (const [name, data] of zipped) {
    if (name.startsWith(_ARC_ZIP_ROOT)) files.set(name.slice(_ARC_ZIP_ROOT.length), data);
  }
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('Release has no manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.key !== chrome.runtime.getManifest().key) throw new Error('Release is for a different extension');
  const current = { status: 'current', files: [...files.keys()], versionName: manifest.version_name };

  // Decide whether there's anything to install before touching the folder, so
  // a lapsed folder permission only matters (and only asks the user) when an
  // update is actually waiting.
  if (_arcIsUpToDate(chrome.runtime.getManifest(), manifest)) return current;

  const permission = await dir.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') return { status: 'needs-permission', permission };
  // Unreadable throws, which reaches the caller as a quiet 'error'.
  if (!(await arcIsThisExtension(dir))) return { status: 'wrong-folder' };
  // The folder on disk, not the running build, is what a write would replace;
  // it may already hold this release, waiting for a reload.
  const onDisk = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
  if (_arcIsUpToDate(onDisk, manifest)) return current;

  const paths = [...files.keys()].sort((a, b) => _arcWriteOrder(a) - _arcWriteOrder(b));
  for (const path of paths) await _arcWriteFile(dir, path, files.get(path));
  return { status: 'updated', files: paths, versionName: manifest.version_name };
}

// Old hashed bundles pile up across releases; once the new build is running,
// drop any under assets/ that it no longer ships.
async function _arcCleanup(keep) {
  const dir = await arcGetExtensionDir();
  if (!dir || (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') return { status: 'skipped' };
  if (!(await arcIsThisExtension(dir).catch(() => false))) return { status: 'wrong-folder' };
  const keepSet = new Set(keep);
  let removed = 0;
  async function walk(handle, prefix) {
    for await (const [name, entry] of handle.entries()) {
      const path = prefix + name;
      if (entry.kind === 'directory') await walk(entry, path + '/');
      else if (!keepSet.has(path)) { await handle.removeEntry(name); removed++; }
    }
  }
  const assets = await dir.getDirectoryHandle('assets').catch(() => null);
  if (assets) await walk(assets, 'assets/');
  return { status: 'cleaned', removed };
}

// arc-setup.html loads this file for _arcApplyUpdate too, but only the
// offscreen document answers the service worker.
if (location.pathname === '/offscreen.html') chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ARC_APPLY_UPDATE') {
    _arcApplyUpdate(msg.url).then(sendResponse, (e) => sendResponse({ status: 'error', error: String(e) }));
    return true;
  }
  if (msg?.type === 'ARC_CLEANUP_UPDATE') {
    _arcCleanup(msg.keep || []).then(sendResponse, (e) => sendResponse({ status: 'error', error: String(e) }));
    return true;
  }
  return false;
});
