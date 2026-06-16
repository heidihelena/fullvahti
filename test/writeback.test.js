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
