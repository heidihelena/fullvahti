/* global Zotero, Services, IOUtils, PathUtils */
"use strict";

/**
 * FullVahti — open-access full texts for Zotero, the Vahtian way.
 *
 * Fetch: for selected items (or every item carrying the trigger tag), resolve an
 * open-access PDF by DOI (Unpaywall) or PMID (PubMed Central / Europe PMC),
 * attach it to the item, and record the outcome as a status tag:
 *   fulltext:pdf-found / fulltext:pdf-missing / fulltext:check-needed
 * One standalone report note per run (optional) lists what was NOT found and why —
 * that list is what feeds interlibrary loan requests and PRISMA flow diagrams.
 * No per-item notes: the attached PDF is its own record.
 *
 * Write: a token-guarded endpoint on Zotero's local server so CiteVahti's gated
 * writeback can add/remove tags. Default OFF. No silent writes — every write is
 * previewable (dryRun), restricted to an allowlisted tag namespace, recorded to a
 * local audit log, and reversible via /fullvahti/undo. FullVahti never verifies
 * claims, rates anything, or sees manuscript text: it only receives an item key
 * and allowlisted tags, after CiteVahti has obtained the user's confirmation.
 *
 * Stance (shared with the Vahtian spine): open access only — paywalled items are
 * reported as missing, never bypassed. PMC downloads are restricted to the PMC
 * Open Access Subset via the OA Web Service; PMC pages are never scraped.
 *
 * Where data goes (and nowhere else): Zotero metadata is read locally. Each
 * item's DOI/PMID — plus the contact email where an API asks for it — is sent
 * to the OA-resolution services (Unpaywall, NCBI, Europe PMC) and, for the
 * retraction check, to NCBI and Crossref (which carries the Retraction Watch
 * database). Resolved PDF URLs are fetched from their host sites, without the email.
 */

var FullVahti = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	running: false,
	addedElementIDs: [],

	STATUS_TAGS: ["fulltext:pdf-found", "fulltext:pdf-missing", "fulltext:check-needed"],
	STATUS_BY_KEY: {
		found: "fulltext:pdf-found",
		missing: "fulltext:pdf-missing",
		check: "fulltext:check-needed",
	},
	// Retraction scan tags. A retracted citation is exactly what screening must
	// catch; FullVahti reads the fact from PubMed and never judges it itself.
	RETRACTION_TAGS: ["retraction:retracted", "retraction:none", "retraction:check-needed"],
	RETRACTION_BY_KEY: {
		retracted: "retraction:retracted",
		none: "retraction:none",
		check: "retraction:check-needed",
	},
	// Writeback (CiteVahti) may only touch tags in the Vahtian namespace. Tags
	// outside these prefixes are refused, so a leaked token can't write arbitrary
	// tags into someone's library.
	ALLOWED_TAG_PREFIXES: ["cite:", "fulltext:", "retraction:", "GRADE:", "RoB2:", "ROBINS-I:", "Quality:"],
	// Every applied writeback is recorded here (a JSON array, newest last) so each
	// change is auditable and undoable. Bounded so the log can't grow without limit.
	AUDIT_PREF: "auditLog",
	AUDIT_MAX: 500,
	// A real OA article PDF is essentially always larger than this; smaller "PDFs"
	// are almost always publisher error/landing stubs, so we reject them (-> check).
	MIN_PDF_BYTES: 10000,
	MAX_PDF_BYTES: 100000000,
	HTTP_TIMEOUT: 30000,
	// Pause before EVERY outgoing request (not just per item) — NCBI asks for
	// <= 3 requests/second without an API key; we stay well under everywhere.
	REQUEST_DELAY: 350,

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},

	log(msg) {
		Zotero.debug("FullVahti: " + msg);
	},

	// -----------------------------------------------------------------
	// Preferences
	// -----------------------------------------------------------------
	getPref(key) {
		return Zotero.Prefs.get("extensions.fullvahti." + key, true);
	},

	setPref(key, value) {
		Zotero.Prefs.set("extensions.fullvahti." + key, value, true);
	},

	// -----------------------------------------------------------------
	// Window wiring
	// -----------------------------------------------------------------
	addToWindow(window) {
		let doc = window.document;

		let itemMenu = doc.getElementById("zotero-itemmenu");
		if (itemMenu && !doc.getElementById("fullvahti-itemmenu")) {
			let mi = doc.createXULElement("menuitem");
			mi.id = "fullvahti-itemmenu";
			mi.setAttribute("label", "FullVahti: Find Open-Access PDFs");
			mi.addEventListener("command", () => this.runForSelected(window));
			itemMenu.appendChild(mi);
			this.storeAddedElement(mi);
		}

		if (itemMenu && !doc.getElementById("fullvahti-itemmenu-retract")) {
			let mi = doc.createXULElement("menuitem");
			mi.id = "fullvahti-itemmenu-retract";
			mi.setAttribute("label", "FullVahti: Check for Retractions");
			mi.addEventListener("command", () => this.runRetractionForSelected(window));
			itemMenu.appendChild(mi);
			this.storeAddedElement(mi);
		}

		let toolsMenu = doc.getElementById("menu_ToolsPopup");
		if (toolsMenu && !doc.getElementById("fullvahti-toolsmenu")) {
			let mi = doc.createXULElement("menuitem");
			mi.id = "fullvahti-toolsmenu";
			let tag = this.getPref("triggerTag") || "cite:closer-look";
			mi.setAttribute("label", `FullVahti: Find OA PDFs for items tagged “${tag}”`);
			mi.addEventListener("command", () => this.runForTag(window));
			toolsMenu.appendChild(mi);
			this.storeAddedElement(mi);
		}

		if (toolsMenu && !doc.getElementById("fullvahti-toolsmenu-retract")) {
			let mi = doc.createXULElement("menuitem");
			mi.id = "fullvahti-toolsmenu-retract";
			let tag = this.getPref("triggerTag") || "cite:closer-look";
			mi.setAttribute("label", `FullVahti: Check items tagged “${tag}” for retractions`);
			mi.addEventListener("command", () => this.runRetractionForTag(window));
			toolsMenu.appendChild(mi);
			this.storeAddedElement(mi);
		}

		// Lets the user see (and clear) CiteVahti's write-back history without
		// touching the HTTP endpoint — the "audited" guarantee, made human-facing.
		if (toolsMenu && !doc.getElementById("fullvahti-auditmenu")) {
			let mi = doc.createXULElement("menuitem");
			mi.id = "fullvahti-auditmenu";
			mi.setAttribute("label", "FullVahti: Show CiteVahti write-back audit log");
			mi.addEventListener("command", () => this.showAuditLog(window));
			toolsMenu.appendChild(mi);
			this.storeAddedElement(mi);
		}
	},

	addToAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	},

	storeAddedElement(elem) {
		if (!elem.id) throw new Error("Element must have an id");
		this.addedElementIDs.push(elem.id);
	},

	removeFromWindow(window) {
		let doc = window.document;
		for (let id of this.addedElementIDs) {
			doc.getElementById(id)?.remove();
		}
	},

	removeFromAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			this.removeFromWindow(win);
		}
	},

	// -----------------------------------------------------------------
	// Entry points
	// -----------------------------------------------------------------
	async runForSelected(window) {
		let items = window.ZoteroPane.getSelectedItems()
			.filter(it => it.isRegularItem() && it.isTopLevelItem());
		if (!items.length) {
			window.alert("FullVahti: select one or more regular items first (not attachments or notes).");
			return;
		}
		await this.run(items, window);
	},

	async runForTag(window) {
		let tag = this.getPref("triggerTag") || "cite:closer-look";
		let s = new Zotero.Search();
		s.libraryID = Zotero.Libraries.userLibraryID;
		s.addCondition("tag", "is", tag);
		let ids = await s.search();
		let items = (await Zotero.Items.getAsync(ids))
			.filter(it => it.isRegularItem() && it.isTopLevelItem());
		if (!items.length) {
			window.alert(
				`FullVahti: no items carry the tag “${tag}”.\n\n` +
				"Tag the references you want full texts for with that tag, " +
				"or simply select items and use the right-click menu instead."
			);
			return;
		}
		await this.run(items, window);
	},

	// -----------------------------------------------------------------
	// The main loop
	// -----------------------------------------------------------------
	async run(items, window) {
		if (this.running) {
			window.alert("FullVahti is already running — let the current batch finish first.");
			return;
		}

		let email = await this.ensureEmail(window);
		if (!email) return;

		if (items.length > 60) {
			let mins = Math.ceil(items.length * ((parseInt(this.getPref("delayMs")) || 400) + 2500) / 60000);
			let ok = Services.prompt.confirm(
				window,
				"FullVahti",
				`${items.length} items — FullVahti fetches politely (one at a time), ` +
				`so this will take roughly ${mins} min. You can keep using Zotero meanwhile. Continue?`
			);
			if (!ok) return;
		}

		this.running = true;
		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("FullVahti — finding open-access PDFs");
		pw.show();
		let progress = new pw.ItemProgress("", "Starting…");

		let delayMs = parseInt(this.getPref("delayMs")) || 400;
		let rows = [];
		let counts = { found: 0, missing: 0, check: 0 };
		let seen = new Map(); // dedup key -> resolved status, so duplicates can mirror it

		try {
			for (let i = 0; i < items.length; i++) {
				let item = items[i];
				let title = (item.getField("title") || "(untitled)").substring(0, 70);
				progress.setText(`${i + 1}/${items.length}  ${title}`);
				progress.setProgress(Math.round((i / items.length) * 100));

				let doi = this.extractDOI(item);
				let pmid = this.extractPMID(item);
				let pmcid = this.extractPMCID(item);
				let dedup = doi || pmid || pmcid || item.key;
				if (seen.has(dedup)) {
					// Same paper as an item already handled this run. Don't re-fetch,
					// but still label it (mirror the original's outcome) so every item
					// ends up tagged — never silently skipped.
					let status = seen.get(dedup);
					await this.setStatusTag(item, this.STATUS_BY_KEY[status]);
					rows.push({ key: item.key, title, doi: doi || "", pmid: pmid || "",
						status, reason: "duplicate of an item already processed this run",
						source: "", license: "", oaStatus: "", duplicate: true });
					await Zotero.Promise.delay(delayMs);
					continue;
				}
				seen.set(dedup, null);

				let row = Object.assign({ key: item.key, title, doi: doi || "", pmid: pmid || "",
					status: "", reason: "", source: "", license: "", oaStatus: "" },
					this.citationFields(item));
				try {
					if (this.hasPDF(item)) {
						row.status = "found";
						row.reason = "already had a PDF attachment";
					}
					else if (!doi && !pmid && !pmcid) {
						row.status = "check";
						row.reason = "no DOI, PMID, or PMCID on the item";
					}
					else {
						let res = await this.resolveOA(doi, pmid, pmcid, email);
						row.status = res.status;
						row.reason = res.reason || "";
						row.source = res.source || "";
						row.license = res.license || "";
						row.oaStatus = res.oaStatus || "";
						if (res.status === "found") {
							await this.attachPDF(item, res.bytes, res.source);
						}
					}
				}
				catch (e) {
					this.log("item " + item.key + " error: " + e);
					row.status = "check";
					row.reason = "unexpected error: " + (e.message || e);
				}

				counts[row.status]++;
				seen.set(dedup, row.status); // later duplicates mirror this outcome
				await this.setStatusTag(item, this.STATUS_BY_KEY[row.status]);
				rows.push(row);
				await Zotero.Promise.delay(delayMs);
			}

			progress.setProgress(100);
			progress.setText(
				`Done: ${counts.found} found · ${counts.missing} no OA copy · ${counts.check} need a look`
			);

			if (this.getPref("reportNote") && rows.length) {
				await this.writeReportNote(rows, counts);
			}
		}
		finally {
			this.running = false;
			pw.startCloseTimer(8000);
		}
	},

	async ensureEmail(window) {
		let email = (this.getPref("email") || "").trim();
		if (email.includes("@")) return email;

		// Decent guess: many people's Zotero account name is their email.
		let guess = (Zotero.Prefs.get("sync.server.username") || "").trim();
		let value = { value: guess.includes("@") ? guess : "" };
		let ok = Services.prompt.prompt(
			window,
			"FullVahti — one-time setup",
			"FullVahti looks up open-access copies via Unpaywall and PubMed Central.\n" +
			"These free services ask politely for a contact email (it is sent only to them,\n" +
			"never to us). Your email:",
			value, null, {}
		);
		if (!ok || !value.value.includes("@")) return null;
		this.setPref("email", value.value.trim());
		return value.value.trim();
	},

	// -----------------------------------------------------------------
	// Retraction scan — flag references PubMed records as retracted.
	// FullVahti reports the fact; it never decides retraction itself.
	// -----------------------------------------------------------------
	async runRetractionForSelected(window) {
		let items = window.ZoteroPane.getSelectedItems()
			.filter(it => it.isRegularItem() && it.isTopLevelItem());
		if (!items.length) {
			window.alert("FullVahti: select one or more regular items first (not attachments or notes).");
			return;
		}
		await this.runRetraction(items, window);
	},

	async runRetractionForTag(window) {
		let tag = this.getPref("triggerTag") || "cite:closer-look";
		let s = new Zotero.Search();
		s.libraryID = Zotero.Libraries.userLibraryID;
		s.addCondition("tag", "is", tag);
		let ids = await s.search();
		let items = (await Zotero.Items.getAsync(ids))
			.filter(it => it.isRegularItem() && it.isTopLevelItem());
		if (!items.length) {
			window.alert(`FullVahti: no items carry the tag “${tag}”.`);
			return;
		}
		await this.runRetraction(items, window);
	},

	async runRetraction(items, window) {
		if (this.running) {
			window.alert("FullVahti is already running — let the current batch finish first.");
			return;
		}
		let email = await this.ensureEmail(window);
		if (!email) return;

		this.running = true;
		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("FullVahti — checking for retractions");
		pw.show();
		let progress = new pw.ItemProgress("", "Starting…");

		let delayMs = parseInt(this.getPref("delayMs")) || 400;
		let rows = [];
		let counts = { retracted: 0, none: 0, check: 0 };
		let seen = new Map();

		try {
			for (let i = 0; i < items.length; i++) {
				let item = items[i];
				let title = (item.getField("title") || "(untitled)").substring(0, 70);
				progress.setText(`${i + 1}/${items.length}  ${title}`);
				progress.setProgress(Math.round((i / items.length) * 100));

				let doi = this.extractDOI(item);
				let pmid = this.extractPMID(item);
				let dedup = doi || pmid || item.key;
				if (seen.has(dedup)) {
					let status = seen.get(dedup);
					await this.setRetractionTag(item, this.RETRACTION_BY_KEY[status]);
					rows.push({ key: item.key, title, doi: doi || "", pmid: pmid || "",
						status, reason: "duplicate of an item already checked this run",
						source: "", duplicate: true });
					await Zotero.Promise.delay(delayMs);
					continue;
				}
				seen.set(dedup, null);

				let row = { key: item.key, title, doi: doi || "", pmid: pmid || "",
					status: "", reason: "", source: "" };
				try {
					let res = await this.checkRetraction(doi, pmid, email);
					row.status = res.status;
					row.reason = res.reason || "";
					row.source = res.source || "";
				}
				catch (e) {
					this.log("retraction item " + item.key + " error: " + e);
					row.status = "check";
					row.reason = "unexpected error: " + (e.message || e);
				}

				counts[row.status]++;
				seen.set(dedup, row.status);
				await this.setRetractionTag(item, this.RETRACTION_BY_KEY[row.status]);
				rows.push(row);
				await Zotero.Promise.delay(delayMs);
			}

			progress.setProgress(100);
			progress.setText(
				`Done: ${counts.retracted} retracted · ${counts.none} clear · ${counts.check} couldn’t check`
			);
			if (counts.retracted > 0) {
				progress.setText(`⚠ ${counts.retracted} RETRACTED · ${counts.none} clear · ${counts.check} couldn’t check`);
			}

			if (this.getPref("reportNote") && rows.length) {
				await this.writeRetractionReport(rows, counts);
			}
		}
		finally {
			this.running = false;
			pw.startCloseTimer(8000);
		}
	},

	// Pure: first PMID from an esearch JSON response, or null. Side-effect-free.
	pmidFromESearch(json) {
		let ids = json && json.esearchresult && json.esearchresult.idlist;
		return (Array.isArray(ids) && ids.length) ? String(ids[0]) : null;
	},

	// Pure: decide retraction status from an esummary JSON for one PMID.
	// "Retracted Publication" is the publication type PubMed assigns to a paper
	// that has been retracted (distinct from "Retraction of Publication", the
	// notice). Returns "retracted" | "none", or null when the record is absent.
	retractionFromSummary(json, pmid) {
		let rec = json && json.result && json.result[pmid];
		if (!rec) return null;
		let types = rec.pubtype || rec.pubtypelist || [];
		let isRetracted = types.some(t => /^retracted publication$/i.test(String(t).trim()));
		return isRetracted ? "retracted" : "none";
	},

	// Pure: decide whether a Crossref work message records a retraction.
	// Crossref puts the retraction in the *notice's* `update-to` (its DOI points
	// to the retracted article) and mirrors it on the *article* as `updated-by`;
	// each entry has type "retraction" and source "publisher" | "retraction-watch".
	// We scan every documented key variant so it fires whichever DOI was cited.
	// Returns { retracted, noticeDOI?, rwSource? }. Side-effect-free (testable).
	retractionFromCrossref(message) {
		if (!message) return { retracted: false };
		let entries = [];
		for (let k of ["update-to", "updated-by", "update-by", "updated_by", "update_to"]) {
			if (Array.isArray(message[k])) entries.push(...message[k]);
		}
		for (let u of entries) {
			if (u && /retract/i.test(String(u.type || ""))) {
				return { retracted: true, noticeDOI: u.DOI || u.doi || "", rwSource: u.source || "" };
			}
		}
		let rel = message.relation || {};
		for (let key of Object.keys(rel)) {
			if (/retract/i.test(key) && Array.isArray(rel[key]) && rel[key].length) {
				return { retracted: true };
			}
		}
		return { retracted: false };
	},

	// Query Crossref for a DOI and read its retraction status. Crossref now carries
	// the Retraction Watch database, so this catches retractions PubMed doesn't
	// index (e.g. the 2024–2025 mass sham-paper retractions). Returns
	// { found, retracted?, rwSource? } or { error }.
	async checkRetractionCrossref(doi, email) {
		if (!doi) return null;
		try {
			// Crossref's /works/{doi} takes the DOI raw in the PATH — a %2F-encoded
			// slash can 404. Escape only genuinely unsafe characters (spaces, #, ?,
			// …) and keep the DOI's own slashes literal.
			let pathDOI = encodeURIComponent(doi).replace(/%2F/gi, "/");
			let xhr = await this.fetchJSON(
				"https://api.crossref.org/works/" + pathDOI
				+ "?mailto=" + encodeURIComponent(email));
			if (xhr.status === 404) return { found: false };
			if (xhr.status !== 200 || !xhr.response || !xhr.response.message) {
				return { error: "Crossref HTTP " + xhr.status };
			}
			let r = this.retractionFromCrossref(xhr.response.message);
			return { found: true, retracted: r.retracted, rwSource: r.rwSource || "" };
		}
		catch (e) {
			this.log("crossref retraction error: " + e);
			return { error: "Crossref request failed" };
		}
	},

	/**
	 * Check one reference for a retraction. PubMed first (precise publication
	 * type); then Crossref / Retraction Watch by DOI, which catches retractions
	 * PubMed never indexed. Returns { status: retracted|none|check, reason, source? }.
	 */
	async checkRetraction(doi, pmid, email) {
		let pubmed = await this.checkRetractionPubMed(doi, pmid, email);
		if (pubmed.status === "retracted") return pubmed;

		// Not flagged by PubMed (clear, or no record). Cross-check Crossref by DOI.
		if (doi) {
			let cr = await this.checkRetractionCrossref(doi, email);
			if (cr && cr.retracted) {
				let via = cr.rwSource === "retraction-watch" ? "Retraction Watch" : "the publisher";
				return { status: "retracted",
					reason: "Crossref records a retraction (via " + via + ")",
					source: "https://doi.org/" + doi };
			}
			if (cr && cr.error && pubmed.status === "check") {
				return { status: "check", reason: pubmed.reason + "; Crossref: " + cr.error };
			}
		}
		return pubmed;
	},

	// PubMed-only retraction check. For a DOI-only item, resolve a PMID first via
	// esearch. Returns { status: retracted|none|check, reason, source? }.
	async checkRetractionPubMed(doi, pmid, email) {
		try {
			let pid = pmid;
			if (!pid && doi) {
				let xhr = await this.fetchJSON(
					"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term="
					+ encodeURIComponent(doi) + "%5BAID%5D&retmode=json&tool=fullvahti&email="
					+ encodeURIComponent(email));
				if (xhr.status === 200 && xhr.response) pid = this.pmidFromESearch(xhr.response);
			}
			if (!pid) {
				return { status: "check", reason: (doi || pmid)
					? "no PubMed record found to check for a retraction"
					: "no DOI or PMID on the item to check" };
			}
			let xhr = await this.fetchJSON(
				"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id="
				+ encodeURIComponent(pid) + "&retmode=json&tool=fullvahti&email="
				+ encodeURIComponent(email));
			if (xhr.status !== 200 || !xhr.response) {
				return { status: "check", reason: "PubMed lookup error (HTTP " + xhr.status + ")" };
			}
			let verdict = this.retractionFromSummary(xhr.response, pid);
			if (verdict === null) {
				return { status: "check", reason: "no PubMed summary returned for that record" };
			}
			let source = "https://pubmed.ncbi.nlm.nih.gov/" + pid + "/";
			return verdict === "retracted"
				? { status: "retracted", reason: "PubMed lists this as a Retracted Publication", source }
				: { status: "none", reason: "no retraction recorded in PubMed", source };
		}
		catch (e) {
			this.log("retraction check error: " + e);
			return { status: "check", reason: "retraction lookup failed" };
		}
	},

	async setRetractionTag(item, tag) {
		for (let t of this.RETRACTION_TAGS) {
			if (t !== tag) item.removeTag(t);
		}
		item.addTag(tag);
		await item.saveTx();
	},

	async writeRetractionReport(rows, counts) {
		let esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		let when = new Date().toLocaleString();
		let retracted = rows.filter(r => r.status === "retracted" && !r.duplicate);
		let unchecked = rows.filter(r => r.status === "check" && !r.duplicate);

		let html = `<h1>FullVahti retraction check — ${esc(when)}</h1>`
			+ `<p><strong>${counts.retracted}</strong> retracted · `
			+ `<strong>${counts.none}</strong> clear · `
			+ `<strong>${counts.check}</strong> couldn’t be checked.</p>`
			+ `<p>Retraction status is read from PubMed; FullVahti does not judge it. `
			+ `Items are tagged retraction:retracted / none / check-needed.</p>`;

		if (retracted.length) {
			html += "<h2>⚠ Retracted (" + retracted.length + ")</h2><ul>";
			for (let r of retracted) {
				let id = r.pmid
					? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(r.pmid)}/">PMID ${esc(r.pmid)}</a>`
					: (r.doi ? `<a href="https://doi.org/${esc(r.doi)}">doi:${esc(r.doi)}</a>` : "no identifier");
				let via = r.reason ? ` — <em>${esc(r.reason)}</em>` : "";
				html += `<li>${esc(r.title)} — ${id}${via}</li>`;
			}
			html += "</ul>";
		}
		else {
			html += "<p>No retracted items found in this batch.</p>";
		}

		if (unchecked.length) {
			html += "<h2>Couldn’t check (" + unchecked.length + ")</h2><ul>";
			for (let r of unchecked) {
				let id = r.doi
					? `<a href="https://doi.org/${esc(r.doi)}">doi:${esc(r.doi)}</a>`
					: (r.pmid ? `PMID ${esc(r.pmid)}` : "no identifier");
				html += `<li>${esc(r.title)} — ${id} — <em>${esc(r.reason)}</em></li>`;
			}
			html += "</ul>";
		}

		let note = new Zotero.Item("note");
		note.libraryID = Zotero.Libraries.userLibraryID;
		note.setNote(html);
		note.addTag("fullvahti:report");
		await note.saveTx();
	},

	// -----------------------------------------------------------------
	// Identifier extraction (ported from vahtian_fulltext.py)
	// -----------------------------------------------------------------
	normalizeDOI(doi) {
		doi = (doi || "").trim()
			.replace(/^doi:\s*/i, "")
			.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
		// A DOI always begins with "10." — drop any leading wrapper/junk, e.g. a
		// paren or bracket the DOI was pasted inside ("(10.1000/foo)").
		let at = doi.indexOf("10.");
		if (at > 0) doi = doi.slice(at);
		doi = doi.split(/[\s<>"']/)[0] || "";
		doi = doi.replace(/[.,;:>}"']+$/, "");
		// DOI suffixes may legitimately contain ()/[] — only trim unbalanced closers.
		for (let [open, close] of [["(", ")"], ["[", "]"]]) {
			while (doi.endsWith(close)
				&& doi.split(open).length < doi.split(close).length) {
				doi = doi.slice(0, -1).replace(/[.,;:]+$/, "");
			}
		}
		return doi || null;
	},

	extractDOI(item) {
		let doi = "";
		try { doi = (item.getField("DOI") || "").trim(); } catch (e) { /* field invalid for type */ }
		if (doi) return this.normalizeDOI(doi);
		let extra = "";
		try { extra = item.getField("extra") || ""; } catch (e) { /* ignore */ }
		let m = extra.match(/10\.\d{4,9}\/[^\s";,)>\]}]+/);
		return m ? this.normalizeDOI(m[0]) : null;
	},

	extractPMID(item) {
		for (let field of ["url", "extra", "archiveLocation", "callNumber", "archive", "libraryCatalog"]) {
			let v = "";
			try { v = item.getField(field) || ""; } catch (e) { continue; }
			let m = v.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
			if (m) return m[1];
		}
		let extra = "";
		try { extra = item.getField("extra") || ""; } catch (e) { /* ignore */ }
		let m = extra.match(/\b(?:PMID|PubMed ID)\s*[:=]?\s*(\d+)/i);
		return m ? m[1] : null;
	},

	extractPMCID(item) {
		let extra = "";
		try { extra = item.getField("extra") || ""; } catch (e) { /* ignore */ }
		let m = extra.match(/\bPMCID\s*[:=]?\s*(PMC\d+)/i);
		return m ? m[1].toUpperCase() : null;
	},

	hasPDF(item) {
		for (let id of item.getAttachments()) {
			let att = Zotero.Items.get(id);
			if (att && att.attachmentContentType === "application/pdf") return true;
		}
		return false;
	},

	// -----------------------------------------------------------------
	// Open-access resolution (OA only — never bypasses a paywall)
	// -----------------------------------------------------------------
	async politePause() {
		await Zotero.Promise.delay(this.REQUEST_DELAY);
	},

	// Paced GET that resolves on any status (we inspect it ourselves).
	async fetch(url, responseType) {
		await this.politePause();
		return Zotero.HTTP.request("GET", url, {
			responseType,
			timeout: this.HTTP_TIMEOUT,
			successCodes: false,
		});
	},

	fetchJSON(url) { return this.fetch(url, "json"); },
	fetchText(url) { return this.fetch(url, "text"); },

	// Pure: judge whether a downloaded byte buffer is a real OA PDF rather than an
	// HTML landing/error page or a truncated stub. Side-effect-free so it can be
	// unit-tested without the network. Returns { ok, reason }.
	sniffPDFBytes(bytes) {
		if (!bytes || bytes.length === 0) return { ok: false, reason: "empty response" };
		if (bytes.length > this.MAX_PDF_BYTES) {
			return { ok: false, reason: "too large (" + bytes.length + " bytes)" };
		}
		// Reject obvious HTML/XML landing or error pages up front: they can carry
		// the literal "%PDF-" within the sniff window below and slip through.
		let head = 0;
		while (head < bytes.length && (bytes[head] === 0x20 || bytes[head] === 0x09
			|| bytes[head] === 0x0A || bytes[head] === 0x0D || bytes[head] === 0xEF
			|| bytes[head] === 0xBB || bytes[head] === 0xBF)) head++;
		if (bytes[head] === 0x3C) return { ok: false, reason: "looks like HTML, not a PDF" }; // '<'
		// %PDF- somewhere in the first 1024 bytes (the spec tolerates leading junk)
		let isPDF = false;
		let limit = Math.min(bytes.length - 4, 1024);
		for (let i = 0; i < limit; i++) {
			if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44
				&& bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2D) {
				isPDF = true;
				break;
			}
		}
		if (!isPDF) return { ok: false, reason: "not a PDF" };
		if (bytes.length < this.MIN_PDF_BYTES) {
			return { ok: false, reason: "too small (" + bytes.length + " bytes), likely an error stub" };
		}
		return { ok: true, reason: "" };
	},

	async downloadPDF(url) {
		if (!/^https?:\/\//i.test(url)) {
			this.log("blocked non-http(s) PDF URL: " + url);
			return null;
		}
		await this.politePause();
		let xhr;
		try {
			xhr = await Zotero.HTTP.request("GET", url, {
				responseType: "arraybuffer",
				timeout: this.HTTP_TIMEOUT,
			});
		}
		catch (e) {
			this.log("download error " + url + ": " + e);
			return null;
		}
		let bytes = new Uint8Array(xhr.response);
		let verdict = this.sniffPDFBytes(bytes);
		if (!verdict.ok) {
			this.log("rejected " + url + ": " + verdict.reason);
			return null;
		}
		return bytes;
	},

	/**
	 * Query the PMC OA Web Service — the approved interface to the PMC Open
	 * Access Subset. Being in PMC is NOT a download permission; only OA-subset
	 * records may be fetched automatically, and this service is how you ask.
	 * Returns { isOA, pdfURL?, license?, error? }.
	 */
	// Read attribute `name` from a single XML tag string, tolerating either
	// quote style and surrounding whitespace — NCBI's serialization varies.
	xmlAttr(tag, name) {
		let m = tag.match(new RegExp(name + "\\s*=\\s*\"([^\"]*)\"", "i"))
			|| tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", "i"));
		return m ? m[1] : null;
	},

	async pmcOALookup(pmcid) {
		try {
			let xhr = await this.fetchText(
				"https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=" + encodeURIComponent(pmcid)
			);
			if (xhr.status !== 200) return { isOA: false, error: "HTTP " + xhr.status };
			let xml = xhr.responseText || "";
			let errTag = xml.match(/<error\b[^>]*>/i);
			if (errTag) {
				let code = this.xmlAttr(errTag[0], "code") || "unknown";
				if (/idIsNotOpenAccess|idDoesNotExist/i.test(code)) return { isOA: false };
				return { isOA: false, error: code };
			}
			let recTag = xml.match(/<record\b[^>]*>/i);
			let license = (recTag && this.xmlAttr(recTag[0], "license")) || "";
			let pdfURL = null;
			let linkRe = /<link\b[^>]*>/gi;
			let m;
			while ((m = linkRe.exec(xml))) {
				if ((this.xmlAttr(m[0], "format") || "").toLowerCase() === "pdf") {
					let href = this.xmlAttr(m[0], "href");
					if (href) {
						// The OA service often hands out FTP links; NCBI serves the
						// same tree over HTTPS, so upgrade the scheme for NCBI hosts.
						pdfURL = href.replace(/^ftp:\/\/(ftp[\w.-]*\.ncbi\.nlm\.nih\.gov)\//i,
							"https://$1/");
						break;
					}
				}
			}
			return { isOA: true, pdfURL, license };
		}
		catch (e) {
			this.log("pmc-oa error: " + e);
			return { isOA: false, error: String(e) };
		}
	},

	/**
	 * Try DOI (Unpaywall, every OA location) then PMCID/PMID (PMC OA Subset,
	 * Europe PMC for OA-confirmed records).
	 * Returns { status: found|missing|check, bytes?, source?, license?, oaStatus?, reason? }.
	 */
	async resolveOA(doi, pmid, pmcid, email) {
		let sawError = false;
		let reason = "";
		let oaStatus = "";
		let join = (a, b) => (a ? a + "; " + b : b);

		if (doi) {
			try {
				let xhr = await this.fetchJSON(
					"https://api.unpaywall.org/v2/" + encodeURIComponent(doi)
					+ "?email=" + encodeURIComponent(email)
				);
				if (xhr.status === 200 && xhr.response) {
					let data = xhr.response;
					oaStatus = data.oa_status || "";
					if (!data.is_oa) {
						reason = "Unpaywall: no open-access copy known";
					}
					else {
						// Try every OA location with a direct PDF link, best first —
						// best_oa_location alone under-finds.
						let locs = [];
						if (data.best_oa_location) locs.push(data.best_oa_location);
						for (let l of (data.oa_locations || [])) locs.push(l);
						let candidates = [];
						let seenURL = new Set();
						for (let loc of locs) {
							let u = loc && loc.url_for_pdf;
							if (u && !seenURL.has(u)) {
								seenURL.add(u);
								candidates.push({ url: u, license: loc.license || "" });
							}
						}
						for (let c of candidates) {
							let bytes = await this.downloadPDF(c.url);
							if (bytes) {
								return { status: "found", bytes, source: c.url,
									license: c.license, oaStatus };
							}
						}
						if (candidates.length) {
							sawError = true;
							reason = `Unpaywall listed ${candidates.length} PDF link(s) but none downloaded`;
						}
						else {
							reason = "Unpaywall: OA copy exists but no direct PDF link";
						}
					}
				}
				else if (xhr.status !== 404) {
					sawError = true;
					reason = "Unpaywall error (HTTP " + xhr.status + ")";
				}
				else {
					reason = "DOI not known to Unpaywall";
				}
			}
			catch (e) {
				this.log("unpaywall error: " + e);
				sawError = true;
				reason = "Unpaywall request failed";
			}
		}

		if (pmid && !pmcid) {
			try {
				let xhr = await this.fetchJSON(
					"https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=" + encodeURIComponent(pmid)
					+ "&format=json&tool=fullvahti&email=" + encodeURIComponent(email)
				);
				if (xhr.status === 200 && xhr.response && xhr.response.records) {
					for (let rec of xhr.response.records) {
						if (rec.pmcid) { pmcid = rec.pmcid; break; }
					}
					// Confirmed absence — distinct from a lookup that failed.
					if (!pmcid) reason = join(reason, "PMID has no PubMed Central record");
				}
				else {
					// Don't let a transient lookup failure masquerade as "no PMC
					// record" — flag it for a manual look (check) instead of missing.
					sawError = true;
					reason = join(reason, xhr.status === 200
						? "PubMed Central ID lookup returned an unexpected response"
						: "PubMed Central ID lookup error (HTTP " + xhr.status + ")");
				}
			}
			catch (e) {
				this.log("idconv error: " + e);
				sawError = true;
				reason = join(reason, "PubMed Central ID lookup failed");
			}
		}

		if (pmcid) {
			let oa = await this.pmcOALookup(pmcid);
			if (oa.error) {
				sawError = true;
				reason = join(reason, "PMC OA service problem (" + oa.error + ")");
			}
			else if (!oa.isOA) {
				reason = join(reason,
					`in PMC (${pmcid}) but not in the open-access subset — request via your library`);
			}
			else {
				if (oa.pdfURL) {
					let bytes = await this.downloadPDF(oa.pdfURL);
					if (bytes) {
						return { status: "found", bytes, source: oa.pdfURL,
							license: oa.license || "", oaStatus };
					}
				}
				// OA-subset membership is confirmed, so Europe PMC's PDF for the
				// same record is fair game as a fallback route.
				let epmc = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextPDF`;
				let bytes = await this.downloadPDF(epmc);
				if (bytes) {
					return { status: "found", bytes, source: epmc,
						license: oa.license || "", oaStatus };
				}
				sawError = true;
				reason = join(reason, `in the PMC OA subset (${pmcid}) but PDF download failed`);
			}
		}

		return { status: sawError ? "check" : "missing", reason, oaStatus };
	},

	async attachPDF(item, bytes, sourceURL) {
		let fname = "fullvahti-" + item.key + ".pdf";
		let path = PathUtils.join(Zotero.getTempDirectory().path, fname);
		await IOUtils.write(path, bytes);
		try {
			let att = await Zotero.Attachments.importFromFile({
				file: Zotero.File.pathToFile(path),
				parentItemID: item.id,
				title: "Full Text PDF (open access)",
				contentType: "application/pdf",
			});
			if (att && sourceURL) {
				try {
					att.setField("url", sourceURL);
					await att.saveTx();
				}
				catch (e) { /* provenance is nice-to-have */ }
			}
		}
		finally {
			try { await IOUtils.remove(path); } catch (e) { /* temp cleanup */ }
		}
	},

	async setStatusTag(item, tag) {
		for (let t of this.STATUS_TAGS) {
			if (t !== tag) item.removeTag(t);
		}
		item.addTag(tag);
		await item.saveTx();
	},

	// Citation fields used to build an OpenURL link to a library resolver. Each
	// getField is guarded — fields vary by item type — so this never throws.
	citationFields(item) {
		let g = (f) => { try { return (item.getField(f) || "").trim(); } catch (e) { return ""; } };
		let year = "";
		let m = g("date").match(/\d{4}/);
		if (m) year = m[0];
		let firstAuthor = "";
		try {
			let creators = item.getCreators ? item.getCreators() : [];
			if (creators && creators.length) firstAuthor = creators[0].lastName || creators[0].name || "";
		}
		catch (e) { /* creators optional */ }
		return {
			journal: g("publicationTitle"),
			year,
			volume: g("volume"),
			issue: g("issue"),
			pages: g("pages"),
			issn: g("ISSN"),
			firstAuthor,
		};
	},

	// Pure: build a standards-compliant OpenURL 1.0 (Z39.88) link to a library's
	// resolver so a paywalled-but-licensed item is one human click away. FullVahti
	// never fetches it — it only hands the citation to *your* library, which keeps
	// the OA-only stance intact and stays clear of publishers' bulk-download terms.
	// Returns "" when no resolver base is configured. Side-effect-free (testable).
	buildOpenURL(base, m) {
		base = (base || "").trim();
		if (!base) return "";
		m = m || {};
		let parts = [];
		let add = (k, v) => { if (v) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); };
		add("ctx_ver", "Z39.88-2004");
		add("rft_val_fmt", "info:ofi/fmt:kev:mtx:journal");
		add("rfr_id", "info:sid/fullvahti");
		add("rft.genre", "article");
		add("rft.atitle", m.title);
		add("rft.jtitle", m.journal);
		add("rft.issn", m.issn);
		add("rft.date", m.year);
		add("rft.volume", m.volume);
		add("rft.issue", m.issue);
		add("rft.pages", m.pages);
		add("rft.aulast", m.firstAuthor);
		add("rft_id", m.doi ? "info:doi/" + m.doi : "");
		add("rft_id", m.pmid ? "info:pmid/" + m.pmid : "");
		let sep = base.includes("?") ? "&" : "?";
		return base + sep + parts.join("&");
	},

	// -----------------------------------------------------------------
	// Run report: ONE standalone note per run (never per-item notes).
	// The "not found + why" list feeds ILL requests and PRISMA counts.
	// -----------------------------------------------------------------
	async writeReportNote(rows, counts) {
		let esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		let when = new Date().toLocaleString();
		// Duplicates were tagged to match their original; don't repeat them in the
		// actionable lists below (they're the same paper, already counted once).
		let problems = rows.filter(r => r.status !== "found" && !r.duplicate);
		let dupes = rows.filter(r => r.duplicate);
		let resolver = (this.getPref("openURLResolver") || "").trim();

		let html = `<h1>FullVahti report — ${esc(when)}</h1>`
			+ `<p><strong>${counts.found}</strong> PDF(s) attached · `
			+ `<strong>${counts.missing}</strong> with no open-access copy · `
			+ `<strong>${counts.check}</strong> needing a manual look.</p>`
			+ `<p>Open access only — paywalled items are listed below for interlibrary loan, `
			+ `not bypassed. Items are tagged fulltext:pdf-found / pdf-missing / check-needed.</p>`;
		if (resolver) {
			html += `<p>Each item below has a “Find in my library” link — that goes to your `
				+ `library’s resolver so you can fetch a licensed copy yourself. FullVahti `
				+ `does not download paywalled PDFs; the link just hands the citation to your library.</p>`;
		}
		if (dupes.length) {
			html += `<p>${dupes.length} duplicate item(s) were tagged to match the original `
				+ `and omitted from the lists below.</p>`;
		}

		if (problems.length) {
			html += "<h2>Still to get (" + problems.length + ")</h2><ul>";
			for (let r of problems) {
				let id = r.doi
					? `<a href="https://doi.org/${esc(r.doi)}">doi:${esc(r.doi)}</a>`
					: (r.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(r.pmid)}/">PMID ${esc(r.pmid)}</a>` : "no identifier");
				let lib = "";
				if (resolver) {
					let u = this.buildOpenURL(resolver, {
						title: r.title, journal: r.journal, year: r.year, volume: r.volume,
						issue: r.issue, pages: r.pages, issn: r.issn, firstAuthor: r.firstAuthor,
						doi: r.doi, pmid: r.pmid,
					});
					if (u) lib = ` — <a href="${esc(u)}">Find in my library</a>`;
				}
				html += `<li>${esc(r.title)} — ${id} — <em>${esc(r.reason || r.status)}</em>${lib}</li>`;
			}
			html += "</ul>";
		}
		let found = rows.filter(r => r.status === "found" && !r.duplicate);
		if (found.length) {
			// Show the license when known; otherwise the OA status (a color like
			// "gold"/"green"), clearly labelled so the two aren't conflated.
			let annot = r => r.license ? esc(r.license)
				: (r.oaStatus ? "OA: " + esc(r.oaStatus) : "");
			let line = r => esc(r.title) + (annot(r) ? ` <em>(${annot(r)})</em>` : "");
			html += `<p>Attached: ${found.map(line).join(" · ")}</p>`;
		}

		let note = new Zotero.Item("note");
		note.libraryID = Zotero.Libraries.userLibraryID;
		note.setNote(html);
		note.addTag("fullvahti:report");
		await note.saveTx();
	},

	tagAllowed(tag) {
		return this.ALLOWED_TAG_PREFIXES.some(p => String(tag).startsWith(p));
	},

	// Current tags on an item as a plain string array. Zotero's getTags() yields
	// [{tag, type}]; tolerate a plain-string variant too (and any read failure).
	itemTags(item) {
		try {
			return (item.getTags() || []).map(t => (typeof t === "string" ? t : t.tag));
		}
		catch (e) {
			return [];
		}
	},

	// Compute the change a tag request would actually make against current tags:
	// adds already present and removes already absent are no-ops and dropped, so
	// the recorded effect is exactly what changed — which is also what undo reverses.
	planTagChange(item, addReq, removeReq) {
		let before = this.itemTags(item);
		let beforeSet = new Set(before);
		let add = (addReq || []).map(String);
		let remove = (removeReq || []).map(String);
		let willAdd = add.filter(t => !beforeSet.has(t));
		let willRemove = remove.filter(t => beforeSet.has(t));
		let after = before.filter(t => !willRemove.includes(t)).concat(willAdd);
		return {
			itemKey: item.key,
			before,
			after,
			willAdd,
			willRemove,
			alreadyPresent: add.filter(t => beforeSet.has(t)),
			alreadyAbsent: remove.filter(t => !beforeSet.has(t)),
		};
	},

	// -----------------------------------------------------------------
	// Audit log — every applied writeback is recorded so it is auditable
	// and undoable. Stored as a bounded JSON array in a local pref.
	// -----------------------------------------------------------------
	readAudit() {
		let raw = this.getPref(this.AUDIT_PREF);
		if (!raw) return [];
		try {
			let v = JSON.parse(raw);
			return Array.isArray(v) ? v : [];
		}
		catch (e) {
			this.log("audit log unreadable, starting fresh: " + e);
			return [];
		}
	},

	writeAudit(log) {
		if (log.length > this.AUDIT_MAX) log = log.slice(log.length - this.AUDIT_MAX);
		this.setPref(this.AUDIT_PREF, JSON.stringify(log));
	},

	newAuditId() {
		let rnd = Math.random().toString(36).slice(2, 8);
		return Date.now().toString(36) + "-" + rnd;
	},

	// Append an audit record and return it (with its generated id + timestamp).
	// The token is never stored — only what changed, and to which item.
	recordAudit(entry) {
		let rec = Object.assign({ id: this.newAuditId(), ts: new Date().toISOString() }, entry);
		let log = this.readAudit();
		log.push(rec);
		this.writeAudit(log);
		this.log("writeback audit " + rec.id + ": " + rec.itemKey
			+ " +[" + (rec.added || []).join(",") + "] -[" + (rec.removed || []).join(",") + "]"
			+ (rec.undoOf ? " (undo of " + rec.undoOf + ")" : ""));
		return rec;
	},

	// Pure: render the audit log as a plain-text summary for a dialog. Newest first,
	// most recent `limit` shown. Side-effect-free so it can be unit-tested.
	formatAuditLog(log, limit) {
		if (!log || !log.length) return "No CiteVahti write-backs have been recorded yet.";
		let n = limit || 30;
		let shown = log.slice(-n).reverse();
		let lines = shown.map(r => {
			let parts = [];
			if (r.added && r.added.length) parts.push("+" + r.added.join(" +"));
			if (r.removed && r.removed.length) parts.push("−" + r.removed.join(" −"));
			let what = parts.join("  ") || "(no effective change)";
			let prefix = r.undone ? "[undone] " : (r.undoOf ? "[undo] " : "");
			return `${r.ts}  ${prefix}${r.itemKey}: ${what}`;
		});
		let header = `${log.length} write-back(s) recorded`
			+ (log.length > shown.length ? ` — showing the most recent ${shown.length}:` : ":");
		return header + "\n\n" + lines.join("\n");
	},

	showAuditLog(window) {
		let log = this.readAudit();
		let text = this.formatAuditLog(log, 30);
		if (!log.length) {
			window.alert("FullVahti — CiteVahti write-back audit log\n\n" + text);
			return;
		}
		// Offer to clear so the log can't accrete indefinitely; clearing is itself
		// a deliberate, confirmed user action (never automatic).
		let clear = Services.prompt.confirmEx(
			window,
			"FullVahti — CiteVahti write-back audit log",
			text,
			Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
				+ Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING,
			"Close", "Clear log…", null, null, {}
		);
		if (clear === 1) {
			let ok = Services.prompt.confirm(
				window,
				"FullVahti",
				"Clear the entire write-back audit log? This only deletes the history "
				+ "record — it does not change any tags already written to your library."
			);
			if (ok) {
				this.setPref(this.AUDIT_PREF, "");
				this.log("audit log cleared by user");
			}
		}
	},

	// -----------------------------------------------------------------
	// WriteVahti — gated local writeback endpoint for CiteVahti.
	// Default OFF. Local server only (127.0.0.1:23119). Token required.
	//
	// The safety invariant (no silent Zotero writes) is enforced here, not by
	// the caller: a write is only applied when writeback is enabled AND the token
	// matches AND every tag is in the allowlist. Callers preview first with
	// dryRun:true (nothing is written), and any applied write is recorded to the
	// audit log and reversible through /fullvahti/undo.
	// -----------------------------------------------------------------
	tokenOK(data) {
		let token = this.getPref("writebackToken");
		return !!token && data && data.token === token;
	},

	registerEndpoints() {
		let self = this;
		let deny = (code, error) => [code, "application/json", JSON.stringify({ ok: false, error })];

		function Ping() {}
		Ping.prototype = {
			supportedMethods: ["GET"],
			// MUST be async: in Zotero 9 a synchronous init() that returns an array
			// never responds (the request hangs forever), while an async init
			// resolves correctly. The /fullvahti/tag handler is already async — match it.
			init: async function () {
				return [200, "application/json", JSON.stringify({
					plugin: "fullvahti",
					version: self.version,
					writeback: !!self.getPref("writebackEnabled"),
					// Let CiteVahti detect the safety features it can rely on.
					capabilities: { dryRun: true, audit: true, undo: true },
					allowedTagPrefixes: self.ALLOWED_TAG_PREFIXES,
					endpoints: ["/fullvahti/ping", "/fullvahti/tag", "/fullvahti/audit", "/fullvahti/undo"],
				})];
			},
		};
		Zotero.Server.Endpoints["/fullvahti/ping"] = Ping;

		function Tag() {}
		Tag.prototype = {
			supportedMethods: ["POST"],
			supportedDataTypes: ["application/json"],
			permitBookmarklet: false,
			init: async function (requestData) {
				if (!self.getPref("writebackEnabled")) {
					return deny(403, "writeback disabled — enable it in Zotero Settings → FullVahti");
				}
				let data = requestData.data || {};
				if (!self.tokenOK(data)) {
					return deny(403, "missing or wrong token — copy it from Zotero Settings → FullVahti");
				}
				if (!data.itemKey || (!Array.isArray(data.add) && !Array.isArray(data.remove))) {
					return deny(400, "expected { token, itemKey, add: [tags] and/or remove: [tags], dryRun?: bool }");
				}
				// Only Vahtian-namespace tags may be written, even with a valid token.
				let bad = [...(data.add || []), ...(data.remove || [])]
					.map(String)
					.filter(t => !self.tagAllowed(t));
				if (bad.length) {
					return deny(400, "tags must use an allowed Vahtian prefix ("
						+ self.ALLOWED_TAG_PREFIXES.join(", ") + "); rejected: " + bad.join(", "));
				}
				let item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, data.itemKey);
				if (!item) {
					return deny(404, "no item with key " + data.itemKey);
				}

				let plan = self.planTagChange(item, data.add, data.remove);

				// Preview only — nothing is written. This is how a caller (and through
				// it, the user) confirms a change before it touches the library.
				if (data.dryRun) {
					return [200, "application/json", JSON.stringify({ ok: true, dryRun: true, preview: plan })];
				}

				for (let t of plan.willRemove) item.removeTag(t);
				for (let t of plan.willAdd) item.addTag(t);
				await item.saveTx();

				let audit = self.recordAudit({
					itemKey: data.itemKey,
					added: plan.willAdd,
					removed: plan.willRemove,
					before: plan.before,
					note: typeof data.note === "string" ? data.note.slice(0, 500) : undefined,
				});
				return [200, "application/json", JSON.stringify({
					ok: true,
					itemKey: data.itemKey,
					applied: { added: plan.willAdd, removed: plan.willRemove },
					audit: { id: audit.id, ts: audit.ts },
				})];
			},
		};
		Zotero.Server.Endpoints["/fullvahti/tag"] = Tag;

		function Audit() {}
		Audit.prototype = {
			supportedMethods: ["GET"],
			init: async function (requestData) {
				if (!self.getPref("writebackEnabled")) {
					return deny(403, "writeback disabled — enable it in Zotero Settings → FullVahti");
				}
				// The audit log lists item keys and review decisions, so it is
				// token-gated like writes. Token comes via the query string.
				let q = (requestData && requestData.query) || {};
				let provided = typeof q === "string" ? new URLSearchParams(q).get("token") : q.token;
				if (!self.tokenOK({ token: provided })) {
					return deny(403, "missing or wrong token");
				}
				let log = self.readAudit();
				let limit = 100;
				if (typeof q === "object" && q.limit) {
					let n = parseInt(q.limit, 10);
					if (n > 0) limit = Math.min(n, self.AUDIT_MAX);
				}
				return [200, "application/json", JSON.stringify({
					ok: true,
					count: log.length,
					records: log.slice(-limit),
				})];
			},
		};
		Zotero.Server.Endpoints["/fullvahti/audit"] = Audit;

		function Undo() {}
		Undo.prototype = {
			supportedMethods: ["POST"],
			supportedDataTypes: ["application/json"],
			permitBookmarklet: false,
			init: async function (requestData) {
				if (!self.getPref("writebackEnabled")) {
					return deny(403, "writeback disabled — enable it in Zotero Settings → FullVahti");
				}
				let data = requestData.data || {};
				if (!self.tokenOK(data)) {
					return deny(403, "missing or wrong token");
				}
				if (!data.auditId) {
					return deny(400, "expected { token, auditId, dryRun?: bool }");
				}
				let log = self.readAudit();
				let rec = log.find(r => r.id === data.auditId);
				if (!rec) return deny(404, "no audit record " + data.auditId);
				if (rec.undoOf) return deny(400, "record " + data.auditId + " is itself an undo — undo the original instead");
				if (rec.undone) return deny(409, "record " + data.auditId + " was already undone");

				let item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, rec.itemKey);
				if (!item) return deny(404, "item " + rec.itemKey + " no longer exists");

				// Reverse the recorded effect: re-add what was removed, remove what
				// was added — but only where it still applies, so undo is idempotent
				// against later manual edits.
				let plan = self.planTagChange(item, rec.removed, rec.added);

				if (data.dryRun) {
					return [200, "application/json", JSON.stringify({
						ok: true, dryRun: true, undoOf: rec.id, preview: plan,
					})];
				}

				for (let t of plan.willRemove) item.removeTag(t);
				for (let t of plan.willAdd) item.addTag(t);
				await item.saveTx();

				// Mark the original undone, then record the reversal as its own entry.
				rec.undone = true;
				self.writeAudit(log);
				let audit = self.recordAudit({
					itemKey: rec.itemKey,
					added: plan.willAdd,
					removed: plan.willRemove,
					before: plan.before,
					undoOf: rec.id,
				});
				return [200, "application/json", JSON.stringify({
					ok: true,
					itemKey: rec.itemKey,
					undoOf: rec.id,
					applied: { added: plan.willAdd, removed: plan.willRemove },
					audit: { id: audit.id, ts: audit.ts },
				})];
			},
		};
		Zotero.Server.Endpoints["/fullvahti/undo"] = Undo;
	},

	unregisterEndpoints() {
		delete Zotero.Server.Endpoints["/fullvahti/ping"];
		delete Zotero.Server.Endpoints["/fullvahti/tag"];
		delete Zotero.Server.Endpoints["/fullvahti/audit"];
		delete Zotero.Server.Endpoints["/fullvahti/undo"];
	},
};
