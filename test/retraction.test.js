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

test("retractionFromCrossref detects retraction on notice and on article", () => {
	const { fv } = load();
	// notice record: update-to points to the retracted article
	const notice = fv.retractionFromCrossref({ "update-to": [{ DOI: "10.1/x", type: "retraction", source: "retraction-watch" }] });
	assert.equal(notice.retracted, true);
	assert.equal(notice.noticeDOI, "10.1/x");
	assert.equal(notice.rwSource, "retraction-watch");
	// article record: mirrored as updated-by
	assert.equal(fv.retractionFromCrossref({ "updated-by": [{ DOI: "10.1/notice", type: "retraction", source: "publisher" }] }).retracted, true);
	// a correction is not a retraction
	assert.equal(fv.retractionFromCrossref({ "update-to": [{ type: "correction" }] }).retracted, false);
	// clean / empty
	assert.equal(fv.retractionFromCrossref({}).retracted, false);
	assert.equal(fv.retractionFromCrossref(null).retracted, false);
	// relation-style fallback
	assert.equal(fv.retractionFromCrossref({ relation: { "is-retracted-by": [{ id: "x" }] } }).retracted, true);
});

test("Crossref query keeps DOI slashes literal in the path (not %2F)", async () => {
	let seenURL = "";
	const { fv } = load({ zotero: { HTTP: { request: async (method, url) => {
		seenURL = url;
		return { status: 200, response: { message: {} } };
	} } } });
	await fv.checkRetractionCrossref("10.1016/S0140-6736(20)31180-6", "me@example.org");
	assert.match(seenURL, /api\.crossref\.org\/works\/10\.1016\/S0140-6736/);
	assert.doesNotMatch(seenURL, /%2F/i);
});

test("checkRetraction falls back to Crossref when PubMed has no record", async () => {
	// PubMed esearch finds nothing, esummary never matters; Crossref says retracted.
	const responses = {
		esearch: { status: 200, response: { esearchresult: { idlist: [] } } },
		crossref: { status: 200, response: { message: { "updated-by": [{ DOI: "10.1/notice", type: "retraction", source: "retraction-watch" }] } } },
	};
	const { fv } = load({ zotero: { HTTP: { request: async (method, url) => {
		if (url.includes("esearch")) return responses.esearch;
		if (url.includes("api.crossref.org")) return responses.crossref;
		throw new Error("unexpected url " + url);
	} } } });
	const res = await fv.checkRetraction("10.5555/sham", null, "me@example.org");
	assert.equal(res.status, "retracted");
	assert.match(res.reason, /Crossref records a retraction/);
	assert.match(res.reason, /Retraction Watch/);
});

test("checkRetraction stays 'none' when neither source flags it", async () => {
	const { fv } = load({ zotero: { HTTP: { request: async (method, url) => {
		if (url.includes("esearch")) return { status: 200, response: { esearchresult: { idlist: ["42"] } } };
		if (url.includes("esummary")) return { status: 200, response: { result: { "42": { pubtype: ["Journal Article"] } } } };
		if (url.includes("api.crossref.org")) return { status: 200, response: { message: { "update-to": [{ type: "correction" }] } } };
		throw new Error("unexpected url " + url);
	} } } });
	const res = await fv.checkRetraction("10.1/ok", null, "me@example.org");
	assert.equal(res.status, "none");
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
