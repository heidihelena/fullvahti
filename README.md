# FullVahti

**Find open-access full-text PDFs for your Zotero references — in two clicks, with a tidy report of what's still missing.**

FullVahti is a [Zotero](https://www.zotero.org) plugin from the [Vahtian](https://vahtian.com) tool family. You select references (or tag them), FullVahti looks each one up on [Unpaywall](https://unpaywall.org) and [PubMed Central](https://pmc.ncbi.nlm.nih.gov), attaches the free, legal PDF when one exists, and labels every item with what happened:

| Tag | Meaning |
|---|---|
| `fulltext:pdf-found` | PDF attached (or one was already there) |
| `fulltext:pdf-missing` | No open-access copy exists — request it via your library |
| `fulltext:check-needed` | Something went wrong or no DOI/PMID — worth a human look |

After each run you also get **one** report note in your library (tagged `fullvahti:report`) listing everything *not* found and why — exactly the list you need for interlibrary loan requests or a PRISMA flow diagram. FullVahti never creates per-item notes: the attached PDF is its own record.

**Open access only.** FullVahti never bypasses a paywall. Paywalled papers are honestly reported as missing. PubMed Central downloads are restricted to the [PMC Open Access Subset](https://pmc.ncbi.nlm.nih.gov/tools/openftlist/) via its official OA service — articles that are merely *readable* in PMC are reported for your library to request, not scraped. The report records the license of every PDF it attaches.

## Install (no technical skills needed)

1. Download `fullvahti-x.y.z.xpi` from the [latest release](https://github.com/heidihelena/fullvahti/releases/latest) — right-click the file and choose **Save Link As…** if your browser tries to open it.
2. In Zotero: **Tools → Plugins**, click the gear ⚙️ in the top-right, choose **Install Plugin From File…**, and pick the downloaded file.
3. That's it. Updates install themselves.

## Use

- **For a few papers:** select them in your library, right-click → **FullVahti: Find Open-Access PDFs**.
- **For a whole screening batch:** tag the references `cite:closer-look` (or your own tag — change it in Settings → FullVahti), then **Tools → FullVahti: Find OA PDFs for tagged items**.

The first run asks for your email once — Unpaywall and PubMed Central are free services that ask for a contact address. It is sent only to them, never to us.

FullVahti works politely, one paper at a time, so a big batch takes a few minutes. You can keep using Zotero meanwhile.

## Check for retractions

A retracted paper is exactly what a screening workflow must catch. FullVahti can flag references that PubMed records as retracted:

- **For a few papers:** select them, right-click → **FullVahti: Check for Retractions**.
- **For a batch:** tag them and use **Settings → FullVahti → Check tagged items for retractions**, or **Tools → FullVahti: Check items tagged … for retractions**.

Every item is labelled, and you get a report note that calls out the retracted ones:

| Tag | Meaning |
|---|---|
| `retraction:retracted` | PubMed lists this as a Retracted Publication |
| `retraction:none` | No retraction recorded in PubMed |
| `retraction:check-needed` | No PubMed record found, or the lookup failed — worth a human look |

FullVahti only *reads* the status from PubMed — it never decides retraction itself.

## Getting paywalled papers through your library

FullVahti only ever downloads open-access copies — it never fetches paywalled PDFs, even on your university network, because automated downloading through institutional credentials can trip publishers' "systematic download" terms and get your *whole institution's* access cut off.

Instead, it can hand the citation to your library. In **Settings → FullVahti**, paste your library's **OpenURL resolver** address. After that, every item with no open-access copy gets a **"Find in my library"** link in the report note — one click takes you to your library's resolver, where you fetch the licensed copy yourself. FullVahti does no paywalled downloading; it just builds the link.

(Your library's resolver URL is usually on its website under "link resolver", "OpenURL", "SFX", or "find it" — ask a librarian if unsure.)

## For CiteVahti users (advanced, off by default)

FullVahti is [CiteVahti](https://vahtian.com)'s Zotero companion. It does the Zotero-side work CiteVahti deliberately stays out of — finding open-access PDFs, and writing **confirmed** review decisions back into your library — while CiteVahti keeps sole ownership of claim verification and the human-first rating workflow. FullVahti never verifies claims, never decides whether a paper supports a claim, never rates anything, and never receives manuscript text: it only ever sees an item key and a short list of allowlisted tags.

Write-back goes through a token-guarded endpoint on Zotero's local server (`127.0.0.1:23119` — nothing leaves your machine):

1. Zotero → Settings → FullVahti → tick **Allow CiteVahti to write tags**, click **Generate new token**.
2. Give that token to CiteVahti.

### The safety invariant: no silent Zotero writes

Every write is **previewed, confirmed, audited, and undoable**. The door is closed unless you open it, only allowlisted tags can be written, and the endpoints enforce this regardless of what a caller sends:

| Endpoint | Method | Purpose |
|---|---|---|
| `/fullvahti/ping` | GET | Availability + advertised `capabilities` and `allowedTagPrefixes` |
| `/fullvahti/tag` | POST | Preview or apply a tag change |
| `/fullvahti/audit` | GET | List recorded writes (token in query string) |
| `/fullvahti/undo` | POST | Reverse a recorded write by its audit id |

**Allowlisted tags only.** Even with a valid token, only tags beginning `cite:`, `fulltext:`, `GRADE:`, `RoB2:`, `ROBINS-I:`, or `Quality:` are accepted; anything else is refused and nothing is written.

**1 — Preview (dry run).** CiteVahti shows you exactly what would change before anything is written:

```
POST /fullvahti/tag
{ "token": "…", "itemKey": "ABCD1234", "add": ["GRADE:high"], "remove": ["fulltext:pdf-missing"], "dryRun": true }
→ { "ok": true, "dryRun": true,
    "preview": { "before": [...], "after": [...], "willAdd": ["GRADE:high"], "willRemove": ["fulltext:pdf-missing"],
                 "alreadyPresent": [], "alreadyAbsent": [] } }
```

`willAdd` / `willRemove` are the *effective* change — tags already present (or already absent) are dropped, so the preview is exactly what will happen.

**2 — Apply (after you confirm).** Same call without `dryRun`. The response returns what was applied and an audit id:

```
→ { "ok": true, "itemKey": "ABCD1234", "applied": { "added": ["GRADE:high"], "removed": ["fulltext:pdf-missing"] },
    "audit": { "id": "abc-123", "ts": "2026-06-24T…" } }
```

**3 — Audit.** Every applied write is recorded locally (the token is never stored). CiteVahti can read it with `GET /fullvahti/audit?token=…`, and you can read it yourself — no token, no curl — via **Tools → FullVahti: Show CiteVahti write-back audit log**, which also lets you clear the history (clearing never changes tags already written).

**4 — Undo.** Any recorded write can be reversed by its audit id (preview the reversal with `dryRun: true` first):

```
POST /fullvahti/undo
{ "token": "…", "auditId": "abc-123" }
→ { "ok": true, "undoOf": "abc-123", "applied": { "added": ["fulltext:pdf-missing"], "removed": ["GRADE:high"] }, … }
```

CiteVahti's job is to obtain *your* confirmation for each verified decision; FullVahti's job is to make that write previewable, auditable, and reversible. Neither side bypasses the other.

## Privacy

- Lookups go directly from your computer to Unpaywall and NCBI/Europe PMC, carrying the paper's DOI/PMID; your contact email goes only to the APIs that ask for it (Unpaywall, NCBI), never to the sites PDFs are downloaded from. Nothing else, to no one else.
- No analytics, no accounts, no Vahtian servers involved.

## Development

Plain JavaScript, no build step — the plugin **is** the repository. To make an `.xpi` by hand: zip the files with `manifest.json` at the zip root. Releases are built automatically by GitHub Actions when a `v*` tag is pushed.

Compatibility: Zotero 7–9. When a new Zotero major lands, bump `strict_max_version` in [manifest.json](manifest.json) and re-release.

## License

[Apache 2.0](LICENSE) © Heidi Andersén / Vahtian
