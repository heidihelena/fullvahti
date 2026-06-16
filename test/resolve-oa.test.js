"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load, pdfBytes } = require("./helpers");

// resolveOA orchestrates network calls; stub them on the instance so we test
// only the open-access decision logic (found / missing / check + reason).
function withStubs(stubs = {}) {
	const { fv } = load();
	fv.politePause = async () => {};
	fv.fetchJSON = stubs.fetchJSON || (async () => ({ status: 404, response: null }));
	fv.fetchText = stubs.fetchText || (async () => ({ status: 404, responseText: "" }));
	fv.downloadPDF = stubs.downloadPDF || (async () => null);
	return fv;
}

test("DOI with no OA copy -> missing", async () => {
	const fv = withStubs({
		fetchJSON: async () => ({ status: 200, response: { is_oa: false, oa_status: "closed" } }),
	});
	const r = await fv.resolveOA("10.1/x", null, null, "e@x.org");
	assert.equal(r.status, "missing");
	assert.match(r.reason, /no open-access copy/i);
});

test("DOI with a downloadable OA PDF -> found, with source and license", async () => {
	const fv = withStubs({
		fetchJSON: async () => ({
			status: 200,
			response: {
				is_oa: true, oa_status: "gold",
				best_oa_location: { url_for_pdf: "https://host/a.pdf", license: "cc-by" },
				oa_locations: [],
			},
		}),
		downloadPDF: async (url) => (url === "https://host/a.pdf" ? pdfBytes() : null),
	});
	const r = await fv.resolveOA("10.1/x", null, null, "e@x.org");
	assert.equal(r.status, "found");
	assert.equal(r.source, "https://host/a.pdf");
	assert.equal(r.license, "cc-by");
});

test("DOI OA but no direct PDF link -> missing", async () => {
	const fv = withStubs({
		fetchJSON: async () => ({
			status: 200,
			response: { is_oa: true, oa_status: "green", best_oa_location: { url_for_pdf: null }, oa_locations: [{ url_for_pdf: null }] },
		}),
	});
	const r = await fv.resolveOA("10.1/x", null, null, "e@x.org");
	assert.equal(r.status, "missing");
	assert.match(r.reason, /no direct PDF link/i);
});

test("DOI listed PDFs that all fail to download -> check (not missing)", async () => {
	const fv = withStubs({
		fetchJSON: async () => ({
			status: 200,
			response: { is_oa: true, best_oa_location: { url_for_pdf: "https://host/a.pdf" }, oa_locations: [] },
		}),
		downloadPDF: async () => null, // every candidate fails to verify
	});
	const r = await fv.resolveOA("10.1/x", null, null, "e@x.org");
	assert.equal(r.status, "check");
	assert.match(r.reason, /none downloaded/i);
});

test("Unpaywall server error -> check", async () => {
	const fv = withStubs({
		fetchJSON: async () => ({ status: 500, response: null }),
	});
	const r = await fv.resolveOA("10.1/x", null, null, "e@x.org");
	assert.equal(r.status, "check");
	assert.match(r.reason, /Unpaywall error/i);
});

test("DOI unknown to Unpaywall (404), no other id -> missing", async () => {
	const fv = withStubs({
		fetchJSON: async () => ({ status: 404, response: null }),
	});
	const r = await fv.resolveOA("10.1/x", null, null, "e@x.org");
	assert.equal(r.status, "missing");
	assert.match(r.reason, /not known to Unpaywall/i);
});

test("PMID -> PMCID in the OA subset, Europe PMC fallback downloads -> found", async () => {
	const fv = withStubs({
		// idconv resolves the PMID to a PMCID
		fetchJSON: async () => ({ status: 200, response: { records: [{ pmcid: "PMC123" }] } }),
		// PMC OA service confirms OA and offers a PDF link
		fetchText: async () => ({
			status: 200,
			responseText: '<record license="CC BY"><link format="pdf" href="ftp://ftp.ncbi.nlm.nih.gov/pub/a.pdf"/></record>',
		}),
		downloadPDF: async () => pdfBytes(),
	});
	const r = await fv.resolveOA(null, "999", null, "e@x.org");
	assert.equal(r.status, "found");
	assert.equal(r.license, "CC BY");
	assert.match(r.source, /^https:\/\/ftp\.ncbi\.nlm\.nih\.gov\//); // ftp upgraded to https
});

test("PMCID present but not in the OA subset -> missing", async () => {
	const fv = withStubs({
		fetchText: async () => ({ status: 200, responseText: '<error code="idIsNotOpenAccess"/>' }),
	});
	const r = await fv.resolveOA(null, null, "PMC999", "e@x.org");
	assert.equal(r.status, "missing");
	assert.match(r.reason, /not in the open-access subset/i);
});
