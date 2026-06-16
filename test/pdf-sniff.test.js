"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load, pdfBytes } = require("./helpers");

test("accepts a real-looking PDF", () => {
	const { fv } = load();
	const v = fv.sniffPDFBytes(pdfBytes());
	assert.equal(v.ok, true);
	assert.equal(v.reason, "");
});

test("accepts %PDF- after leading junk within the sniff window", () => {
	const { fv } = load();
	const b = pdfBytes();
	b.set([0x0A, 0x0A], 0);              // a couple of newlines first
	b.set([0x25, 0x50, 0x44, 0x46, 0x2D], 5); // then %PDF-
	assert.equal(fv.sniffPDFBytes(b).ok, true);
});

test("rejects an HTML page", () => {
	const { fv } = load();
	const b = new Uint8Array([0x3C, 0x68, 0x74, 0x6D, 0x6C]); // "<html"
	assert.equal(fv.sniffPDFBytes(b).ok, false);
	assert.match(fv.sniffPDFBytes(b).reason, /HTML/);
});

test("rejects HTML hidden behind a BOM and whitespace", () => {
	const { fv } = load();
	const b = new Uint8Array([0xEF, 0xBB, 0xBF, 0x20, 0x09, 0x3C, 0x21]); // BOM, space, tab, "<!"
	assert.equal(fv.sniffPDFBytes(b).ok, false);
});

test("rejects a too-small PDF stub", () => {
	const { fv } = load();
	const v = fv.sniffPDFBytes(pdfBytes(5000));
	assert.equal(v.ok, false);
	assert.match(v.reason, /too small/);
});

test("rejects a buffer with no %PDF- marker", () => {
	const { fv } = load();
	const b = new Uint8Array(20000);
	b.set([1, 2, 3, 4, 5], 0);
	assert.equal(fv.sniffPDFBytes(b).ok, false);
});

test("rejects an empty response", () => {
	const { fv } = load();
	assert.equal(fv.sniffPDFBytes(new Uint8Array(0)).ok, false);
});

test("rejects an over-large buffer", () => {
	const { fv } = load();
	fv.MAX_PDF_BYTES = 10; // avoid allocating 100 MB in a test
	const v = fv.sniffPDFBytes(pdfBytes(20000));
	assert.equal(v.ok, false);
	assert.match(v.reason, /too large/);
});
