"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

function row(over = {}) {
	return Object.assign({ key: "K", title: "T", doi: "", pmid: "", status: "missing", reason: "", source: "", license: "", oaStatus: "" }, over);
}

test("report escapes HTML in titles", async () => {
	const { fv, notes } = load();
	await fv.writeReportNote([row({ title: "Tags <b> & </b> stuff", status: "missing", doi: "10.1/x" })], { found: 0, missing: 1, check: 0 });
	const html = notes[0].note;
	assert.match(html, /Tags &lt;b&gt; &amp; &lt;\/b&gt; stuff/);
	assert.ok(notes[0]._tags.includes("fullvahti:report"));
});

test("report lists problems and attached items, with counts", async () => {
	const { fv, notes } = load();
	const rows = [
		row({ title: "Got it", status: "found", license: "cc-by" }),
		row({ title: "No copy", status: "missing", doi: "10.2/y" }),
		row({ title: "Odd one", status: "check", reason: "no identifier" }),
	];
	await fv.writeReportNote(rows, { found: 1, missing: 1, check: 1 });
	const html = notes[0].note;
	assert.match(html, /Still to get \(2\)/);   // missing + check, not the found one
	assert.match(html, /No copy/);
	assert.match(html, /Odd one/);
	assert.match(html, /Attached: Got it/);
	assert.match(html, /cc-by/);
});

test("buildOpenURL is empty without a resolver and well-formed with one", () => {
	const { fv } = load();
	assert.equal(fv.buildOpenURL("", { doi: "10.1/x" }), "");
	const url = fv.buildOpenURL("https://lib.example.edu/openurl", {
		title: "A Study", journal: "J of Things", year: "2020",
		doi: "10.1/x", pmid: "12345",
	});
	assert.ok(url.startsWith("https://lib.example.edu/openurl?"));
	assert.match(url, /ctx_ver=Z39.88-2004/);
	assert.match(url, /rft.atitle=A%20Study/);
	assert.match(url, /rft_id=info%3Adoi%2F10.1%2Fx/);
	assert.match(url, /rft_id=info%3Apmid%2F12345/);
	// appends with & when the base already has a query string
	assert.match(fv.buildOpenURL("https://lib.example.edu/openurl?x=1", { doi: "10.1/x" }), /\?x=1&ctx_ver=/);
});

test("report adds a library link only when a resolver is configured", async () => {
	const withResolver = load({ prefs: { "extensions.fullvahti.openURLResolver": "https://lib.example.edu/openurl" } });
	await withResolver.fv.writeReportNote([row({ title: "No copy", status: "missing", doi: "10.2/y", journal: "Nature" })], { found: 0, missing: 1, check: 0 });
	assert.match(withResolver.notes[0].note, /Find in my library/);
	assert.match(withResolver.notes[0].note, /lib\.example\.edu\/openurl/);

	const without = load();
	await without.fv.writeReportNote([row({ title: "No copy", status: "missing", doi: "10.2/y" })], { found: 0, missing: 1, check: 0 });
	assert.doesNotMatch(without.notes[0].note, /Find in my library/);
});

test("duplicates are summarized but kept out of the actionable lists", async () => {
	const { fv, notes } = load();
	const rows = [
		row({ title: "Original", status: "missing", doi: "10.3/z" }),
		row({ title: "Dup", status: "missing", doi: "10.3/z", duplicate: true, reason: "duplicate of an item already processed this run" }),
	];
	await fv.writeReportNote(rows, { found: 0, missing: 1, check: 0 });
	const html = notes[0].note;
	assert.match(html, /1 duplicate item\(s\) were tagged/);
	assert.match(html, /Still to get \(1\)/); // only the original
	// the duplicate row must not add a second list entry
	assert.equal((html.match(/<li>/g) || []).length, 1);
});
