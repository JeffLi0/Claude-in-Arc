#!/usr/bin/env python3
"""Build Claude in Arc from the latest official Claude in Chrome release.

Downloads the current extension from the Chrome Web Store, unpacks it, and
layers the Arc patches on top:

  1. copies the Arc-only scripts in arc/ into assets/
  2. hooks them in through the manifest, the service-worker loader and
     sidepanel.html
  3. applies a handful of small regex edits to the minified bundles

Everything else is Anthropic's build, byte for byte, so new features and
models arrive with each upstream release. The regex edits match on code shape,
not on minified names or file hashes, and the build fails loudly if any of
them stops matching exactly once -- that is the signal an upstream release
needs a look.

Standard library only.

  python3 scripts/build.py                 # latest upstream -> dist/Claude-in-Arc
  python3 scripts/build.py --zip           # ...and dist/Claude-in-Arc-<version>.zip
  python3 scripts/build.py --crx file.crx  # build from a CRX on disk
  python3 scripts/build.py --check         # print the upstream version and exit
"""

import argparse
import datetime
import glob
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile

EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
CRX_URL = (
    "https://clients2.google.com/service/update2/crx?response=redirect"
    "&prodversion=140.0.0.0&acceptformat=crx2,crx3"
    f"&x=id%3D{EXTENSION_ID}%26uc"
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARC_DIR = os.path.join(ROOT, "arc")

# Service-worker modules, in load order around the official bundle. The shim
# has to run first so chrome.sidePanel / chrome.tabGroups exist before the
# official code reads them.
SW_BEFORE = ["arc-sidepanel-shim.js"]
SW_AFTER = [
    "arc-session-tracker.js",
    "arc-bridge-interceptor.js",
    "arc-zoom-handler.js",
    "arc-adapter.js",
    "arc-update-check.js",
    "arc-bridge-name.js",
]

CONTENT_SCRIPTS = [
    {"js": ["assets/claude-panel-injector.js"], "matches": ["<all_urls>"], "run_at": "document_idle"},
    {"js": ["assets/viewport-override.js"], "matches": ["<all_urls>"], "run_at": "document_start", "world": "MAIN"},
    {"js": ["assets/arc-session-border.js"], "matches": ["<all_urls>"], "run_at": "document_idle"},
]

# Hosts the fork's panel has needed beyond upstream's connect-src. Merged in,
# never replacing upstream's list.
EXTRA_CONNECT_SRC = [
    "https://*.anthropic.com",
    "https://*.claude.ai",
    "https://*.claudeusercontent.com",
    # arc-update-check.js finds the latest release, and the offscreen updater
    # downloads it (GitHub redirects release assets to githubusercontent.com).
    "https://api.github.com",
    "https://github.com",
    "https://*.githubusercontent.com",
]

# (name, file glob, pattern, replacement). Each must match exactly once across
# the files the glob selects.
BUNDLE_PATCHES = [
    (
        # Tool calls are confined to Claude's Chrome tab group. Arc has no
        # working tab groups, so no tab ever carries the group id and the
        # check can only reject. The target tab must still exist; that check
        # is earlier and untouched.
        "tab-group check (throw)",
        "assets/mcpPermissions-*.js",
        r"if\((void 0===(\w+)\|\|\w+\.groupId!==\2)\)throw ",
        r"if(/*ARC PATCH: no tab groups in Arc*/!1&&(\1))throw ",
    ),
    (
        "tab-group check (tabs_close)",
        "assets/mcpPermissions-*.js",
        r"if\((\w+\.groupId!==\w+)\)return\{error:`Tab \$\{",
        r"if(/*ARC PATCH: no tab groups in Arc*/!1&&\1)return{error:`Tab ${",
    ),
    (
        # The Cowork panel embeds claude.ai in an iframe and relies on the
        # claude.ai session cookie. Here the panel is itself an iframe inside
        # a web page, so Chromium partitions those cookies and the embed
        # always reports "Sign in to Claude". Keep the classic panel, which
        # signs in with the extension's own OAuth tokens.
        "cowork panel off",
        "assets/mcpPermissions-*.js",
        r"isCoworkExperienceAvailable:\w+&&!\w+\}",
        r"isCoworkExperienceAvailable:/*ARC PATCH: panel is not a real side panel*/!1}",
    ),
    (
        # Onboarding prompts ("Start challenge" on claude.ai/chrome/installed)
        # are broadcast to every extension page, and the first panel to answer
        # gets the text. Hiding the injected panel keeps its iframe alive, so a
        # stale panel in another tab can win the race and the new one stays
        # empty. Tag the message with its tab; the panel patch below filters.
        "populate prompt target (worker)",
        "assets/service-worker.ts-*.js",
        r'(const (\w+)=\w+\.tabId\|\|\w+\.tab\?\.id;.{0,600}?\{type:"POPULATE_INPUT_TEXT",prompt:\w+)\}',
        r"\1,/*ARC PATCH: target this tab's panel*/targetTabId:\2}",
    ),
    (
        # Same check upstream already applies to EXECUTE_TASK.
        "populate prompt target (panel)",
        "assets/sidepanel-*.js",
        # The guard goes before the block: the block declares its own const
        # with the tab id's minified name.
        r'(\{if\("PING_SIDEPANEL"===(\w+)\.type\)return \w+\(\{success:!0,tabId:(\w+)\}\),!0;.*?)(if\("POPULATE_INPUT_TEXT"===\2\.type\)\{)',
        r"""\1/*ARC PATCH: ignore other tabs' prompts*/if("POPULATE_INPUT_TEXT"===\2.type&&\2.targetTabId&&\3&&\3!==\2.targetTabId)return;\4""",
    ),
    (
        # The permission prompt opens in a popup that is easy to miss when Arc
        # is not the focused app; an unanswered prompt reads to the model as a
        # refusal. 110s stays inside the 120s bridge tool timeout.
        "permission prompt timeout",
        "assets/mcpPermissions-*.js",
        r"setTimeout\(\(\)=>\{(\w+)\(\"timed_out\"\)\},\w+\)",
        r'setTimeout(()=>{\1("timed_out")},/*ARC PATCH: was 30s*/11e4)',
    ),
    (
        # The panel is an iframe built on first open, so the React app is
        # rarely listening within upstream's 3.3s retry window and the prompt
        # is dropped. Retries are cheap and stop as soon as the panel answers.
        "side panel ready retries",
        "assets/service-worker.ts-*.js",
        r"(side panel not ready\"\)\):\w+\(\)\}\)\}\)\}catch\(\w+\)\{)(\w+)<5(&&await \w+\(\2\+1\)\})",
        r"\1/*ARC PATCH: was 5*/\2<60\3",
    ),
]


def log(msg):
    print(msg, file=sys.stderr)


def fetch_crx():
    log("Downloading the latest Claude in Chrome from the Chrome Web Store...")
    # python.org builds on macOS ship without CA certificates until the user
    # runs "Install Certificates.command"; curl uses the system store.
    if shutil.which("curl"):
        return subprocess.run(
            ["curl", "-fsSL", "--retry", "3", CRX_URL], check=True, capture_output=True
        ).stdout
    req = urllib.request.Request(CRX_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def crx_to_zip(data):
    if data[:4] != b"Cr24":
        raise SystemExit("Download is not a CRX file")
    version = struct.unpack("<I", data[4:8])[0]
    if version == 3:
        (header_len,) = struct.unpack("<I", data[8:12])
        return data[12 + header_len:]
    if version == 2:
        key_len, sig_len = struct.unpack("<II", data[8:16])
        return data[16 + key_len + sig_len:]
    raise SystemExit(f"Unsupported CRX version {version}")


def extract(zip_bytes, out):
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for name in z.namelist():
            # Never write outside the output folder.
            dest = os.path.realpath(os.path.join(out, name))
            if not dest.startswith(os.path.realpath(out) + os.sep):
                raise SystemExit(f"Refusing unsafe path in CRX: {name}")
        z.extractall(out)
    shutil.rmtree(os.path.join(out, "_metadata"), ignore_errors=True)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def build_id():
    sha = os.environ.get("GITHUB_SHA", "")[:7]
    if not sha:
        try:
            sha = subprocess.run(
                ["git", "rev-parse", "--short=7", "HEAD"],
                cwd=ROOT, check=True, capture_output=True, text=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            pass
    if os.environ.get("GITHUB_SHA"):
        return sha
    # Local builds may carry uncommitted patches, so they always get a new id.
    # ".dev." tells arc-update-check.js to replace this build with a release
    # only once Anthropic has shipped a newer upstream version.
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"dev.{sha or 'nogit'}.{stamp}"


def patch_manifest(out):
    path = os.path.join(out, "manifest.json")
    m = json.loads(read(path))
    upstream_version = m["version"]

    m["name"] = "Claude in Arc"
    m["description"] = "Claude in Chrome, patched to run in Arc Browser"
    # The build id changes whenever the patches do, even on the same upstream
    # version. arc-update-check.js compares it against the copy on disk to
    # tell that the folder was updated under the running extension.
    m["version_name"] = f"{upstream_version}-arc.{build_id()}"
    # Lets arc-update-check.js wait until the user is away before reloading.
    if "idle" not in m.setdefault("permissions", []):
        m["permissions"].append("idle")
    # Without update_url Arc can't replace this build with the store version
    # and drop the patches. The key stays, so the extension ID matches the
    # official one and claude.ai sign-in keeps working.
    m.pop("update_url", None)

    m["content_scripts"] = m.get("content_scripts", []) + CONTENT_SCRIPTS
    # The panel is injected into pages as an iframe, so pages must be able to
    # load it.
    m.setdefault("web_accessible_resources", []).append(
        {"matches": ["<all_urls>"], "resources": ["sidepanel.html", "assets/*", "public/*"]}
    )

    csp = m.get("content_security_policy", {}).get("extension_pages")
    if csp:
        def merge(match):
            sources = match.group(1).split()
            sources += [s for s in EXTRA_CONNECT_SRC if s not in sources]
            return "connect-src " + " ".join(sources) + ";"
        m["content_security_policy"]["extension_pages"] = re.sub(r"connect-src ([^;]*);", merge, csp, count=1)

    write(path, json.dumps(m, indent=3, ensure_ascii=False) + "\n")
    return upstream_version


def patch_service_worker_loader(out):
    path = os.path.join(out, "service-worker-loader.js")
    upstream = read(path).strip()
    lines = [f"import './assets/{f}';" for f in SW_BEFORE]
    lines.append(upstream)
    lines += [f"import './assets/{f}';" for f in SW_AFTER]
    write(path, "\n".join(lines) + "\n")


def patch_sidepanel_html(out):
    path = os.path.join(out, "sidepanel.html")
    html = read(path)
    # theme-init sets light/dark before first paint; it has to precede the
    # module script.
    html, n1 = re.subn(
        r'(\s*)(<script type="module")',
        r'\1<script src="/assets/theme-init.js"></script>'
        r'\1<script src="/assets/arc-activity.js"></script>\1\2',
        html,
        count=1,
    )
    html, n2 = re.subn(
        r"(\s*)</body>",
        r'\1  <script src="/assets/cmd-e-fallback.js"></script>\1</body>',
        html,
        count=1,
    )
    html = re.sub(r"<title>[^<]*</title>", "<title>Claude in Arc</title>", html, count=1)
    if n1 != 1 or n2 != 1:
        raise SystemExit("sidepanel.html no longer has the expected structure")
    write(path, html)


def patch_pairing_html(out):
    # Each Arc profile opens its own "wants to connect" prompt, and Arc can show
    # them together; label each with its profile's tabs.
    path = os.path.join(out, "pairing.html")
    html, n = re.subn(
        r"(\s*)</body>",
        r'\1  <script src="/assets/arc-pairing-profile.js"></script>\1</body>',
        read(path),
        count=1,
    )
    if n != 1:
        raise SystemExit("pairing.html no longer has the expected structure")
    write(path, html)


def patch_offscreen_html(out):
    # The updater writes files from here: it needs a window context, and
    # upstream already keeps this document around.
    path = os.path.join(out, "offscreen.html")
    html, n = re.subn(
        r"(\s*)</body>",
        r'\1  <script src="assets/arc-updater-store.js"></script>'
        r'\1  <script src="assets/arc-updater-offscreen.js"></script>\1</body>',
        read(path),
        count=1,
    )
    if n != 1:
        raise SystemExit("offscreen.html no longer has the expected structure")
    write(path, html)


def apply_bundle_patches(out):
    failures = []
    for name, pattern_glob, pattern, repl in BUNDLE_PATCHES:
        files = glob.glob(os.path.join(out, pattern_glob))
        hits = [(f, len(re.findall(pattern, read(f)))) for f in files]
        total = sum(n for _, n in hits)
        if total != 1:
            failures.append(f"  {name}: expected 1 match in {pattern_glob}, found {total}")
            continue
        f = next(f for f, n in hits if n)
        write(f, re.sub(pattern, repl, read(f), count=1))
        log(f"  patched {name} ({os.path.basename(f)})")
    if failures:
        raise SystemExit(
            "Upstream changed and these patches no longer apply:\n" + "\n".join(failures)
        )


def verify(out):
    m = json.loads(read(os.path.join(out, "manifest.json")))
    missing = [
        js
        for cs in m["content_scripts"]
        for js in cs["js"]
        if not os.path.isfile(os.path.join(out, js))
    ]
    for line in read(os.path.join(out, "service-worker-loader.js")).splitlines():
        mod = re.match(r"import '\./(.+)';", line)
        if mod and not os.path.isfile(os.path.join(out, mod.group(1))):
            missing.append(mod.group(1))
    if missing:
        raise SystemExit("Build references missing files: " + ", ".join(missing))


def build(crx_bytes, out):
    # Build beside the folder and swap it in at the end. Arc may have `out`
    # loaded in several profiles, and each reloads itself when the build on
    # disk changes; it should never catch a half-written folder.
    staging = out + ".building"
    version = build_into(crx_bytes, staging)
    previous = out + ".previous"
    shutil.rmtree(previous, ignore_errors=True)
    if os.path.isdir(out):
        os.rename(out, previous)
    os.rename(staging, out)
    shutil.rmtree(previous, ignore_errors=True)
    return version


def build_into(crx_bytes, out):
    extract(crx_to_zip(crx_bytes), out)
    version = patch_manifest(out)
    log(f"Upstream version {version}")
    for f in sorted(os.listdir(ARC_DIR)):
        if f.endswith(".js"):
            shutil.copy2(os.path.join(ARC_DIR, f), os.path.join(out, "assets", f))
        elif f.endswith(".html"):
            html = read(os.path.join(ARC_DIR, f))
            # Upstream's font files are content-hashed; point at this release's.
            fonts = glob.glob(os.path.join(out, "assets", "AnthropicSans-Roman-Variable-*.woff2"))
            if fonts:
                html = html.replace("__ANTHROPIC_SANS__", os.path.basename(fonts[0]))
            write(os.path.join(out, f), html)
    patch_service_worker_loader(out)
    patch_sidepanel_html(out)
    patch_offscreen_html(out)
    patch_pairing_html(out)
    apply_bundle_patches(out)
    verify(out)
    return version


def make_zip(src, zip_path):
    folder = os.path.basename(src)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for d, _, files in os.walk(src):
            for f in files:
                if f == ".DS_Store":
                    continue
                full = os.path.join(d, f)
                z.write(full, os.path.join(folder, os.path.relpath(full, src)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crx", help="build from this CRX instead of downloading")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "Claude-in-Arc"))
    ap.add_argument("--zip", action="store_true", help="also write a release ZIP next to --out")
    ap.add_argument("--check", action="store_true", help="print the upstream version and exit")
    args = ap.parse_args()

    if args.crx:
        with open(args.crx, "rb") as f:
            crx = f.read()
    else:
        crx = fetch_crx()

    if args.check:
        with zipfile.ZipFile(io.BytesIO(crx_to_zip(crx))) as z:
            print(json.loads(z.read("manifest.json"))["version"])
        return

    out = os.path.abspath(args.out)
    version = build(crx, out)
    log(f"Built {out}")
    if args.zip:
        zip_path = os.path.join(os.path.dirname(out), f"Claude-in-Arc-{version}.zip")
        make_zip(out, zip_path)
        log(f"Wrote {zip_path}")
    print(version)


if __name__ == "__main__":
    main()
