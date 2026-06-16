/* global Zotero, document */
"use strict";

var FullVahtiPrefs = {
	onPaneLoad() {
		try {
			let tok = Zotero.Prefs.get("extensions.fullvahti.writebackToken", true);
			let box = document.getElementById("fullvahti-token-display");
			if (box) box.value = tok || "(none yet — click “Generate new token”)";
		}
		catch (e) {
			Zotero.debug("FullVahti prefs: " + e);
		}
	},

	generateToken() {
		try {
			// Zotero.Utilities.randomString isn't reliably present in the prefs-pane
			// scope on Zotero 9, so its absence made "Generate" fail silently (no token
			// was ever written). Use Web Crypto, which IS available here, with the
			// Zotero helper as a best-effort first try.
			let token;
			try {
				token = Zotero.Utilities.randomString(40);
			}
			catch (e) {
				token = null;
			}
			if (!token) {
				const cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
				const bytes = new Uint8Array(40);
				crypto.getRandomValues(bytes);
				token = Array.from(bytes, b => cs[b % cs.length]).join("");
			}
			Zotero.Prefs.set("extensions.fullvahti.writebackToken", token, true);
			let box = document.getElementById("fullvahti-token-display");
			if (box) box.value = token;
		}
		catch (e) {
			Zotero.debug("FullVahti generateToken failed: " + e);
			let box = document.getElementById("fullvahti-token-display");
			if (box) box.value = "(token generation failed — see Zotero debug output)";
		}
	},
};

// The pane content is already inserted when registered scripts run,
// but onload on the root vbox does not always fire — initialize directly too.
FullVahtiPrefs.onPaneLoad();
