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
		let token = Zotero.Utilities.randomString(40);
		Zotero.Prefs.set("extensions.fullvahti.writebackToken", token, true);
		let box = document.getElementById("fullvahti-token-display");
		if (box) box.value = token;
	},
};

// The pane content is already inserted when registered scripts run,
// but onload on the root vbox does not always fire — initialize directly too.
FullVahtiPrefs.onPaneLoad();
