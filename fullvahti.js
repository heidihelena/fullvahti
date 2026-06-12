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
 * Write: a token-guarded endpoint on Zotero's local server so CiteVahti's gated,
 * audited writeback can add/remove tags. Default OFF. No silent writes.
 *
 * Stance (shared with the Vahtian spine): open access only — paywalled items are
 * reported as missing, never bypassed. Polite pacing. Everything stays local.
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
	// A real OA article PDF is essentially always larger than this; smaller "PDFs"
	// are almost always publisher error/landing stubs, so we reject them (-> check).
	MIN_PDF_BYTES: 10000,
	HTTP_TIMEOUT: 30000,

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
		let seen = new Set();

		try {
			for (let i = 0; i < items.length; i++) {
				let item = items[i];
				let title = (item.getField("title") || "(untitled)").substring(0, 70);
				progress.setText(`${i + 1}/${items.length}  ${title}`);
				progress.setProgress(Math.round((i / items.length) * 100));

				let doi = this.extractDOI(item);
				let pmid = this.extractPMID(item);
				let dedup = doi || pmid || item.key;
				if (seen.has(dedup)) continue; // collapse duplicate items
				seen.add(dedup);

				let row = { key: item.key, title, doi: doi || "", pmid: pmid || "", status: "", reason: "", source: "" };
				try {
					if (this.hasPDF(item)) {
						row.status = "found";
						row.reason = "already had a PDF attachment";
					}
					else if (!doi && !pmid) {
						row.status = "check";
						row.reason = "no DOI or PMID on the item";
					}
					else {
						let res = await this.resolveOA(doi, pmid, email);
						row.status = res.status;
						row.reason = res.reason || "";
						row.source = res.source || "";
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
	// Identifier extraction (ported from vahtian_fulltext.py)
	// -----------------------------------------------------------------
	normalizeDOI(doi) {
		doi = (doi || "").trim()
			.replace(/^doi:\s*/i, "")
			.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
		doi = doi.split(/\s/)[0] || "";
		doi = doi.replace(/[.,;:)>\]}"']+$/, "");
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
		let m = extra.match(/\bPMID:?\s*(\d+)/);
		return m ? m[1] : null;
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
	async fetchJSON(url) {
		let xhr = await Zotero.HTTP.request("GET", url, {
			responseType: "json",
			timeout: this.HTTP_TIMEOUT,
			successCodes: false, // resolve on any status; we inspect it ourselves
		});
		return xhr;
	},

	async downloadPDF(url) {
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
		// %PDF-
		let isPDF = bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50
			&& bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
		if (!isPDF) {
			this.log("not a PDF: " + url);
			return null;
		}
		if (bytes.length < this.MIN_PDF_BYTES) {
			this.log("PDF too small (" + bytes.length + " bytes), likely an error stub: " + url);
			return null;
		}
		return bytes;
	},

	/**
	 * Try DOI (Unpaywall) then PMID (PMC / Europe PMC).
	 * Returns { status: found|missing|check, bytes?, source?, reason? }.
	 */
	async resolveOA(doi, pmid, email) {
		let sawError = false;
		let reason = "";

		if (doi) {
			try {
				let xhr = await this.fetchJSON(
					"https://api.unpaywall.org/v2/" + encodeURIComponent(doi)
					+ "?email=" + encodeURIComponent(email)
				);
				if (xhr.status === 200 && xhr.response) {
					if (!xhr.response.is_oa) {
						reason = "Unpaywall: no open-access copy known";
					}
					else {
						let pdfURL = (xhr.response.best_oa_location || {}).url_for_pdf;
						if (pdfURL) {
							let bytes = await this.downloadPDF(pdfURL);
							if (bytes) return { status: "found", bytes, source: pdfURL };
							sawError = true;
							reason = "Unpaywall had a PDF link but the download failed";
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

		if (pmid) {
			let pmcid = null;
			try {
				let xhr = await this.fetchJSON(
					"https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=" + encodeURIComponent(pmid)
					+ "&format=json&tool=fullvahti&email=" + encodeURIComponent(email)
				);
				if (xhr.status === 200 && xhr.response && xhr.response.records) {
					for (let rec of xhr.response.records) {
						if (rec.pmcid) { pmcid = rec.pmcid; break; }
					}
				}
			}
			catch (e) {
				this.log("idconv error: " + e);
			}
			if (pmcid) {
				// Routes vary in coverage per article, so we fall through. All OA-only.
				let urls = [
					`https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`,
					`https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/`,
					`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextPDF`,
					`https://europepmc.org/articles/${pmcid}?pdf=render`,
				];
				for (let url of urls) {
					let bytes = await this.downloadPDF(url);
					if (bytes) return { status: "found", bytes, source: url };
				}
				sawError = true;
				reason = (reason ? reason + "; " : "") + `in PMC (${pmcid}) but the PDF routes failed`;
			}
			else if (!reason) {
				reason = "PMID has no PubMed Central record";
			}
		}

		return { status: sawError ? "check" : "missing", reason };
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

	// -----------------------------------------------------------------
	// Run report: ONE standalone note per run (never per-item notes).
	// The "not found + why" list feeds ILL requests and PRISMA counts.
	// -----------------------------------------------------------------
	async writeReportNote(rows, counts) {
		let esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		let when = new Date().toLocaleString();
		let problems = rows.filter(r => r.status !== "found");

		let html = `<h1>FullVahti report — ${esc(when)}</h1>`
			+ `<p><strong>${counts.found}</strong> PDF(s) attached · `
			+ `<strong>${counts.missing}</strong> with no open-access copy · `
			+ `<strong>${counts.check}</strong> needing a manual look.</p>`
			+ `<p>Open access only — paywalled items are listed below for interlibrary loan, `
			+ `not bypassed. Items are tagged fulltext:pdf-found / pdf-missing / check-needed.</p>`;

		if (problems.length) {
			html += "<h2>Still to get (" + problems.length + ")</h2><ul>";
			for (let r of problems) {
				let id = r.doi
					? `<a href="https://doi.org/${esc(r.doi)}">doi:${esc(r.doi)}</a>`
					: (r.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(r.pmid)}/">PMID ${esc(r.pmid)}</a>` : "no identifier");
				html += `<li>${esc(r.title)} — ${id} — <em>${esc(r.reason || r.status)}</em></li>`;
			}
			html += "</ul>";
		}
		let found = rows.filter(r => r.status === "found");
		if (found.length) {
			html += `<p>Attached: ${found.map(r => esc(r.title)).join(" · ")}</p>`;
		}

		let note = new Zotero.Item("note");
		note.libraryID = Zotero.Libraries.userLibraryID;
		note.setNote(html);
		note.addTag("fullvahti:report");
		await note.saveTx();
	},

	// -----------------------------------------------------------------
	// WriteVahti — gated local writeback endpoint for CiteVahti.
	// Default OFF. Local server only (127.0.0.1:23119). Token required.
	// -----------------------------------------------------------------
	registerEndpoints() {
		let self = this;

		function Ping() {}
		Ping.prototype = {
			supportedMethods: ["GET"],
			init: function () {
				return [200, "application/json", JSON.stringify({
					plugin: "fullvahti",
					version: self.version,
					writeback: !!self.getPref("writebackEnabled"),
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
				let deny = (code, error) => [code, "application/json", JSON.stringify({ ok: false, error })];
				if (!self.getPref("writebackEnabled")) {
					return deny(403, "writeback disabled — enable it in Zotero Settings → FullVahti");
				}
				let token = self.getPref("writebackToken");
				let data = requestData.data || {};
				if (!token || data.token !== token) {
					return deny(403, "missing or wrong token — copy it from Zotero Settings → FullVahti");
				}
				if (!data.itemKey || (!Array.isArray(data.add) && !Array.isArray(data.remove))) {
					return deny(400, "expected { token, itemKey, add: [tags] and/or remove: [tags] }");
				}
				let item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, data.itemKey);
				if (!item) {
					return deny(404, "no item with key " + data.itemKey);
				}
				for (let t of (data.remove || [])) item.removeTag(String(t));
				for (let t of (data.add || [])) item.addTag(String(t));
				await item.saveTx();
				self.log("writeback: " + data.itemKey
					+ " +[" + (data.add || []).join(",") + "] -[" + (data.remove || []).join(",") + "]");
				return [200, "application/json", JSON.stringify({ ok: true, itemKey: data.itemKey })];
			},
		};
		Zotero.Server.Endpoints["/fullvahti/tag"] = Tag;
	},

	unregisterEndpoints() {
		delete Zotero.Server.Endpoints["/fullvahti/ping"];
		delete Zotero.Server.Endpoints["/fullvahti/tag"];
	},
};
