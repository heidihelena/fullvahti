/* global Zotero, document, window, Services */
"use strict";

var FullVahtiPrefs = {
	// The LIVE pane document. Zotero loads this script once and keeps the object,
	// but recreates the pane's document on each open — so the script's global
	// `document` goes stale ("can't access dead object"). The pane's onload hands
	// us the live root element; we derive the current document from it every time
	// and never touch the global `document` again.
	_doc: null,

	_useDoc(root) {
		let doc = null;
		try { if (root && root.ownerDocument) doc = root.ownerDocument; }
		catch (e) { /* root was dead too */ }
		if (!doc) { try { doc = document; } catch (e) { doc = null; } }
		this._doc = doc;
		return doc;
	},

	_el(id) {
		try { return this._doc ? this._doc.getElementById(id) : null; }
		catch (e) { return null; }
	},

	// A dependable chrome window for dialogs — never the pane's ambient `window`.
	_win() {
		try { if (Zotero.getMainWindow) { let w = Zotero.getMainWindow(); if (w) return w; } }
		catch (e) { /* fall through */ }
		try { return this._doc && this._doc.defaultView; }
		catch (e) { return null; }
	},

	// Show a message without depending on a (possibly dead) pane window.
	_say(msg) {
		let w = this._win();
		try { if (w && typeof w.alert === "function") { w.alert(msg); return; } }
		catch (e) { /* try next */ }
		try { if (typeof Services !== "undefined") { Services.prompt.alert(w || null, "FullVahti", msg); return; } }
		catch (e) { /* try next */ }
		Zotero.debug("FullVahti (prefs): " + msg);
	},

	// Called from the pane's onload with the live root element. Sets the token
	// display and wires the buttons against the live document.
	onPaneLoad(root) {
		let doc = this._useDoc(root);
		try {
			let tok = Zotero.Prefs.get("extensions.fullvahti.writebackToken", true);
			let box = doc && doc.getElementById("fullvahti-token-display");
			if (box) box.value = tok || "(none yet — click “Generate new token”)";
		}
		catch (e) {
			Zotero.debug("FullVahti prefs onPaneLoad: " + e);
		}
		this._wireButtons();
	},

	// Bind each button from this script's own scope (where FullVahtiPrefs exists),
	// against the live document. Guarded so a stale node can never throw uncaught.
	_wireButtons() {
		try {
			let bind = (id, name) => {
				let el = this._el(id);
				if (!el || el._fvBound) return;
				el._fvBound = true;
				el.addEventListener("command", () => {
					try { this[name](); }
					catch (e) { Zotero.debug("FullVahti prefs button " + name + " failed: " + e); }
				});
			};
			bind("fullvahti-token-generate", "generateToken");
			bind("fullvahti-token-copy", "copyToken");
			bind("fullvahti-test-connection", "testConnection");
			bind("fullvahti-view-audit", "viewAudit");
			bind("fullvahti-openurl-test", "testResolver");
			bind("fullvahti-retract-run", "runRetractionScan");
			bind("fullvahti-citation-run", "runCitationScan");
		}
		catch (e) {
			Zotero.debug("FullVahti _wireButtons: " + e);
		}
	},

	generateToken() {
		try {
			// Zotero.Utilities.randomString isn't reliably present in the prefs-pane
			// scope on Zotero 9; fall back to Web Crypto, which is.
			let token;
			try { token = Zotero.Utilities.randomString(40); }
			catch (e) { token = null; }
			if (!token) {
				const cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
				const bytes = new Uint8Array(40);
				crypto.getRandomValues(bytes);
				token = Array.from(bytes, b => cs[b % cs.length]).join("");
			}
			Zotero.Prefs.set("extensions.fullvahti.writebackToken", token, true);
			let box = this._el("fullvahti-token-display");
			if (box) box.value = token;
			this._say("A new write-back token was generated. Use “Copy” to copy it.");
		}
		catch (e) {
			Zotero.debug("FullVahti generateToken failed: " + e);
			this._say("Token generation failed — see Zotero debug output.");
		}
	},

	// Copy the write-back token without hand-selecting 40 characters.
	copyToken() {
		let tok = "";
		try { tok = Zotero.Prefs.get("extensions.fullvahti.writebackToken", true) || ""; }
		catch (e) { /* fall through */ }
		if (!tok) {
			this._say("No token yet — click “Generate new token” first.");
			return;
		}
		let ok = false;
		try { Zotero.Utilities.Internal.copyTextToClipboard(tok); ok = true; }
		catch (e) { /* fall back to the DOM */ }
		if (!ok) {
			try {
				let box = this._el("fullvahti-token-display");
				if (box && this._doc) { box.focus(); box.select(); ok = this._doc.execCommand("copy"); }
			}
			catch (e) { /* report below */ }
		}
		this._say(ok
			? "Token copied to the clipboard."
			: "Couldn’t copy automatically — select the token and copy it by hand.");
	},

	// Confirm the local endpoint is reachable and report enabled/token state.
	async testConnection() {
		try {
			let xhr = await Zotero.HTTP.request("GET",
				"http://127.0.0.1:23119/fullvahti/ping",
				{ responseType: "json", timeout: 5000, successCodes: false });
			let d = (xhr && xhr.response) || {};
			let tokenSet = !!Zotero.Prefs.get("extensions.fullvahti.writebackToken", true);
			this._say(
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
			this._say(
				"Could not reach FullVahti’s local endpoint.\n\n"
				+ "Check that Zotero’s local server is on (Settings → Advanced → "
				+ "“Allow other applications on this computer to communicate with Zotero”), "
				+ "then try again.\n\nDetail: " + e
			);
		}
	},

	// Open the same audit-log dialog the Tools menu shows.
	viewAudit() {
		if (Zotero.FullVahti && Zotero.FullVahti.showAuditLog) {
			Zotero.FullVahti.showAuditLog(this._win());
		}
		else {
			this._say("FullVahti isn’t fully loaded yet — open a Zotero library window first.");
		}
	},

	// Run the retraction scan over items carrying the trigger tag.
	runRetractionScan() {
		try {
			let win = this._win();
			if (!win || !Zotero.FullVahti || !Zotero.FullVahti.runRetractionForTag) {
				this._say("Open a Zotero library window first, then try again.");
				return;
			}
			Zotero.FullVahti.runRetractionForTag(win);
		}
		catch (e) {
			Zotero.debug("FullVahti runRetractionScan failed: " + e);
			this._say("Couldn’t start the retraction check:\n" + e);
		}
	},

	// Run the citation metadata check over items carrying the trigger tag.
	runCitationScan() {
		try {
			let win = this._win();
			if (!win || !Zotero.FullVahti || !Zotero.FullVahti.runCitationCheckForTag) {
				this._say("Open a Zotero library window first, then try again.");
				return;
			}
			Zotero.FullVahti.runCitationCheckForTag(win);
		}
		catch (e) {
			Zotero.debug("FullVahti runCitationScan failed: " + e);
			this._say("Couldn’t start the citation check:\n" + e);
		}
	},

	// Open a sample OpenURL against the configured resolver to verify it.
	testResolver() {
		let base = "";
		try { base = (Zotero.Prefs.get("extensions.fullvahti.openURLResolver", true) || "").trim(); }
		catch (e) { /* fall through */ }
		if (!base) {
			this._say("Enter your library’s OpenURL resolver address first.");
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
			this._say("Couldn’t open the link. The resolver address may be malformed:\n\n" + url);
		}
	},
};

// Best-effort init at script load. The pane's onload (which carries a LIVE
// document) is the real path; this is wrapped so a stale global `document` at
// eval time can never throw an uncaught "dead object".
try { FullVahtiPrefs.onPaneLoad(); }
catch (e) { Zotero.debug("FullVahti prefs eval-time init skipped: " + e); }
