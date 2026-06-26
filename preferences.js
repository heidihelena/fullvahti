/* global Zotero, window */
"use strict";

// On Zotero 8/9 the preference pane runs in its own private scope and its
// document is rebuilt on each open, so any reference cached in this script dies
// ("can't access dead object"). So this file keeps ZERO state and does ZERO DOM
// work: it just hands the pane's LIVE root element to the persistent plugin
// object (Zotero.FullVahti, which lives in the stable bootstrap scope). That
// object reads/writes the token field and wires the buttons against the live
// document each time the pane opens.
function fullvahtiPrefsInit(root) {
	try {
		if (Zotero.FullVahti && Zotero.FullVahti.prefsInit) {
			Zotero.FullVahti.prefsInit(root);
		}
		else {
			Zotero.debug("FullVahti prefs: plugin not loaded yet");
		}
	}
	catch (e) {
		Zotero.debug("FullVahti prefs shim: " + e);
	}
}

// Expose to the pane window so the inline onload handler can find it.
try { window.fullvahtiPrefsInit = fullvahtiPrefsInit; } catch (e) { /* ignore */ }
