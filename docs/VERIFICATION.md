# Verification rules

These rules came out of a real first pass over a Power Almanac purchasing list (see `HANDOFF.md`). They exist because each failure below actually happened.

## Statuses

| Status | Meaning |
|---|---|
| `confirmed_in_role` | A source shows the listed person currently holds the seat. |
| `replaced` | A named successor was found. |
| `role_mismatch` | The listed person never headed this seat (for example a departmental procurement manager in a "Head of Purchasing" file). Name the real head if found. |
| `vacant_interim` | Seat vacant, or an interim/acting holder named. |
| `unclear` | Evidence is partial or conflicting. |
| `unable_to_confirm` | No usable current source. Always carries an `unresolved_reason`. |
| (not checked) | No check exists yet. Not a status; shown as "Not checked". |

## Unresolved reasons

`not_searched`, `budget_exhausted` (a tool refused because a limit was hit), `fetch_blocked` (robots/403/timeouts/domain not allowed), `no_staff_listed` (the page loaded but names no one), `no_current_source` (searched, nothing current), `model_error` (the model's output could not be validated after a retry; set by code only). The first three are retried automatically; the last three are genuine "could not find" or need a human look, and are left alone for `COOLDOWN_DAYS`.

## Confidence

- **High**: an official source dated 2025 or later names the person in the seat (agenda, solicitation signed by the officer, press release, dated directory).
- **Medium**: an undated live official page, or an older official source, or a source that names the person with a different but equivalent title.
- **Low**: a single third-party source (aggregator, job board, news snippet), inference from absence, or a source whose date is unknown and not official.

An undated live page is never High, even though it is "live today". This was the most common over-rating in the first pass.

## Evidence rules

1. Official sources first (the agency's own domain); search for the page if the URL is unknown.
2. Newest dated evidence wins: agendas, minutes, signed solicitations, releases, job postings for the seat, org charts.
3. Absence of the listed person from a page is weak evidence. Prefer a source that names a successor or the departure.
4. A mailbox is only recorded if it was seen verbatim on a page. Pattern guesses go in notes as "Pattern guess (UNVERIFIED)". A page's visible text and its `mailto:` link can disagree; record the visible one and mention the mismatch.
5. Label generic mailboxes (`purchasing@`, `info@`...). A generic mailbox is useful but is not the person.
6. Phone numbers on the page can differ from the listed one. Record what the page says and note the difference.
7. Notes are 1-2 sentences about evidence and date. Never include allegations, arrests, disputes or personal matters about anyone. If a note trips the deny-list it is **redacted** to "Evidence: <url> (<date>). Notes withheld by policy filter." rather than sent back for a rewrite, because a rewrite costs another paid call.
8. Only pages the fetch tool returned as text can prove an email (search results are encrypted; PDFs are not searchable). An email seen only in a PDF is stored as a pattern guess in notes.

## Failure modes seen in the first pass (guard against each)

- **Tool limits read as answers.** About half of the second-tier checks came back "unable to confirm" because the workspace's shared search/fetch budgets ran out, not because the information was missing. Fix: `unresolved_reason` + automatic retry.
- **Agents' own summary counts were wrong** (three self-corrections in one report). Fix: always recompute counts from stored rows.
- **Old email written into the "found" field** for people who had been replaced, or for confirmed people when the page did not actually show it. Fix: verbatim-on-page check in code.
- **"Replaced" with no successor named.** Fix: downgrade to `vacant_interim` or `unclear`.
- **Assistant or deputy recorded as the head.** Fix: the role definition says central head only; mismatches use `role_mismatch`.
- **Contact belongs to a different government** than the one listed (county-domain email on a city row, or a city official on a county row). Fix: the prompt includes the agency category and county; verify the email domain against the agency website domain and flag mismatches.
- **A role fused with another** (the finance director is the "Purchasing Agent"; internal services runs purchasing; a department was renamed or merged). Fix: the role definition allows this; record the person and say so in notes.
- **Third-party "confirmations"** (a vendor profile or aggregator). Fix: Low confidence unless corroborated by an official source.

## Review and quality control

- Findings are applied automatically by default (owner decision, 2026-11-19): clear findings replace the holder, and unclear or Low-confidence names are added beside the holder. The rules above still decide what a finding may contain. `REVIEW_MODE=queue` restores human review.
- Sample 5% of accepted findings each run for a second look (different prompt or a human), and record the disagreement rate in the run.
- A check older than `STALE_MONTHS` (default 12) makes the seat "due".
