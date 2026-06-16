"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load, makeItem } = require("./helpers");

test("normalizeDOI strips prefixes, URLs and wrappers", () => {
	const { fv } = load();
	assert.equal(fv.normalizeDOI("10.1000/abc"), "10.1000/abc");
	assert.equal(fv.normalizeDOI("doi: 10.1000/abc"), "10.1000/abc");
	assert.equal(fv.normalizeDOI("https://doi.org/10.1000/abc"), "10.1000/abc");
	assert.equal(fv.normalizeDOI("https://dx.doi.org/10.1000/abc"), "10.1000/abc");
	assert.equal(fv.normalizeDOI("(10.1000/abc)"), "10.1000/abc");
	assert.equal(fv.normalizeDOI("10.1000/abc."), "10.1000/abc");
	assert.equal(fv.normalizeDOI("10.1000/abc;"), "10.1000/abc");
});

test("normalizeDOI keeps balanced parens in the suffix", () => {
	const { fv } = load();
	assert.equal(fv.normalizeDOI("10.1000/(abc)"), "10.1000/(abc)");
});

test("normalizeDOI returns null for empty input", () => {
	const { fv } = load();
	assert.equal(fv.normalizeDOI(""), null);
	assert.equal(fv.normalizeDOI(null), null);
});

test("extractDOI reads the DOI field, then falls back to extra", () => {
	const { fv } = load();
	assert.equal(fv.extractDOI(makeItem({ DOI: "10.5/x" })), "10.5/x");
	// the extra-field fallback uses a strict pattern (10.<4-9 digits>/...)
	assert.equal(fv.extractDOI(makeItem({ extra: "DOI: 10.1234/y and notes" })), "10.1234/y");
	assert.equal(fv.extractDOI(makeItem({})), null);
});

test("extractDOI tolerates a DOI field that is invalid for the item type", () => {
	const { fv } = load();
	const item = makeItem({ extra: "10.9999/z" }, { invalidFields: ["DOI"] });
	assert.equal(fv.extractDOI(item), "10.9999/z");
});

test("extractPMID reads the PubMed URL and the extra field", () => {
	const { fv } = load();
	assert.equal(fv.extractPMID(makeItem({ url: "https://pubmed.ncbi.nlm.nih.gov/12345/" })), "12345");
	assert.equal(fv.extractPMID(makeItem({ extra: "PMID: 67890" })), "67890");
	assert.equal(fv.extractPMID(makeItem({ extra: "PubMed ID = 222" })), "222");
	assert.equal(fv.extractPMID(makeItem({})), null);
});

test("extractPMCID normalizes case and requires the PMC prefix", () => {
	const { fv } = load();
	assert.equal(fv.extractPMCID(makeItem({ extra: "PMCID: pmc123" })), "PMC123");
	assert.equal(fv.extractPMCID(makeItem({ extra: "no identifier here" })), null);
});

test("hasPDF detects an existing PDF attachment", () => {
	const { fv } = load({ itemsById: { 10: { attachmentContentType: "application/pdf" }, 11: { attachmentContentType: "text/html" } } });
	assert.equal(fv.hasPDF(makeItem({}, { attachments: [10] })), true);
	assert.equal(fv.hasPDF(makeItem({}, { attachments: [11] })), false);
	assert.equal(fv.hasPDF(makeItem({}, { attachments: [] })), false);
});
