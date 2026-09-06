# Claude in Arc

Anthropic's official **Claude for Chrome** extension, patched to run natively inside **Arc Browser** — with the browser APIs Arc doesn't implement replaced by Arc-compatible equivalents.

Arc is Chromium-based, but it omits several extension APIs the official Claude extension is built on. The result is an extension that installs cleanly and then quietly half-works: the side panel never opens, and Claude's browser tools hang instead of doing anything. This project fixes that.

**Current release: v0.3**, built on Claude for Chrome `1.0.91`.

> **This is a fork of [chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc)**, which did the original work of getting the extension's side panel rendering inside Arc. This fork adds multi-tab session visibility, repairs Claude's page-interaction tools, and rebases the patch set onto Anthropic's current release. See [Credits](#credits).

---

## The problem

Arc is Chromium-based, but it doesn't implement three of the extension APIs Claude for Chrome is built on — and a fourth assumption breaks simply because of how the panel has to be hosted here:

| What's missing | What breaks |
| --- | --- |
| `chrome.sidePanel` | The Claude panel never opens |
| `chrome.tabGroups` | Claude's multi-tab session tracking never resolves, so there's no way to see which tabs a task is touching |
| `chrome.debugger` | Clicking, typing, scrolling and JavaScript execution hang until the request times out |
| A real side panel | The Cowork panel refuses to authenticate, reporting *"Can't reach the Claude extension"* despite a valid session |

The `chrome.debugger` case is the nastiest, because it doesn't fail — it *stalls*. The official extension drives every page interaction through the Chrome Debugger Protocol, and in Arc the `attach` call never settles. No error is raised and no result is ever returned, so the only symptom is a timeout several seconds later: *"the tool did not respond in time."*

The last row is subtler still. Since Arc has no side panel, this fork renders `sidepanel.html` inside a tab. The Cowork experience embeds claude.ai in a child iframe, and the service worker only answers that page's `get_sidepanel_host_info` request when it sees `sender.tab === undefined` — its test for "am I hosted in a real side panel?" A tab-hosted panel can never satisfy it, so sign-in appears to fail even though the OAuth exchange succeeded and the tokens were stored correctly.

---

## Installation

Download **`Claude-in-Arc-v0.3.zip`** from [Releases](https://github.com/JeffLi0/Claude-in-Arc/releases) and unzip it. Then in Arc:

1. Go to `arc://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the unzipped `1.0.91_1` folder

The patched build deliberately drops the `update_url` from its manifest, so Arc won't silently auto-update over it and undo the patches. To move to a newer release, download the new ZIP and load it the same way.

### Uninstallation

Go to `arc://extensions` and click **Remove Extension**.

### Building the ZIP yourself

```bash
./build-release.sh
```

Packages `1.0.91_1/` into `Claude-in-Arc-v0.3.zip`, excluding CRX install metadata and `.DS_Store`. The version in the filename is read from the manifest's `version_name`.

---

## What this fork adds

### Page interaction actually works

`assets/arc-bridge-interceptor.js` intercepts Claude's tool calls as they arrive over the bridge WebSocket and re-implements them on `chrome.scripting.executeScript`, which Arc does support.

- **`javascript_tool`** — evaluates in the page's `MAIN` world, falling back to the `ISOLATED` world (same DOM, different CSP) when a page blocks `eval`. Supports top-level `await` by compiling the snippet into an async function body and rewriting the trailing expression into a `return`, so the last expression still comes back as the result. Output is depth-limited, safe against circular references, and redacts credential-shaped keys and values.
- **`computer`** — `left_click`, `right_click`, `double_click`, `triple_click`, `hover`, `type`, `key`, `scroll`, `left_click_drag` and `wait` are synthesized as real DOM events. Typing goes through the prototype `value` setter so React and similar frameworks register the change. `screenshot` records the captured image's dimensions against the CSS viewport, so click coordinates read off a retina screenshot are scaled correctly instead of landing at double their intended position.

Anything still unsupported now returns an immediate, explicit error rather than hanging — `zoom`, and `scroll_to` (which needs the `read_page` element-reference registry this interceptor doesn't track).

### Session border

Because `chrome.tabGroups` never resolves in Arc, there was no way to tell which tabs Claude was working across. This fork adds a parallel, Arc-only tracker:

- **`assets/arc-session-border.js`** — draws an orange band (`#d97757`, Claude's brand color) inside any tab that's part of the current session. The band is square against the viewport edge, since Arc clips and rounds the web content's outer corners itself, and rounded on its inner edge to sit correctly inside that curve.
- **`assets/arc-session-tracker.js`** — service-worker-side state, backed by `chrome.storage.session` so it survives the MV3 worker being killed and restarted. A tab joins the session when its panel is open, or when a tool call touches it; touched-but-not-open tabs expire after 10 minutes.

Wired into `claude-panel-injector.js` (panel open/close), `arc-bridge-interceptor.js` (bridge tool calls) and `arc-adapter.js` (tab commands).

**Known limitation:** tool calls arriving over the native-messaging transport (the local Claude Desktop app) bypass the interceptor and go straight to the official executor, so a *new* tab opened mid-task through that path won't be bordered. The anchor tab — wherever the panel is open — is always bordered regardless of transport.

### Sign-in, panel and worker fixes

- **Classic panel by default.** 1.0.91 defaults `preferCoworkExperience` to on, and Cowork can't authenticate in a tab-hosted panel (see [The problem](#the-problem)). The worker now defaults it off, leaving an explicit user choice untouched.
- **Panel crash on open.** `claude-panel-injector.js` tracked the fixed/sticky elements it repositions in a `WeakMap`, then called `.entries()` and `.clear()` on it — both `Map`-only methods. `showPanel` threw partway through every open, which surfaced as the panel half-mounting during sign-in.
- **Service-worker API corruption.** `arc-sidepanel-shim.js` permanently replaced `chrome.tabs.query`, `chrome.tabs.get` and `chrome.storage.local.get` with debug wrappers that dropped every argument after the first, so callback-style calls never got their callback. They're now gated behind the shim's debug flag and forward all arguments.

---

## Rebased on Claude for Chrome 1.0.91

The patch set was previously built on `1.0.66`. It now targets Anthropic's `1.0.91` release, which adds a substantial amount:

- **Claude Cowork in the side panel** — an opt-in replacement for the classic chat that embeds the claude.ai Cowork interface, extending Claude from browser tabs to working across your folders.
- **Plan mode and autonomy controls** — Claude can propose a plan and follow it, or run without pausing for approval.
- **Memories** — Claude creates, reads and edits persistent memories across sessions.
- **Artifacts in the panel** — artifact view, per-artifact consent for shared-data access, and org-level controls.
- **Per-site permissions** — explicit *can use* / *asking to use* / *not allowed on* states per host, a site-permission manager, and enterprise policy blocking.
- **Scheduled tasks** with completion notifications, **saved prompts / shortcuts**, and **skills**.
- **Richer action reporting** — batch progress, and per-action status for every tool.
- Mermaid diagrams, code execution and file creation, file previews, conflicting-extension detection, and localization expanded from 3 to 11 locales.

### What that meant for the port

The **tool surface is unchanged** between `1.0.66` and `1.0.91` — the same 22 MCP tools, and `computer` exposes the same action set. `javascript_tool` still routes through `chrome.debugger` → `Runtime.evaluate`, so every fix above remains necessary and applies unmodified.

The APIs the new build actually calls were audited against the shims: `chrome.sidePanel.{open,setOptions,setPanelBehavior}`, `chrome.tabGroups.{Color,TAB_GROUP_ID_NONE,get,query,update}` and `chrome.tabs.{group,ungroup}` are all already covered, so the polyfills carried over unchanged.

What *did* need work was the new Cowork panel, which is the one genuinely new Arc incompatibility in this release — it assumes a side panel that isn't hosted in a tab. Since 1.0.91 turns it on by default, the fork now opts back into the classic panel.

---

## Inherited from upstream

- **View Mode** — switch the panel between Squeeze (default) and Overlay (iFrame) injection.
- **Claude Desktop integration** over native messaging.
- The `chrome.sidePanel` polyfill (`assets/arc-sidepanel-shim.js`) that makes the panel render at all.

---

## Credits

- **Anthropic** — the original Claude for Chrome extension that all of this patches.
- **[chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc)** — the upstream project, which established the side-panel injection approach and the Arc patching toolkit this fork builds on.
- This fork adds the session tracker/border, the debugger-free interaction tools, and the 1.0.91 rebase described above.
