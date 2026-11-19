# HANDOFF

Last updated: 2026-11-19 (end of the session that built the app). Read this first, then `CLAUDE.md`.

## Where things stand

- **The app is built** and runs: import Power Almanac CSVs, plan and run checks (batch or immediate), review queue with accept/reject, agency search and add (database first, then a web lookup), per-seat "Check now", roles registry, CSV export, CLI. TypeScript, Next.js, SQLite (decision D-1, confirmed by the owner).
- **It has not been run against the live API.** The build session had no network and no API key. Everything is tested against faked API responses shaped like the documented ones (63 tests, `npm test`), and every screen was loaded against the four real exports (1,808 agencies, 5,412 contacts, 6,360 seats). The first live run will find whatever the fakes missed. Expect small fixes to response parsing.
- **Cost is designed in** (`docs/COST.md`): cheap model reading the agency's own site first, paid web search only for seats that fail, Batch API for bulk, spend cap, estimate shown before any run. The dollar figures are arithmetic on assumptions until the pilot replaces them.
- **Integrity rules are enforced in code** (`src/lib/rules.ts`) and tested first: email must appear on a fetched page, High needs a dated official source, replaced needs a name, no evidence means not searched, subordinate titles are not the head, notes carry evidence only.

## What was done manually (the evidence for this design)

Source data: four Power Almanac exports for US local governments, all last verified Oct 2023 to Mar 2024 (so about 2.5 years stale):

| File | Rows | Role |
|---|---|---|
| Purchasing | 1,132 | Head of Purchasing |
| Finance | 1,706 | Head of Finance |
| Top Appointed | 1,300 | Top Appointed Executive |
| Deputy Appointed | 1,275 | Deputy Top Appointed Executive |

Only **Purchasing** was worked, largest governments first (300 of 1,132 contacts, ranks 1-300 by population). Method: for each contact, web search plus official-page fetches to see whether the person still holds the seat; if not, find the current holder. Results (counts recomputed from the data; the second pass was run in six batches, and the batch covering the 25 largest still-unresolved governments was stopped before it finished and was not merged, so those 25 remain unresolved):

| Status | Contacts |
|---|---|
| Confirmed in role | 95 |
| Replaced (successor named) | 45 |
| Role mismatch | 11 |
| Unclear | 30 |
| Vacant / interim | 3 |
| Unable to confirm | 116 |
| Not yet checked (smaller governments) | 832 |

Reading it: of the contacts that could be settled one way or the other, about 30% had been replaced. That likely understates turnover because the settled set skews to larger, better-documented governments.

**Why so many are "unable to confirm":** mostly tool limits in the chat workspace, not missing information. A shared web-search budget per turn (about 200) and a shared page-fetch cap (800 per hour) were exhausted by parallel agents; many rows never got a search or a page read. A second pass limited to one search per row resolved only about a quarter of the leftovers for the same reason. This is the main reason to build the app on the API (no shared cap, resumable, repeatable).

## Lessons that shaped the rules (see `docs/VERIFICATION.md`)

Agents' self-reported counts were wrong repeatedly; old emails were written into "found email" fields; undated live pages were rated High; "Replaced" appeared with no successor named; an assistant was recorded as the head; a few rows belonged to a different government than the one listed; one note repeated an allegation about a person. Each is now a rule enforced in code (`docs/ARCHITECTURE.md`).

## Where the data lives (not in this repo)

The working files from the session were in the Claude.ai workspace and were sent to the owner as downloads (`Purchasing_checked_v2.csv`, then a later merged version). Save them to `data/` locally (git-ignored). They are the best benchmark available: run the new verifier on the same 300 seats and compare. The raw four source CSVs are the owner's Power Almanac exports; keep them in `data/` as well.

## Decisions made

- **Stack:** TypeScript, Node 22, Next.js App Router, SQLite (`better-sqlite3`), Anthropic TS SDK. Runs locally first.
- **Private repo; contact data and CSVs never committed** (`.gitignore`, `data/README.md`).
- **Cost ladder:** tier 1 = Haiku 5.5, fetch-only on the agency's domain; tier 2 = Haiku 5.5 plus search (2 searches); tier 3 = Sonnet 5.5, off by default. Bulk runs on the Batch API. Spend cap $25 per run by default.
- **Tool versions pinned** to the earlier non-dynamic-filtering versions so page text stays in the response for the email check.
- **Seat model:** agency, then one seat per role, then a contact; checks are append-only; replacements supersede, never overwrite. **Deputies (D-6, resolved):** numbered seats (`slot` 1, 2, 3...) for roles marked `multi`. The import produced up to 6 deputy seats per agency.
- **Review policy (D-4, applied as proposed, change in `.env`):** an unchanged confirmation at High is auto-accepted (5% sampled for review anyway); everything that changes a contact, including a confirmation that brings a new verified email or phone, waits for a human. Confirmed at Medium goes to the queue with a bulk-accept button.
- **Invalid model output:** retried once, then stored as `unable_to_confirm / model_error`; not retried automatically. A policy-filtered note is redacted, not rewritten (a rewrite costs another call).
- **Roles are data** (`config/roles.json`), seeded from the 18 Power Almanac role strings; unknown strings in an import create a custom role and are reported.
- **Look and feel is the Sovra style** (navy, maroon, Open Sans Light self-hosted via `@fontsource`, line icons in colored circles). See `docs/DESIGN.md`.

## Open decisions (owner input needed)

- **D-2 Where it runs.** Local first. Railway later if others will use it (needs Postgres or a volume for SQLite, and an auth layer; there is none yet).
- **D-3 Power Almanac license.** Confirm what it allows for storing and exporting contact data before any hosted deployment.
- **D-5 Model choice.** Pilot decides: Haiku accuracy versus the manual pass and its cost per seat. Switch tier 2 to Sonnet (`MODEL_T2`) or enable tier 3 if Haiku disagrees with the manual pass in ways that are its mistakes.

## Next steps, in order

1. **Run the 25-seat pilot.** Put the four CSVs in `data/`, set `ANTHROPIC_API_KEY`, then: `npm run import -- data/*.csv`, `npm run plan -- --roles head_of_purchasing --limit 25`, `npm run run -- --roles head_of_purchasing --limit 25 --sync --yes`. Fix anything the fakes missed (most likely: response block shapes, `pause_turn` handling, tool-version availability on the chosen model).
2. **Record the measured cost per seat and per tier here and in `docs/COST.md`**; then `npm run yb -- compare <Purchasing_checked_v3.csv>` for the accuracy half of D-5. The v3 CSV was handed to the owner; save it in `data/`.
3. **Run the 25 largest unresolved purchasing seats** (the batch stopped during the manual pass) as the first real bulk run.
4. **Bulk runs** by role, largest first, within the spend cap: `npm run run -- --roles head_of_purchasing --yes`, then `npm run yb -- watch <id>`.
5. **Not built yet:** scheduled re-checks; authentication and multi-user (needed for any hosted deployment); editing a contact by hand; an in-app background poller for batches (today: the Check for results button or `yb watch`); keyboard shortcuts in the review queue; a role-definition editor (add only).

## Gotchas

- Contact data is about real people. Keep it out of git, logs, tests and issues. Tests use invented data ("Example County").
- Real-export quirks found while building the importer: a stray space inside one Person ID (`...000 -50132AE`); the Purchasing file's contacts also hold other roles, so "Head of Purchasing" has 1,452 seats across the four files, not 1,132.
- Server actions that call the API (`Check now`, `Check every seat now`, agency web lookup) block the page for the length of the call, typically under a minute per seat.
- The Next.js build prints no warnings now; if `next build` warns about tracing the whole project, it is from a `process.cwd()` path; see the `turbopackIgnore` comments in `src/lib`.

## API key in Claude Code cloud sessions (2026-11-19)

Cloud sessions never received `ANTHROPIC_API_KEY` from the environment settings, even in a fresh session (tried three times). Most likely the platform withholds that name because it is Claude Code's own variable. The container also sets `ANTHROPIC_BASE_URL` for Claude Code, which the SDK would otherwise pick up. Fix: `cfg()` now reads `YELLOWBOOK_ANTHROPIC_API_KEY` first (falls back to `ANTHROPIC_API_KEY`), and the client pins `baseURL` to `https://api.anthropic.com` (override with `YELLOWBOOK_ANTHROPIC_BASE_URL`). Next step: add the key under the new name in the yellowbook environment, start a new session, and confirm with one `/v1/models` call.

**Confirmed working (2026-11-19, next session):** `YELLOWBOOK_ANTHROPIC_API_KEY` now reaches the container. `/v1/models` returns 200 through the app's own `getClient()` (base URL resolves to `https://api.anthropic.com`, not the container's), and all three tier models (`claude-haiku-5-5` for T1/T2, `claude-sonnet-5-5` for T3) are available to the key. `npm install`, `npm test` (63/63) and `npm run typecheck` pass. No tokens spent. Blocker for the pilot: `data/` holds only its README, so the four Power Almanac CSVs (and `Purchasing_checked_v3.csv`) must be uploaded before step 1 below.

## First pilot attempt (2026-11-19): blocked by web fetch, not by the code

- Data uploaded and imported (five exports this time: Purchasing, Finance, Top Appointed, Deputy Appointed, **IT**, which is new). Result: 1,818 agencies, 6,904 contacts, 8,159 seats, 0 conflicts; IT mapped to the existing `head_of_it` role (1,524 seats). `data/` is not in git, so **a new session must re-upload the six CSVs** and rerun `npm run import -- data/Purchasing.csv data/Finance.csv data/Top_Appointed.csv data/Deputy_Appointed.csv data/IT.csv` (idempotent).
- Pilot plan for 25 purchasing seats: estimated $0.24, ceiling $0.56.
- The run failed on every seat with `400 invalid_request_error: Requests sent from a sandbox with restricted network access are not allowed to use tool web_fetch_20250910`. Web search is allowed; only web fetch is refused. No tokens spent, no checks stored, no seat marked checked.
- The owner approved switching the yellowbook environment to **unrestricted** network. The session picked up the network change (arbitrary hosts load) but the API kept refusing web fetch, so the API appears to classify the sandbox at container start. **Next step: start a fresh session on the yellowbook environment, run one tiny web_fetch call to confirm, then the pilot.** If fresh sessions are still refused, run the pilot on the owner's own machine (the original "local first" plan) or open a question about whether tier 1 can work without fetch (it cannot satisfy the email-on-page rule without page text).
- Fixed: immediate (`--sync`) runs retried 4xx errors three times. `isRetryableStatus` in `src/lib/runs.ts` now retries only network errors, 408, 409, 429 and 5xx, matching the batch path. Test added (65 tests).
