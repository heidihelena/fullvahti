"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load, makeItem } = require("./helpers");

// A representative Crossref message for one article.
function crossref(over = {}) {
	return Object.assign({
		title: ["A Study of Things"],
		"container-title": ["Journal of Things"],
		issued: { "date-parts": [[2020, 5]] },
		volume: "12",
		issue: "3",
		page: "45-67",
		ISSN: ["1234-5678"],
		author: [{ family: "Smith", given: "J." }],
	}, over);
}

test("compareCitation flags nothing when fields agree (formatting aside)", () => {
	const { fv } = load();
	const ours = { title: "A study of things", journal: "Journal of Things", year: "2020",
		volume: "12", issue: "3", pages: "45–67", issn: "12345678", firstAuthor: "Smith" };
	const cmp = fv.compareCitation(ours, crossref());
	assert.equal(cmp.missing.length, 0);
	assert.equal(cmp.mismatches.length, 0);
});

test("compareCitation reports missing fields the source has", () => {
	const { fv } = load();
	const ours = { title: "A Study of Things", journal: "", year: "", volume: "",
		issue: "", pages: "", issn: "", firstAuthor: "Smith" };
	const cmp = fv.compareCitation(ours, crossref());
	assert.ok(cmp.missing.includes("journal"));
	assert.ok(cmp.missing.includes("year"));
	assert.ok(cmp.missing.includes("volume"));
	assert.equal(cmp.mismatches.length, 0);
});

test("compareCitation reports a real mismatch with both values", () => {
	const { fv } = load();
	const ours = { title: "A Completely Different Paper", journal: "Journal of Things",
		year: "2019", volume: "12", issue: "3", pages: "45-67", issn: "1234-5678", firstAuthor: "Smith" };
	const cmp = fv.compareCitation(ours, crossref());
	const byField = Object.fromEntries(cmp.mismatches.map(m => [m.field, m]));
	assert.ok(byField.title, "title mismatch expected");
	assert.equal(byField.title.theirs, "A Study of Things");
	assert.ok(byField.year, "year mismatch expected");
	assert.equal(byField.year.ours, "2019");
});

test("compareCitation never flags a field the source lacks", () => {
	const { fv } = load();
	// Crossref has no issue/pages here; ours does — must NOT be a mismatch or missing.
	const msg = crossref({ issue: undefined, page: undefined });
	const ours = { title: "A Study of Things", journal: "Journal of Things", year: "2020",
		volume: "12", issue: "9", pages: "1-2", issn: "1234-5678", firstAuthor: "Smith" };
	const cmp = fv.compareCitation(ours, msg);
	assert.ok(!cmp.missing.includes("issue"));
	assert.ok(!cmp.mismatches.some(m => m.field === "issue"));
	assert.ok(!cmp.mismatches.some(m => m.field === "pages"));
});

test("normalizeStr folds accents and punctuation", () => {
	const { fv } = load();
	assert.equal(fv.normalizeStr("Müller, A."), fv.normalizeStr("Muller A"));
	assert.equal(fv.sameText("The Title: A Subtitle", "The Title"), true);
	assert.equal(fv.sameText("Cats", "Dogs"), false);
});

test("checkCitation returns check when there is no DOI", async () => {
	const { fv } = load();
	const item = makeItem({ title: "No DOI here" }, { key: "K" });
	const res = await fv.checkCitation(item, "me@example.org");
	assert.equal(res.status, "check");
	assert.match(res.reason, /no DOI/);
});

test("checkCitation flags a mismatch end-to-end via Crossref", async () => {
	const { fv } = load({ zotero: { HTTP: { request: async (method, url) => {
		if (url.includes("api.crossref.org")) return { status: 200, response: { message: crossref() } };
		throw new Error("unexpected url " + url);
	} } } });
	const item = makeItem({ title: "A Totally Different Title", DOI: "10.1/x",
		publicationTitle: "Journal of Things", date: "2020", volume: "12", issue: "3", pages: "45-67" },
		{ key: "K" });
	const res = await fv.checkCitation(item, "me@example.org");
	assert.equal(res.status, "mismatch");
	assert.ok(res.mismatches.some(m => m.field === "title"));
});

test("citation report shows mismatch values and missing-field lists", async () => {
	const { fv, notes } = load();
	const rows = [
		{ key: "A", title: "Wrong DOI?", status: "mismatch", reason: "",
			missing: [], mismatches: [{ field: "title", ours: "Mine", theirs: "Theirs" }] },
		{ key: "B", title: "Thin record", status: "incomplete", reason: "", missing: ["journal", "year"], mismatches: [] },
		{ key: "C", title: "Fine", status: "ok", reason: "", missing: [], mismatches: [] },
	];
	await fv.writeCitationReport(rows, { ok: 1, incomplete: 1, mismatch: 1, check: 0 });
	const html = notes[0].note;
	assert.match(html, /Mismatches \(1\)/);
	assert.match(html, /yours .*Mine.* · Crossref .*Theirs/);
	assert.match(html, /Missing fields \(1\)/);
	assert.match(html, /missing: journal, year/);
	assert.ok(notes[0]._tags.includes("fullvahti:report"));
});

test("citation: prefix is allowlisted for writeback", () => {
	const { fv } = load();
	assert.ok(fv.tagAllowed("citation:mismatch"));
});
