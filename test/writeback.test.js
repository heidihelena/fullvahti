"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { load, makeItem } = require("./helpers");

// Build the /fullvahti/tag endpoint with given prefs and a target item, then
// return a function that POSTs a body and yields [status, type, parsedBody].
function tagEndpoint({ prefs = {}, item } = {}) {
	const itemsByKey = item ? { [item.key]: item } : {};
	const { fv, sandbox } = load({ prefs, itemsByKey });
	fv.registerEndpoints();
	const Ctor = sandbox.Zotero.Server.Endpoints["/fullvahti/tag"];
	return async (body) => {
		const ep = new Ctor();
		const [code, type, json] = await ep.init({ data: body });
		return [code, type, JSON.parse(json)];
	};
}

test("rejects when writeback is disabled (default)", async () => {
	const post = tagEndpoint({ prefs: {} });
	const [code, , body] = await post({ token: "t", itemKey: "K", add: ["cite:x"] });
	assert.equal(code, 403);
	assert.equal(body.ok, false);
});

test("rejects a missing or wrong token", async () => {
	const post = tagEndpoint({ prefs: { "extensions.fullvahti.writebackEnabled": true, "extensions.fullvahti.writebackToken": "secret" } });
	assert.equal((await post({ token: "nope", itemKey: "K", add: ["cite:x"] }))[0], 403);
	assert.equal((await post({ itemKey: "K", add: ["cite:x"] }))[0], 403);
});

test("rejects a malformed body", async () => {
	const post = tagEndpoint({ prefs: { "extensions.fullvahti.writebackEnabled": true, "extensions.fullvahti.writebackToken": "secret" } });
	const [code] = await post({ token: "secret", itemKey: "K" }); // neither add nor remove
	assert.equal(code, 400);
});

test("rejects tags outside the Vahtian namespace", async () => {
	const item = makeItem({}, { key: "K" });
	const post = tagEndpoint({
		prefs: { "extensions.fullvahti.writebackEnabled": true, "extensions.fullvahti.writebackToken": "secret" },
		item,
	});
	const [code, , body] = await post({ token: "secret", itemKey: "K", add: ["cite:ok", "evil:tag"] });
	assert.equal(code, 400);
	assert.match(body.error, /allowed Vahtian prefix/);
	assert.match(body.error, /evil:tag/);
	// nothing was written
	assert.equal(item._tags.size, 0);
});

test("rejects an empty-string tag", async () => {
	const item = makeItem({}, { key: "K" });
	const post = tagEndpoint({
		prefs: { "extensions.fullvahti.writebackEnabled": true, "extensions.fullvahti.writebackToken": "secret" },
		item,
	});
	assert.equal((await post({ token: "secret", itemKey: "K", add: [""] }))[0], 400);
});

test("404 when the item key is unknown", async () => {
	const post = tagEndpoint({ prefs: { "extensions.fullvahti.writebackEnabled": true, "extensions.fullvahti.writebackToken": "secret" } });
	const [code] = await post({ token: "secret", itemKey: "MISSING", add: ["cite:x"] });
	assert.equal(code, 404);
});

test("applies allowed add/remove with a valid token", async () => {
	const item = makeItem({}, { key: "K", tags: ["fulltext:pdf-missing"] });
	const post = tagEndpoint({
		prefs: { "extensions.fullvahti.writebackEnabled": true, "extensions.fullvahti.writebackToken": "secret" },
		item,
	});
	const [code, , body] = await post({
		token: "secret", itemKey: "K",
		add: ["cite:closer-look", "GRADE:high", "RoB2:low", "ROBINS-I:moderate", "Quality:good"],
		remove: ["fulltext:pdf-missing"],
	});
	assert.equal(code, 200);
	assert.equal(body.ok, true);
	assert.ok(item._tags.has("cite:closer-look"));
	assert.ok(item._tags.has("GRADE:high"));
	assert.ok(!item._tags.has("fulltext:pdf-missing"));
});

// ---------------------------------------------------------------------------
// Safety invariant: preview before write, audit each write, undo any write.
// These share one sandbox so the audit log persists across calls.
// ---------------------------------------------------------------------------
const WB_PREFS = {
	"extensions.fullvahti.writebackEnabled": true,
	"extensions.fullvahti.writebackToken": "secret",
};

function writebackHarness(item) {
	const itemsByKey = item ? { [item.key]: item } : {};
	const { fv, sandbox, prefStore } = load({ prefs: { ...WB_PREFS }, itemsByKey });
	fv.registerEndpoints();
	const eps = sandbox.Zotero.Server.Endpoints;
	const call = (path, requestData) => async () => {
		const ep = new eps[path]();
		const [code, , json] = await ep.init(requestData);
		return [code, JSON.parse(json)];
	};
	return {
		fv,
		prefStore,
		tag: (body) => call("/fullvahti/tag", { data: body })(),
		undo: (body) => call("/fullvahti/undo", { data: body })(),
		audit: (query) => call("/fullvahti/audit", { query })(),
	};
}

test("dryRun previews the effective change without writing", async () => {
	const item = makeItem({}, { key: "K", tags: ["cite:closer-look"] });
	const h = writebackHarness(item);
	const [code, body] = await h.tag({
		token: "secret", itemKey: "K", dryRun: true,
		add: ["GRADE:high", "cite:closer-look"], // second one already present
		remove: ["fulltext:pdf-missing"],        // not present
	});
	assert.equal(code, 200);
	assert.equal(body.dryRun, true);
	assert.deepEqual(body.preview.willAdd, ["GRADE:high"]);
	assert.deepEqual(body.preview.willRemove, []);       // wasn't present
	assert.deepEqual(body.preview.alreadyPresent, ["cite:closer-look"]);
	assert.deepEqual(body.preview.alreadyAbsent, ["fulltext:pdf-missing"]);
	// Nothing was written, and no audit record was created.
	assert.ok(!item._tags.has("GRADE:high"));
	assert.equal(h.prefStore["extensions.fullvahti.auditLog"], undefined);
});

test("an applied write creates an audit record retrievable via /fullvahti/audit", async () => {
	const item = makeItem({}, { key: "K", tags: [] });
	const h = writebackHarness(item);
	const [code, body] = await h.tag({ token: "secret", itemKey: "K", add: ["GRADE:high"] });
	assert.equal(code, 200);
	assert.ok(body.audit && body.audit.id);
	assert.deepEqual(body.applied.added, ["GRADE:high"]);

	// audit endpoint is token-gated
	assert.equal((await h.audit({ token: "nope" }))[0], 403);
	const [acode, abody] = await h.audit({ token: "secret" });
	assert.equal(acode, 200);
	assert.equal(abody.count, 1);
	assert.equal(abody.records[0].itemKey, "K");
	assert.deepEqual(abody.records[0].added, ["GRADE:high"]);
	// the token is never persisted in the audit log
	assert.equal(abody.records[0].token, undefined);
});

test("undo reverses a recorded write and is itself audited", async () => {
	const item = makeItem({}, { key: "K", tags: ["fulltext:pdf-missing"] });
	const h = writebackHarness(item);
	const [, applied] = await h.tag({
		token: "secret", itemKey: "K",
		add: ["GRADE:high"], remove: ["fulltext:pdf-missing"],
	});
	assert.ok(item._tags.has("GRADE:high"));
	assert.ok(!item._tags.has("fulltext:pdf-missing"));

	const auditId = applied.audit.id;
	// preview the undo first
	const [pcode, preview] = await h.undo({ token: "secret", auditId, dryRun: true });
	assert.equal(pcode, 200);
	assert.equal(preview.dryRun, true);
	assert.ok(item._tags.has("GRADE:high")); // still unchanged after a dry run

	const [code, body] = await h.undo({ token: "secret", auditId });
	assert.equal(code, 200);
	assert.equal(body.undoOf, auditId);
	// state restored to before the original write
	assert.ok(!item._tags.has("GRADE:high"));
	assert.ok(item._tags.has("fulltext:pdf-missing"));

	// undoing the same record again is refused
	assert.equal((await h.undo({ token: "secret", auditId }))[0], 409);

	// both the write and its reversal are in the log
	const [, abody] = await h.audit({ token: "secret" });
	assert.equal(abody.count, 2);
	assert.equal(abody.records[1].undoOf, auditId);
});

test("undo rejects unknown / wrong-token / disabled", async () => {
	const item = makeItem({}, { key: "K", tags: [] });
	const h = writebackHarness(item);
	assert.equal((await h.undo({ token: "secret", auditId: "nope" }))[0], 404);
	assert.equal((await h.undo({ token: "wrong", auditId: "x" }))[0], 403);
});
