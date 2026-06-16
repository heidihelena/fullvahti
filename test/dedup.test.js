"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load, makeItem } = require("./helpers");

// Drive the whole run() loop with the network and UI stubbed, to prove that a
// duplicate item (same DOI) is still labelled — not silently skipped.
function runner() {
	const { fv } = load();
	fv.ensureEmail = async () => "e@x.org";
	fv.attachPDF = async () => {};
	const calls = [];
	fv.resolveOA = async (doi) => {
		calls.push(doi);
		if (doi === "10.2/found") return { status: "found", source: "https://h/x.pdf", license: "cc-by", reason: "", oaStatus: "gold" };
		return { status: "missing", reason: "no open-access copy known", oaStatus: "" };
	};
	return { fv, calls };
}

test("duplicate items are tagged (mirroring the original) and not re-fetched", async () => {
	const { fv, calls } = runner();
	const a = makeItem({ DOI: "10.1/dup" }, { key: "A", id: 1 });
	const b = makeItem({ DOI: "10.1/dup" }, { key: "B", id: 2 }); // same paper
	await fv.run([a, b], { alert() {} });

	assert.deepEqual(calls, ["10.1/dup"]);              // resolveOA ran once, not twice
	assert.ok(a._tags.has("fulltext:pdf-missing"));
	assert.ok(b._tags.has("fulltext:pdf-missing"));     // the duplicate got labelled too
});

test("distinct items are each resolved and tagged by outcome", async () => {
	const { fv, calls } = runner();
	const a = makeItem({ DOI: "10.1/dup" }, { key: "A", id: 1 });
	const b = makeItem({ DOI: "10.1/dup" }, { key: "B", id: 2 });
	const c = makeItem({ DOI: "10.2/found" }, { key: "C", id: 3 });
	await fv.run([a, b, c], { alert() {} });

	assert.deepEqual(calls.sort(), ["10.1/dup", "10.2/found"]); // B mirrored, not re-fetched
	assert.ok(c._tags.has("fulltext:pdf-found"));
});
