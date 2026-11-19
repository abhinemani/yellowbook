# Architecture

Status: proposed design. Nothing here is built yet. Decisions that still need the owner are listed in `HANDOFF.md`.

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
| An email is only recorded if it was seen on a page | After the call, check that `found_email` appears verbatim in the text of a fetched page or search result in the response. If not, move it to `notes` as "Pattern guess (UNVERIFIED)" and null the field. |
| "High" confidence needs a dated 2025-or-later official source | Database CHECK (`confidence <> 'High' OR evidence_date IS NOT NULL`); validator also downgrades High to Medium if `evidence_date` is older than 2025-01-01 or the host is not the agency's own domain. |
| "Not searched" is different from "not found" | `unresolved_reason` is required for `unable_to_confirm` and `unclear`. A tool refusal sets `budget_exhausted` or `fetch_blocked`, which is eligible for automatic retry. A page that loads but names no staff is `no_staff_listed`. |
| Replacements must name someone | `replaced` with no `found_name` is downgraded to `vacant_interim` or `unclear`. |
| No personal matters in notes | Validator rejects notes that match a small deny-list (arrest, charged, lawsuit, divorce, and similar) and asks for a rewrite. |
| Generic mailboxes are labeled | `found_email_is_generic` is set by pattern (purchasing@, procurement@, info@, contact@, finance@...) as well as by the model. |

## Claude API usage

Confirm every detail below against the current docs at build time; tool versions and limits change.

- **Tools:** the server-side web search tool and web fetch tool. The docs currently list `web_search_20260209` and `web_fetch_20260209`; these require the code execution tool (`code_execution_20260120` or later) for dynamic filtering, and the API provisions it automatically. Set `allowed_callers: ["direct"]` to call search directly without dynamic filtering.
- **Pricing (as documented in Nov 2026):** web search is $10 per 1,000 searches plus token costs for the results; web fetch has no extra charge beyond tokens; search results count as input tokens.
- **Bulk runs:** web search and web fetch both work in the Message Batches API at the same prices. Batches throttle web search per organization, so a large batch may take longer. The org's web-search rate limit is shown on the Rate limits page in the Console.
- **Interactive runs** (verify one seat now, add an agency): plain Messages API, streaming.
- **Model:** set by `CLAUDE_MODEL` in `.env`. Start with a Sonnet-class model; compare against Haiku-class on a 25-seat pilot before running bulk.
- **Cost estimate to sanity-check on a pilot:** about 2 searches per seat is roughly $20 per 1,000 seats in search fees alone, so about $23 for the 1,132-contact purchasing list and about $108 for all 5,413 contacts, plus token costs (not yet measured). Measure real tokens per seat on the pilot and record it in `HANDOFF.md`.

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
