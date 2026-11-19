# HANDOFF

Last updated: 2026-11-19 (end of the Claude.ai session that designed this repo). Read this first, then `CLAUDE.md`.

## Where things stand

- **Repo contains design and specs only.** No application code yet: schema, roles, prompts, result contract, rules, design tokens, docs.
- **The schema, role seed and result contract were tested** (schema loads in SQLite, 19 roles seed with unique keys, the "High needs a dated source" guard rejects bad rows, status enum rejects bad values).
- **A manual first pass proved the approach and exposed its limits** (below). The app exists to remove those limits.

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

- **Private repo; contact data and CSVs never committed** (`.gitignore`, `data/README.md`).
- **The app calls the Claude API directly** with the web search and fetch tools, using the Batches API for bulk runs.
- **Seat model:** agency, then one seat per role, then a contact; checks are append-only; replacements supersede, never overwrite.
- **Roles are data** (`config/roles.json`), seeded from the 18 Power Almanac role strings found in the exports, so any position can be checked and custom roles can be added.
- **Look and feel is the Sovra style** (navy, maroon, Open Sans Light, line icons in colored circles). See `docs/DESIGN.md`.

## Open decisions (owner input needed)

- **D-1 Stack.** Proposed: TypeScript, Next.js, SQLite. Check against the owner's Agora app and prefer a match.
- **D-2 Where it runs.** Local first is simplest. Railway later if others will use it.
- **D-3 Power Almanac license.** Confirm what the license allows for storing and exporting contact data before any hosted deployment.
- **D-4 Review policy.** Proposed: High-confidence confirmations auto-accept; every replacement needs a human. Confirm.
- **D-5 Model choice.** Compare Sonnet-class and Haiku-class on the 25-seat pilot for accuracy and cost per seat.
- **D-6 Seat-less people.** Deputy executives are many per government. Proposed: model them as several seats with a numbered suffix, or allow multiple contacts per seat for that role. Decide before importing the deputy file.

## Next steps, in order

1. Confirm D-1, scaffold the app, set up migrations from `db/schema.sql`, seed roles.
2. Build the importer for all four files using the gotchas in `docs/DATA_MODEL.md` (BOM, padded headers, thousands separators, mangled account id, multi-valued Role, duplicate emails). Test on invented fixtures.
3. Build the validator and its tests first: email-on-page check, High-needs-date, replaced-needs-name, generic-mailbox flag, notes deny-list.
4. Build the verifier (Messages API, one seat) using `prompts/verify_contact.md`; run a 25-seat pilot on seats already checked by hand; record tokens and cost per seat here.
5. Review queue UI and accept/reject flow.
6. Agency search and "add agency" via `prompts/find_agency.md`; "discover contact" for empty seats.
7. Bulk runs on the Batches API with cost estimate before start and resume/retry.
8. Export with check columns. Then scheduled re-checks.

## Gotchas

- The chat workspace could not reach most sites or the API; run the app on the owner's machine.
- Web search pricing and tool versions change; re-check the docs when building (`docs/ARCHITECTURE.md` lists what to confirm).
- Contact data is about real people. Keep it out of git, logs, tests and issues.
