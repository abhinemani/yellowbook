# Architecture

Status: built (TypeScript, Next.js, SQLite) and tested against faked API responses; not yet run against the live API. Open decisions are in `HANDOFF.md`. Cost design is in `docs/COST.md`.

## What the app does

1. **Holds agencies and their contacts.** An agency (county, city, township) has many *seats*: Head of Purchasing, Head of Finance, Top Appointed Executive, and so on. Each seat has a current contact.
2. **Verifies any seat.** Pick roles, agencies and a scope (for example "Head of Finance, counties over 250k, not checked in 12 months"). The app asks Claude, with web search and page fetch turned on, whether each listed person still holds the seat. If not, it finds the current holder.
3. **Lets you add agencies and seats as you find them.** Search the database; if the agency is missing, look it up on the web, confirm, add it, then discover contacts for whichever roles you want.
4. **Keeps a human in the loop.** Findings land in a review queue. Accepting a replacement creates a new contact and supersedes the old one. History is never overwritten.
5. **Imports and exports Power Almanac CSVs** (all roles, one file or many).

## Components

```
CSV import ──► agencies / contacts / seats ◄── manual add / web lookup (find_agency)
                          │
        scope picker ─────┤
                          ▼
                   Verifier (prompts/verify_contact.md, discover_contact.md)
                   builds one request per seat ─► Claude API
                          │                       tools: web_search, web_fetch
                          │                       bulk: Message Batches   interactive: Messages
                          ▼
                   Validator  (schemas/check_result.schema.json + code rules)
                          ▼
                       checks (append-only) ─► Review queue ─► accept: new contact, old superseded, seat updated
                                                                │
                                                                └► Export CSV (Power Almanac columns + check columns)
```

- **Importer:** reads Power Almanac exports (see `docs/DATA_MODEL.md` for the parsing gotchas), creates agencies, contacts and seats. The `Role` column is multi-valued, so one contact can fill several seats.
- **Role registry:** `config/roles.json` seeds the `roles` table. Roles are data. Adding a position needs no migration, only a label, a definition (central vs departmental) and title hints.
- **Verifier:** for each seat builds a prompt from the templates in `prompts/`, runs it with a small per-seat budget (default 2 searches, 3 fetches), and stores the raw response for audit.
- **Validator:** JSON-schema validation plus rules enforced in code, not just in the prompt (below).
- **Review queue:** shows listed vs found side by side, the source link, confidence, and accept/reject. High-confidence confirmations can auto-accept; anything that changes a contact never does.
- **Exporter:** same columns as the Power Almanac files, plus the check columns (status, current name/title/email/phone, source URL, confidence, notes).

## Rules enforced in code (the model is not trusted to follow them)

| Rule | Enforcement |
|---|---|
| An email is only recorded if it was seen on a page | After the call, check that `found_email` appears verbatim in the text of a page the fetch tool returned, or in a citation excerpt. (Search results are encrypted and cannot be checked; PDFs arrive as base64 and are not searched.) If not, move it to `notes` as "Pattern guess (UNVERIFIED)" and null the field. |
| "High" confidence needs a dated 2025-or-later official source | Database CHECK (`confidence <> 'High' OR evidence_date IS NOT NULL`); validator also downgrades High to Medium if `evidence_date` is older than 2025-01-01, is in the future, or the source host is not the agency's own domain (or an agenda platform whose subdomain names the agency). |
| "Not searched" is different from "not found" | `unresolved_reason` is required for `unable_to_confirm` and `unclear`. A tool refusal sets `budget_exhausted` or `fetch_blocked`, which is eligible for automatic retry. A page that loads but names no staff is `no_staff_listed`. |
| Replacements must name someone | `replaced` with no `found_name` is downgraded to `vacant_interim` or `unclear`. |
| No personal matters in notes | Validator rejects notes that match a small deny-list (arrest, charged, lawsuit, divorce, and similar) and asks for a rewrite. |
| Generic mailboxes are labeled | `found_email_is_generic` is set by pattern (purchasing@, procurement@, info@, contact@, finance@...) as well as by the model. |
| An answer needs evidence | A confident result with no fetch or search behind it is discarded as `unable_to_confirm / not_searched`. A cited `source_url` the model never retrieved is dropped and confidence capped at Low. |
| Tool failures are not "not found" | If every tool call errored, the reason is rewritten to `fetch_blocked` or `budget_exhausted` whatever the model said. |
| Subordinates are not the head | A found title with assistant, associate, specialist, buyer and similar (or deputy, outside the deputy role) turns `replaced` into `unclear` and a confirmed holder into `role_mismatch`, at Low confidence. |
| A confirmation must match the listed person | A different last name turns `confirmed_in_role` into `unclear`. |

## Claude API usage

Details confirmed against the current docs in Nov 2026; re-check when upgrading, because tool versions and prices change.

- **The cost ladder.** Tier 1: cheap model, `web_fetch` only, restricted to the agency's domain, starting from URLs placed in the prompt (the fetch tool can only open URLs that appear in the conversation). Tier 2: `web_search` plus `web_fetch`, for seats tier 1 could not settle. Tier 3: optional stronger model. See `docs/COST.md`.
- **Tool versions are pinned** to `web_search_20250305` and `web_fetch_20250910` with `allowed_callers: ["direct"]`. The newer dynamic-filtering versions run the tool through code and keep page text out of the response; the app needs that text for the email-on-page check.
- **Limits per request:** `max_uses` on both tools, `max_content_tokens` on fetch (does not apply to PDFs), `max_tokens` on output, aggregator domains blocked.
- **Bulk runs:** Message Batches API (50% off tokens; web search and fetch both work in batches at normal prices; batch search is throttled per organization). Each wave is chunked (`BATCH_CHUNK`), and a wave is only sent if the run's spend cap allows it. Results are collected by polling and processed idempotently.
- **Interactive runs** (check one seat now, add an agency): Messages API at full price. A `pause_turn` stop is continued a few times; in a batch it is treated as incomplete and retried once.
- **Errors:** tool errors arrive as HTTP 200 with an error block (`max_uses_exceeded`, `url_not_allowed`, ...) and are mapped to `budget_exhausted` or `fetch_blocked`. Batch-level errors are retried up to three times; invalid model output is retried once, then stored as `model_error` and not retried automatically.
- **Money is computed from stored usage** (`src/lib/pricing.ts`), never from a model's own report.

## Why this exists as an app and not a Claude.ai session

The first manual pass (see `HANDOFF.md`) ran into limits specific to the chat workspace: a shared web-search budget per turn and a shared page-fetch cap per hour, which left roughly half of the checked contacts unresolved for tool reasons, not because the answers were missing. Calling the API directly removes that shared cap, makes runs resumable and repeatable, and lets the owner re-check on a schedule.

## Proposed stack (decision D-1 in HANDOFF.md)

- TypeScript, Node 22, Next.js (App Router) for UI and API routes
- SQLite (`better-sqlite3`) for local-first storage; `db/schema.sql` is the source of truth
- Anthropic TypeScript SDK
- Run locally first; deploy later (Railway is the likely target) with Postgres if multi-user

If the owner's existing apps (for example Agora) use a different stack, prefer matching that; the schema and prompts are stack-independent.

## Run model

- A **run** has a scope (filters), a model, an estimated cost shown **before** it starts, and a status.
- Runs are **resumable and idempotent**: each (run, seat) is a row; re-running skips seats that already have a result and retries only seats whose `unresolved_reason` is `budget_exhausted`, `fetch_blocked` or `not_searched`.
- Every API response is stored raw under `data/raw/` (git-ignored) so a result can be audited later.
- Staleness policy: a seat is "due" when its last accepted check is older than a configurable number of months (default 12) or the source data is older than 18 months.
