---
name: fullvahti-for-agents
description: >-
  How an LLM agent (e.g. CiteVahti) integrates with FullVahti's local Zotero
  write-back API — the token-guarded /fullvahti/ping, /tag, /audit, /undo
  endpoints and the previewed → confirmed → audited → undoable safety contract.
  Use when building or debugging an agent that writes review tags into a user's
  Zotero library through FullVahti, or that relies on FullVahti to fetch
  open-access PDFs / flag retractions.
---

# Using FullVahti from an LLM agent

FullVahti is a Zotero plugin and CiteVahti's **Zotero-side companion**. It does
the library work an agent must not do directly, and it is the *only* sanctioned
door for writing review decisions into Zotero.

## What FullVahti does (and what it refuses)
- **Does:** find & attach free, legal open-access PDFs; flag retractions
  (PubMed + Crossref/Retraction Watch); read-only citation-metadata checks; and
  apply **allowlisted tags** to existing items via a local, token-guarded HTTP
  endpoint.
- **Refuses (by design):** claim verification, deciding whether a paper supports
  a claim, AI ratings, bypassing the human-first workflow. It never receives
  manuscript text — only an **item key and a short list of allowlisted tags**.

## The safety invariant — no silent Zotero writes
Every write is **previewed, confirmed, audited, and undoable**. The endpoints
enforce this regardless of what a caller sends. The door is closed unless the
user opens it (Settings → FullVahti → enable + generate token).

## Endpoints (`http://127.0.0.1:23119`, local only)

### `GET /fullvahti/ping` — discover availability & capabilities
```json
{ "plugin": "fullvahti", "version": "0.1.19", "writeback": true,
  "capabilities": { "dryRun": true, "audit": true, "undo": true },
  "allowedTagPrefixes": ["cite:","fulltext:","retraction:","citation:","GRADE:","RoB2:","ROBINS-I:","Quality:"],
  "endpoints": ["/fullvahti/ping","/fullvahti/tag","/fullvahti/audit","/fullvahti/undo"] }
```
No token required. `writeback:false` ⇒ the user hasn't enabled it; stop and ask them to.

### `POST /fullvahti/tag` — preview or apply a tag change
Body: `{ token, itemKey, add?: [tags], remove?: [tags], dryRun?: bool, note?: string }`

- Requires writeback enabled **and** the matching `token`.
- Only tags starting with an allowlisted prefix are accepted; anything else →
  `400` and **nothing is written**.
- **Always `dryRun:true` first** and show the user the exact effect, then call
  again without `dryRun` only after they confirm.

Preview response:
```json
{ "ok": true, "dryRun": true,
  "preview": { "before":[…], "after":[…], "willAdd":["GRADE:high"], "willRemove":["fulltext:pdf-missing"],
               "alreadyPresent":[], "alreadyAbsent":[] } }
```
`willAdd`/`willRemove` are the *effective* change (no-ops dropped). Apply response:
```json
{ "ok": true, "itemKey": "ABCD1234",
  "applied": { "added":["GRADE:high"], "removed":["fulltext:pdf-missing"] },
  "audit": { "id": "abc-123", "ts": "2026-…" } }
```
Keep the `audit.id` — it's the undo handle.

### `GET /fullvahti/audit?token=…&limit=N` — read the write history
`{ ok, count, records:[{ id, ts, itemKey, added, removed, before, undone?, undoOf? }] }`.
The token is never stored in the log.

### `POST /fullvahti/undo` — reverse a recorded write
Body: `{ token, auditId, dryRun?: bool }`. Re-adds what was removed and removes
what was added (idempotent against later manual edits). Double-undo → `409`;
undo-of-an-undo → `400`. Preview with `dryRun:true` first.

## Error codes
`403` writeback disabled / wrong token · `400` malformed body or non-allowlisted
tag · `404` unknown item or audit id · `409` already undone.

## Canonical flow for an agent
1. `GET /ping` → confirm `writeback` + needed `capabilities`/`allowedTagPrefixes`.
2. Obtain the user's decision for an item (your job, not FullVahti's).
3. `POST /tag` with `dryRun:true` → show the user the preview.
4. On user confirmation → `POST /tag` without `dryRun` → keep `audit.id`.
5. Offer undo via `POST /undo {auditId}` (or surface `GET /audit`).

## Hard rules for the integrating agent
- Send **only** an `itemKey` and allowlisted tags — **never manuscript text** or
  free-form notes containing claim content.
- Never write without an explicit user confirmation step.
- Don't try to make FullVahti rate, verify, or judge support — it won't, and
  that boundary is the point.
- No telemetry; everything stays on `127.0.0.1`.
