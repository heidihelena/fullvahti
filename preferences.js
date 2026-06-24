/* global Zotero, document, window */
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

	// Copy the write-back token without hand-selecting 40 characters.
	copyToken() {
		let tok = "";
		try { tok = Zotero.Prefs.get("extensions.fullvahti.writebackToken", true) || ""; }
		catch (e) { /* fall through */ }
		if (!tok) {
			window.alert("No token yet — click “Generate new token” first.");
			return;
		}
		let box = document.getElementById("fullvahti-token-display");
		try {
			if (box) { box.focus(); box.select(); }
			document.execCommand("copy");
			window.alert("Token copied to the clipboard.");
		}
		catch (e) {
			try {
				Zotero.Utilities.Internal.copyTextToClipboard(tok);
				window.alert("Token copied to the clipboard.");
			}
			catch (e2) {
				Zotero.debug("FullVahti copyToken failed: " + e2);
				window.alert("Couldn’t copy automatically — select the token and copy it by hand.");
			}
		}
	},

	// Confirm the local endpoint is reachable and report enabled/token state, so
	// setup can be verified before CiteVahti relies on it.
	async testConnection() {
		try {
			let xhr = await Zotero.HTTP.request("GET",
				"http://127.0.0.1:23119/fullvahti/ping",
				{ responseType: "json", timeout: 5000, successCodes: false });
			let d = (xhr && xhr.response) || {};
			let tokenSet = !!Zotero.Prefs.get("extensions.fullvahti.writebackToken", true);
			window.alert(
				"FullVahti’s local endpoint is reachable.\n\n"
				+ "Write-back enabled: " + (d.writeback ? "yes" : "no — tick the box above") + "\n"
				+ "Token set: " + (tokenSet ? "yes" : "no — click “Generate new token”") + "\n\n"
				+ (d.writeback && tokenSet
					? "Ready: give the token to CiteVahti."
					: "Finish the two steps above, then CiteVahti can connect.")
			);
		}
		catch (e) {
			Zotero.debug("FullVahti testConnection failed: " + e);
			window.alert(
				"Could not reach FullVahti’s local endpoint.\n\n"
				+ "Check that Zotero’s local server is on (Settings → Advanced → "
				+ "“Allow other applications on this computer to communicate with Zotero”), "
				+ "then try again.\n\nDetail: " + e
			);
		}
	},

	// Open the same audit-log dialog the Tools menu shows, reusing the plugin's
	// tested helpers (exposed on Zotero.FullVahti by bootstrap).
	viewAudit() {
		if (Zotero.FullVahti && Zotero.FullVahti.showAuditLog) {
			Zotero.FullVahti.showAuditLog(window);
		}
		else {
			window.alert("FullVahti isn’t fully loaded yet — open a Zotero library window first.");
		}
	},

	// Run the retraction scan over items carrying the trigger tag, using the main
	// Zotero window for the progress UI (the prefs pane has no library selection).
	runRetractionScan() {
		try {
			let win = Zotero.getMainWindow && Zotero.getMainWindow();
			if (!win || !Zotero.FullVahti || !Zotero.FullVahti.runRetractionForTag) {
				window.alert("Open a Zotero library window first, then try again.");
				return;
			}
			Zotero.FullVahti.runRetractionForTag(win);
		}
		catch (e) {
			Zotero.debug("FullVahti runRetractionScan failed: " + e);
			window.alert("Couldn’t start the retraction check:\n" + e);
		}
	},

	// Run the citation metadata check over items carrying the trigger tag.
	runCitationScan() {
		try {
			let win = Zotero.getMainWindow && Zotero.getMainWindow();
			if (!win || !Zotero.FullVahti || !Zotero.FullVahti.runCitationCheckForTag) {
				window.alert("Open a Zotero library window first, then try again.");
				return;
			}
			Zotero.FullVahti.runCitationCheckForTag(win);
		}
		catch (e) {
			Zotero.debug("FullVahti runCitationScan failed: " + e);
			window.alert("Couldn’t start the citation check:\n" + e);
		}
	},

	// Open a sample OpenURL against the configured resolver so the URL can be
	// verified before a real run.
	testResolver() {
		let base = "";
		try { base = (Zotero.Prefs.get("extensions.fullvahti.openURLResolver", true) || "").trim(); }
		catch (e) { /* fall through */ }
		if (!base) {
			window.alert("Enter your library’s OpenURL resolver address first.");
			return;
		}
		let sample = { title: "An example article", journal: "Journal of Examples",
			year: "2020", volume: "12", issue: "3", pages: "45-67", doi: "10.1038/nphys1170" };
		let url = (Zotero.FullVahti && Zotero.FullVahti.buildOpenURL)
			? Zotero.FullVahti.buildOpenURL(base, sample)
			: base;
		try {
			Zotero.launchURL(url);
		}
		catch (e) {
			Zotero.debug("FullVahti testResolver failed: " + e);
			window.alert("Couldn’t open the link. The resolver address may be malformed:\n\n" + url);
		}
	},
};

// The pane content is already inserted when registered scripts run,
// but onload on the root vbox does not always fire — initialize directly too.
FullVahtiPrefs.onPaneLoad();
