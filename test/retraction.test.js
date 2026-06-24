"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

test("pmidFromESearch returns the first id or null", () => {
	const { fv } = load();
	assert.equal(fv.pmidFromESearch({ esearchresult: { idlist: ["999", "1000"] } }), "999");
	assert.equal(fv.pmidFromESearch({ esearchresult: { idlist: [] } }), null);
	assert.equal(fv.pmidFromESearch({}), null);
	assert.equal(fv.pmidFromESearch(null), null);
});

test("retractionFromSummary detects the Retracted Publication type", () => {
	const { fv } = load();
	const retracted = { result: { "12345": { pubtype: ["Journal Article", "Retracted Publication"] } } };
	const clean = { result: { "12345": { pubtype: ["Journal Article", "Review"] } } };
	// the retraction *notice* type must NOT be read as the paper being retracted
	const notice = { result: { "12345": { pubtype: ["Retraction of Publication"] } } };
	assert.equal(fv.retractionFromSummary(retracted, "12345"), "retracted");
	assert.equal(fv.retractionFromSummary(clean, "12345"), "none");
	assert.equal(fv.retractionFromSummary(notice, "12345"), "none");
	// absent record -> null (caller maps to "check")
	assert.equal(fv.retractionFromSummary({ result: {} }, "12345"), null);
});

test("checkRetraction returns check when there is no identifier", async () => {
	const { fv } = load();
	const res = await fv.checkRetraction(null, null, "me@example.org");
	assert.equal(res.status, "check");
	assert.match(res.reason, /no DOI or PMID/);
});

test("retraction report highlights retracted items and lists unchecked", async () => {
	const { fv, notes } = load();
	const rows = [
		{ key: "A", title: "Bad paper", doi: "", pmid: "111", status: "retracted", reason: "", source: "" },
		{ key: "B", title: "Good paper", doi: "10.1/x", pmid: "", status: "none", reason: "", source: "" },
		{ key: "C", title: "Mystery", doi: "", pmid: "", status: "check", reason: "no DOI or PMID on the item to check", source: "" },
	];
	await fv.writeRetractionReport(rows, { retracted: 1, none: 1, check: 1 });
	const html = notes[0].note;
	assert.match(html, /Retracted \(1\)/);
	assert.match(html, /Bad paper/);
	assert.match(html, /PMID 111/);
	assert.match(html, /Couldn.t check \(1\)/);
	assert.match(html, /Mystery/);
	// the clean item is not called out in either actionable list
	assert.doesNotMatch(html, /Good paper/);
	assert.ok(notes[0]._tags.includes("fullvahti:report"));
});

test("retraction: prefix is allowlisted for writeback", () => {
	const { fv } = load();
	assert.ok(fv.tagAllowed("retraction:retracted"));
});
