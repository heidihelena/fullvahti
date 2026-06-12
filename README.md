# FullVahti

**Find open-access full-text PDFs for your Zotero references — in two clicks, legally, with a tidy report of what's still missing.**

FullVahti is a [Zotero](https://www.zotero.org) plugin from the [Vahtian](https://vahtian.com) tool family. You select references (or tag them), FullVahti looks each one up on [Unpaywall](https://unpaywall.org) and [PubMed Central](https://pmc.ncbi.nlm.nih.gov), attaches the free, legal PDF when one exists, and labels every item with what happened:

| Tag | Meaning |
|---|---|
| `fulltext:pdf-found` | PDF attached (or one was already there) |
| `fulltext:pdf-missing` | No open-access copy exists — request it via your library |
| `fulltext:check-needed` | Something went wrong or no DOI/PMID — worth a human look |

After each run you also get **one** report note in your library (tagged `fullvahti:report`) listing everything *not* found and why — exactly the list you need for interlibrary loan requests or a PRISMA flow diagram. FullVahti never creates per-item notes: the attached PDF is its own record.

**Open access only.** FullVahti never bypasses a paywall. Paywalled papers are honestly reported as missing.

## Install (no technical skills needed)

1. Download `fullvahti-x.y.z.xpi` from the [latest release](https://github.com/heidihelena/fullvahti/releases/latest) — right-click the file and choose **Save Link As…** if your browser tries to open it.
2. In Zotero: **Tools → Plugins**, click the gear ⚙️ in the top-right, choose **Install Plugin From File…**, and pick the downloaded file.
3. That's it. Updates install themselves.

## Use

- **For a few papers:** select them in your library, right-click → **FullVahti: Find Open-Access PDFs**.
- **For a whole screening batch:** tag the references `cite:closer-look` (or your own tag — change it in Settings → FullVahti), then **Tools → FullVahti: Find OA PDFs for tagged items**.

The first run asks for your email once — Unpaywall and PubMed Central are free services that ask for a contact address. It is sent only to them, never to us.

FullVahti works politely, one paper at a time, so a big batch takes a few minutes. You can keep using Zotero meanwhile.

## For CiteVahti users (advanced, off by default)

FullVahti can act as [CiteVahti](https://vahtian.com)'s local write-back door, so review-status tags land in your Zotero library through a token-guarded endpoint on Zotero's local server (`127.0.0.1:23119` — nothing leaves your machine):

1. Zotero → Settings → FullVahti → tick **Allow CiteVahti to write tags**, click **Generate new token**.
2. Give that token to CiteVahti. It can then `POST /fullvahti/tag` with `{ token, itemKey, add: [...], remove: [...] }`, and `GET /fullvahti/ping` to check availability.

No silent writes: the door is closed unless you open it, and only tag changes are possible.

## Privacy

- Lookups go directly from your computer to Unpaywall and NCBI/Europe PMC, carrying the paper's DOI/PMID and your contact email. Nothing else, to no one else.
- No analytics, no accounts, no Vahtian servers involved.

## Development

Plain JavaScript, no build step — the plugin **is** the repository. To make an `.xpi` by hand: zip the files with `manifest.json` at the zip root. Releases are built automatically by GitHub Actions when a `v*` tag is pushed.

Compatibility: Zotero 7–9. When a new Zotero major lands, bump `strict_max_version` in [manifest.json](manifest.json) and re-release.

## License

[MIT](LICENSE) © Heidi Andersén / Vahtian
