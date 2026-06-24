/* global Zotero, Services */
"use strict";

var FullVahti;

function log(msg) {
	Zotero.debug("FullVahti: " + msg);
}

function install() {
	log("Installed");
}

async function startup({ id, version, rootURI }) {
	log("Starting " + version);

	Zotero.PreferencePanes.register({
		pluginID: "fullvahti@vahtian.com",
		src: rootURI + "preferences.xhtml",
		scripts: [rootURI + "preferences.js"],
		label: "FullVahti",
		image: rootURI + "icon.svg",
	});

	Services.scriptloader.loadSubScript(rootURI + "fullvahti.js");
	FullVahti.init({ id, version, rootURI });
	// Expose for the preferences pane (a separate scope) so its buttons can reuse
	// the same tested helpers instead of duplicating logic.
	Zotero.FullVahti = FullVahti;
	FullVahti.addToAllWindows();
	FullVahti.registerEndpoints();
}

function onMainWindowLoad({ window }) {
	FullVahti.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	FullVahti.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down");
	FullVahti.unregisterEndpoints();
	FullVahti.removeFromAllWindows();
	try { delete Zotero.FullVahti; } catch (e) { Zotero.FullVahti = undefined; }
	FullVahti = undefined;
}

function uninstall() {
	log("Uninstalled");
}
