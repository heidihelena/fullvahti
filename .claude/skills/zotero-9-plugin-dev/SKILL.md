---
name: zotero-9-plugin-dev
description: >-
  How to build, debug, and release a bootstrapped Zotero 7/8/9 plugin (the
  FullVahti way). Use when adding features, fixing a preference pane, registering
  menus or local-server endpoints, writing tests, or cutting a release in this
  repo — and especially when a Settings-pane control "does nothing" or the
  console shows "can't access dead object" on Zotero 8/9.
---

# Building Zotero 7/8/9 plugins (bootstrapped, no build step)

FullVahti **is** the repository — plain JS, zipped into an `.xpi`. No bundler, no
TypeScript. Keep it that way.

## Files / layout
- `manifest.json` — id, version, `strict_min_version`/`strict_max_version` (7.0 → 9.*).
- `bootstrap.js` — lifecycle: `install / startup / onMainWindowLoad /
  onMainWindowUnload / shutdown / uninstall`.
- `fullvahti.js` — the plugin object, loaded via
  `Services.scriptloader.loadSubScript(rootURI + "fullvahti.js")` into the
  **bootstrap scope** (persistent for the plugin's lifetime).
- `preferences.xhtml` + `preferences.js` — the Settings pane (XUL root, `html:`
  prefix for HTML).
- `prefs.js` — default pref values via `pref("extensions.fullvahti.x", …)`.
- `test/*.test.js` — `node --test`, no deps (see Testing).

## Lifecycle essentials
- In `startup`, register the prefs pane, `loadSubScript` the main file, init it,
  add menus to all windows, register endpoints.
- **Expose the plugin object on the `Zotero` singleton**: `Zotero.FullVahti =
  FullVahti`. This is the only reliable way other scopes (notably the prefs pane)
  can reach it — `Zotero` never dies. Delete it in `shutdown`.
- Menus: `doc.createXULElement("menuitem")`, set a unique `id`, `addEventListener
  ("command", …)`, append to `zotero-itemmenu` / `menu_ToolsPopup`. Track ids and
  remove them in `onMainWindowUnload`/`shutdown` (and re-add in `onMainWindowLoad`).

## Preference panes — the Zotero 8/9 trap (read this)
On **Zotero 8/9 a preference pane runs in its own private global scope, and its
document is rebuilt every time the pane opens.** Therefore:

- **Any reference the pane script keeps goes dead** — the cached `document`, an
  element, even the pane-script object itself. Touching it throws
  `TypeError: can't access dead object`. Symptoms: blank fields, buttons that do
  nothing, dead-object errors in the Error Console.
- A bare `window` / `window.alert` in the pane is also unreliable.

**The pattern that works:** keep **zero state in the pane script**. Put all logic
on the persistent object (`Zotero.FullVahti`), and make `preferences.js` a
stateless shim that hands the **live** root element to it on each open:

```js
// preferences.js
function fullvahtiPrefsInit(root) {
  try { if (Zotero.FullVahti?.prefsInit) Zotero.FullVahti.prefsInit(root); }
  catch (e) { Zotero.debug("FullVahti prefs shim: " + e); }
}
try { window.fullvahtiPrefsInit = fullvahtiPrefsInit; } catch (e) {}
```
```xml
<!-- preferences.xhtml root -->
<vbox ... onload="fullvahtiPrefsInit(this)">
```
```js
// fullvahti.js — runs in the persistent scope
prefsInit(root) {
  const doc = root && root.ownerDocument;       // LIVE document, never cached
  if (!doc) return;
  const box = doc.getElementById("…"); if (box) box.value = this.getPref("…") || "";
  const bind = (id, fn) => {
    const el = doc.getElementById(id);
    if (el && !el._fvBound) { el._fvBound = true; el.addEventListener("command", fn); }
  };
  bind("my-button", () => this.doThing());
}
```

Rules of thumb for panes:
- Resolve elements from `root.ownerDocument` every `onload`; never store a `document`.
- Bind buttons with `addEventListener("command", …)` (not inline `oncommand`,
  which resolves unreliably in the private scope). Guard with an `_fvBound` flag.
- Show dialogs via `Zotero.getMainWindow()` (`.alert`, or `Services.prompt`), not
  the pane `window`.
- `Zotero.Utilities.randomString` is **not reliably present in the pane scope** —
  generate tokens in the persistent scope, or fall back to `window.crypto
  .getRandomValues`.
- Native `<checkbox preference="…">` / `<html:input preference="…">` bindings work
  without any script.

## Local server endpoints (the writeback door)
`Zotero.Server.Endpoints["/fullvahti/x"] = Ctor` where `Ctor.prototype` has
`supportedMethods`, optional `supportedDataTypes`, and `init`.
- **`init` MUST be async on Zotero 9** — a synchronous `init` that returns an
  array never responds (the request hangs forever). Return
  `[code, "application/json", JSON.stringify(body)]`.
- GET query params arrive as `requestData.query`; POST JSON as `requestData.data`.
- Server is `127.0.0.1:23119`; the user must enable Settings → Advanced → "Allow
  other applications…".

## Releasing
- CI (`.github/workflows/release.yml`) builds the `.xpi` and publishes when a
  `v*` tag is pushed, **or** via `workflow_dispatch` on `main`.
- The tag must equal `manifest.json` version; releases are **immutable** (bump the
  version to ship again).
- If git tag pushes are blocked, trigger the release with **`workflow_dispatch`
  on `main`** — it reads the version from `manifest.json` and creates the tag.
- **`updates.json` must point to the new `.xpi`** (`update_link` +
  `version`) or installed users never get the auto-update. It's read live from
  the `main` branch. It is NOT bundled in the `.xpi`.

## Testing (no build, no deps)
`test/helpers.js` loads `fullvahti.js` into a `vm` sandbox with mocked `Zotero`.
- Keep core logic in **pure, side-effect-free functions** so they're testable
  offline (e.g. `sniffPDFBytes`, `buildOpenURL`, `retractionFromSummary`,
  `compareCitation`).
- **Cross-realm gotcha:** objects/arrays created inside the `vm` sandbox have a
  different prototype, so `assert.deepEqual(sandboxArray, [])` fails with "same
  structure but not reference-equal". Assert fields/`.length` individually, or
  spread into a fresh array first (`[...sandboxArr]`).

## Debugging on a user's machine
- **Help → Debug Output Logging** (or **Tools/Help → Developer → Error Console**).
- For a non-working pane, the **blank-field canary** is faster than the console:
  if a field the init should populate is blank, the init isn't running against a
  live document.
