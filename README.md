# Claude in Arc

**Anthropic's Claude for Chrome extension, patched to actually work in [Arc Browser](https://arc.net).**


> A fork of **[chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc)**, which did the original work of getting the panel to render inside Arc. This fork repairs Claude's page-interaction tools, fixes sign-in, and adds a session border. See [Credits](#credits).

---

## Installation

1. Download **`Claude-in-Arc-v0.3.zip`** from [Releases](https://github.com/JeffLi0/Claude-in-Arc/releases) and unzip it
2. Open `arc://extensions` and turn on **Developer mode**
3. Click **Load unpacked** and choose the unzipped folder

Press **⌘E** or click the toolbar icon to open Claude.

The build deliberately ships without an `update_url`, so Arc can't auto-update over it and undo the patches. To upgrade, download the new ZIP and load it the same way. To remove it, click **Remove Extension** in `arc://extensions`.

> After reloading the extension, reload any tabs you already had open. Chromium doesn't re-inject content scripts into existing tabs, so the panel won't open on them until you do.

---

## What was broken, and how it's fixed

Arc doesn't implement three of the extension APIs Claude is built on, and it hosts the panel differently than the extension assumes.

| What's missing | What broke | Fix |
| --- | --- | --- |
| `chrome.sidePanel` | The panel never opened | Renders as an injected iframe beside the page |
| `chrome.debugger` | Every click, keystroke and script hung until it timed out | Tool calls are intercepted and re-run on `chrome.scripting`, which Arc supports |
| `chrome.tabGroups` | Tool calls were rejected as *"not in Claude's tab group"* | Tab confinement can't exist in Arc, so it's switched off |
| A real side panel | Sign-in reported *"Can't reach the Claude extension"* despite valid tokens | Defaults back to the classic panel, which doesn't need one |

The `chrome.debugger` gap is the one that matters. The official extension drives every page interaction through the Chrome Debugger Protocol, and in Arc the `attach` call never settles — no error, no result, just a timeout. [`arc-bridge-interceptor.js`](1.0.91_1/assets/arc-bridge-interceptor.js) catches those calls as they arrive over the bridge WebSocket and reimplements them on `chrome.scripting.executeScript`: clicks and keystrokes as synthesized DOM events, `read_page` by injecting Anthropic's own accessibility-tree builder, `zoom` by cropping the screenshot in the service worker with `OffscreenCanvas`.

Screenshots are resized to match the CSS viewport before they're sent, so a coordinate read off the image is a coordinate on the page — no conversion, and none of the drift that comes with one.

---

## Session border

Arc has no tab groups, so there was no way to see which tabs Claude was working across. Tabs in the current session get a thin orange band drawn inside them ([`arc-session-border.js`](1.0.91_1/assets/arc-session-border.js)), tracked in the service worker and stored in `chrome.storage.session` so it survives the worker restarting. Tabs Claude merely touched expire after 10 minutes; the tab with the panel open stays marked.

---

## Credits

- **[Anthropic](https://claude.ai)** — Claude for Chrome, the extension all of this patches.
- **[chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc)** — the upstream project, which established the panel-injection approach this fork builds on.
- This fork adds the debugger-free interaction tools, the session border, and the sign-in and tool-routing fixes above.
