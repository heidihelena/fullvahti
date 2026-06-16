"use strict";

// Load fullvahti.js (which is written for Zotero, not Node) into a sandbox with
// just enough mocked globals to exercise its logic. No build step, no deps —
// the plugin is plain JS and so are its tests.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "fullvahti.js"), "utf8");

function load(opts = {}) {
	const prefStore = Object.assign({}, opts.prefs);
	const itemsById = opts.itemsById || {};     // attachment id -> { attachmentContentType }
	const itemsByKey = opts.itemsByKey || {};   // item key -> mock item (for writeback)
	const notes = [];                            // captures Zotero.Item("note") instances

	const sandbox = {
		console,
		setTimeout,
		Services: { prompt: { confirm: () => true, prompt: () => true } },
		IOUtils: { write: async () => {}, remove: async () => {} },
		PathUtils: { join: (...a) => a.join("/") },
		Zotero: {
			debug: () => {},
			Promise: { delay: () => Promise.resolve() },
			Prefs: {
				get: (k) => prefStore[k],
				set: (k, v) => { prefStore[k] = v; },
			},
			Libraries: { userLibraryID: 1 },
			Items: {
				get: (id) => itemsById[id] || null,
				getByLibraryAndKey: (_lib, key) => itemsByKey[key] || null,
				getAsync: async (ids) => ids,
			},
			HTTP: { request: async () => { throw new Error("network disabled in tests"); } },
			Server: { Endpoints: {} },
			Utilities: { randomString: (n) => "x".repeat(n) },
			Item: function () {
				const o = {
					_tags: [],
					setNote(h) { o.note = h; },
					addTag(t) { o._tags.push(t); },
					saveTx: async () => {},
				};
				notes.push(o);
				return o;
			},
			Attachments: { importFromFile: async () => ({ setField() {}, saveTx: async () => {} }) },
			getTempDirectory: () => ({ path: "/tmp" }),
			File: { pathToFile: (p) => p },
			ProgressWindow: function () {
				this.changeHeadline = () => {};
				this.show = () => {};
				this.startCloseTimer = () => {};
				this.ItemProgress = function () {
					this.setText = () => {};
					this.setProgress = () => {};
				};
			},
		},
	};
	Object.assign(sandbox.Zotero, opts.zotero || {});

	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return { fv: sandbox.FullVahti, sandbox, prefStore, notes };
}

// Build a mock Zotero item. `fields` maps field name -> value; list a field in
// `invalidFields` to make getField throw for it (as Zotero does for fields that
// don't apply to the item type).
function makeItem(fields = {}, opts = {}) {
	const invalid = new Set(opts.invalidFields || []);
	return {
		key: opts.key || "KEY00000",
		id: opts.id || 1,
		_tags: new Set(opts.tags || []),
		getField(name) {
			if (invalid.has(name)) throw new Error("invalid field for type: " + name);
			return name in fields ? fields[name] : "";
		},
		isRegularItem: () => opts.regular !== false,
		isTopLevelItem: () => opts.topLevel !== false,
		getAttachments: () => opts.attachments || [],
		addTag(t) { this._tags.add(t); },
		removeTag(t) { this._tags.delete(t); },
		saveTx: async () => {},
	};
}

// A 20 KB buffer that begins with the %PDF- magic — passes sniffPDFBytes.
function pdfBytes(size = 20000) {
	const a = new Uint8Array(size);
	a.set([0x25, 0x50, 0x44, 0x46, 0x2D], 0); // "%PDF-"
	return a;
}

module.exports = { load, makeItem, pdfBytes };
