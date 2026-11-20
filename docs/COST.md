# Cost

Goal: runs that are good and as cheap as possible. This page explains where the money goes, which levers are built in, what was considered and rejected, and how to replace the estimates with measured numbers.

**Everything below the "Estimates" heading is arithmetic on assumptions, not measurement.** The app has not yet run against the live API. Run the 25-seat pilot first; the estimator then uses your real averages.

## Where the money goes

Prices are from the Anthropic pricing page (checked Nov 2026; `src/lib/pricing.ts` holds them in one place).

| Item | Price |
|---|---|
| Haiku 5.5 tokens (prompts up to 100k) | $0.10 in / $0.50 out per million |
| Sonnet 5.5 tokens | $2 in / $10 out per million |
| Batch API | 50% off tokens (not off search) |
| Web search | $10 per 1,000 searches ($0.01 each) |
| Web fetch | no charge beyond the page's tokens (a 10 kB page is about 2,500 tokens) |

With Haiku on the Batch API, a page read costs a small fraction of a cent. **A single web search ($0.01) costs more than reading about ten pages.** So the design is: read pages first, pay for search only when reading cannot settle the seat.

## The levers, in order of impact

1. **Tiered escalation (biggest).** Tier 1 gives the cheap model only a fetch tool, restricted to the agency's own domain, starting from the website on file and the page that last named the holder. Most seats should settle there. Only seats left unresolved, unclear or at Low confidence go to tier 2, which adds web search (default 2 searches). Tier 3 (a stronger model) exists but is off unless `MAX_TIER=3`. Confirmed at Medium is accepted as is: paying a search to turn Medium into High is not worth it.
2. **Cheap model by default.** Haiku 5.5 is 20 times cheaper than Sonnet 5.5 per token. Whether it is accurate enough is an open question the pilot answers (decision D-5); tier 3 is the escape hatch.
3. **Batch API for bulk runs.** Half price on tokens. `--sync` and the "Check now" buttons use the Messages API at full price for immediate answers.
4. **Never check a seat that does not need it.** Skipped automatically: seats accepted within `STALE_MONTHS`, seats whose latest result is waiting in the review queue, seats already in an unfinished run, and seats that ended "searched, found nothing" within `COOLDOWN_DAYS`. Seats that ended because a tool was blocked or never ran are retried at once.
5. **Hard caps everywhere.** `max_uses` on each tool, `max_content_tokens` (12,000) on each fetch, `max_tokens` on output, and a per-run spend cap that stops new batches from being sent. The cost estimate is shown, with a ceiling, before anything starts.
6. **Blocked aggregator domains** (ZoomInfo, RocketReach and similar) on search and fetch: they are the stale data this app exists to correct, and reading them wastes tokens.
7. **No narration, no extended thinking.** The system prompt asks for silent tool use and one JSON object, which keeps output tokens low.

## Considered and rejected

- **Prompt caching.** The shared prefix (system prompt and tool definitions) is only a couple of thousand tokens. At Haiku batch rates that is under a hundredth of a cent per request, so caching saves almost nothing and adds moving parts. Revisit if the prefix grows large.
- **Several seats in one request.** It would share a few page reads across an agency's seats, saving about a tenth of a cent a seat in tokens, at a real risk of mixing up seats on a small model. Revisit only if search fees are shared (they could be).
- **Dynamic filtering (newer tool versions).** It filters fetched pages with code before they reach the model, which saves tokens, but it keeps page text out of the response, and the app needs that text to check that an email really appeared on a page. The saving is small at Haiku prices. The app pins the earlier tool versions and sets `allowed_callers: ["direct"]`.

## Known cost risks

- **PDFs are not capped** by `max_content_tokens`. A 500 kB agenda PDF can be about 125,000 tokens, and Haiku 5.5 charges five times more per token once a prompt passes 100,000. One such fetch could cost a few cents on its own. Tier 1 tells the model to avoid PDFs unless clearly the best evidence. The pilot's per-seat maximum will show whether this bites.
- **Search results are tokens too.** Each search adds its results to the input. The default assumption (about 5,000 tokens per search) is a guess.
- **Batch search is throttled per organization**, so a large batch can take longer. It does not cost more.

## First measurement (25-seat pilot, 2026-11-19)

The largest 25 purchasing seats, sync (full price): $1.02 total, $0.041 a seat. Tier 1 averaged 48k input and 790 output tokens ($0.009); tier 2 averaged 86k input, 1,450 output and 1.55 searches ($0.040). 80% of seats escalated. Token use is about 3x the assumptions below, and escalation twice the guess, so read the table below as roughly a third of the real cost until the estimator has 50 tier-1 checks. Large governments may escalate more than small ones; the next runs will show.

## Haiku 5.5's 100k price step (measured 2026-11-19)

Haiku 5.5 bills a request whose input passes 100,000 tokens at five times the normal rate, on every token of that request (Pricing page, "Long context pricing": each request is priced on its own, and its prompt length counts all of its input tokens). With server tools, a request's input is the total over every step of its tool loop, and each fetched page is re-read on every later step. So the number of fetches and the page size decide which side of the line a request lands on.

In the first 1,361 batch responses, 14% of requests passed 100k, and they were 44% of the cost ($8.20; about $2.90 at the normal rate). Fixes: `MAX_CONTENT_TOKENS` 12,000 → 8,000 per page, and grouped requests get one extra fetch and one extra search, not one per seat. A live grouped tier-2 request for 4 seats then used 61k input tokens and cost $0.024 at batch prices (0.6 cents a seat, against 2.4 cents for single-seat tier 2).

## Grouped requests (batch runs, default)

All due seats of one agency at one tier go in one request (`GROUP_BY_AGENCY=true`, at most 8 seats), sharing the pages read. Single-seat agencies use the single-seat request. Stored per-seat costs are an even share of the request's cost. The estimator still assumes per-seat costs, so `plan` will overstate grouped runs until it has measured grouped checks.

## Batch runs 1 and 2 (2026-11-19, per seat, before grouping)

- Batch 1, the 25 hardest purchasing seats: $0.95, 3.8 cents a seat. 24 of 25 escalated.
- Batch 2, 690 purchasing seats at population 107k and up: $17.35, 2.5 cents a seat, a third over the estimate (mostly the 100k step). 80% escalated.

## Estimates (assumptions, not measurements)

Assumed per seat: tier 1 about 14,000 input and 450 output tokens, no search; tier 2 about 32,000 input and 600 output tokens plus 2 searches; 40% of seats escalate. Batch pricing, Haiku for both tiers. Computed by `npm run plan` on the four Power Almanac exports (6,360 seats).

| Scope | Seats | Expected | If every seat escalates |
|---|---|---|---|
| 25-seat pilot (purchasing, largest) | 25 | about $0.24 | about $0.56 |
| All Head of Purchasing seats | 1,452 | about $14 | about $33 |
| Everything imported | 6,360 | about $61 | about $143 |
| Tier 1 only, everything | 6,360 | about $5 | |

For comparison, the same list done the obvious way (Sonnet, full price, two searches on every seat) is roughly nine cents a seat, about $130 for the purchasing seats. Web search is about 90% of a tier-2 seat's cost, so `T2_MAX_SEARCHES=1` roughly halves the cost of escalated seats, at some loss in resolution. The manual first pass resolved about a quarter of its leftovers with one search each.

## Calibrating

1. Run the pilot: `npm run run -- --roles head_of_purchasing --limit 25 --sync --yes` (full price, so the numbers are conservative).
2. `npm run yb -- status` shows average cost per check by tier, straight from stored usage. Once a tier has 20 checks, the estimator uses the measured token averages; once tier 1 has 50, it uses the measured escalation rate.
3. `npm run yb -- compare Purchasing_checked_v3.csv` lines the results up against the manual pass for the same people. This is the accuracy half of D-5: if Haiku disagrees with the manual pass in ways that look like its mistakes, set `MODEL_T2=claude-sonnet-5-5` or `MAX_TIER=3`.
4. Update this page with the measured numbers and delete the "assumptions" warning.
