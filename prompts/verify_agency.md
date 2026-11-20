# Prompt: check every seat at one agency in a single request

Used by grouped runs (the default for batch runs): one request per agency and tier, covering each of that agency's seats due at that tier. The same rules as `verify_contact.md` and `discover_contact.md` apply to each seat. The model returns `{ "results": [ ... ] }`, one object per seat, each the `check_result` fields plus `seat_ref`. Placeholders in double braces are filled per agency.

---

Today is {{today}}. Check these seats at **{{agency_name}}** ({{agency_category}}, {{agency_state}}{{agency_county_clause}}). One staff directory, leadership page or org chart often settles several seats at once, so look for that first.

**Start from:**
{{start_urls}}

**Seats** (each lists who our records had, from a source last verified as shown, so possibly out of date):
{{seat_blocks}}

**Task.** For each seat with a listed contact, decide whether that person STILL holds it, and if not, who does now. For a seat marked "no contact on file", find who holds it now.

**Tools.**
{{tool_instructions}}

**Rules (non-negotiable, for every seat).**
- `found_email`: only an address you saw verbatim on a fetched page. NEVER guess. An inferred address goes in `notes` as "Pattern guess (UNVERIFIED): ...".
- Set `found_email_is_generic` true for office mailboxes (purchasing@, finance@, info@).
- `confidence`: High only with a dated (2025+) official source (set `evidence_date`). Undated live official page: Medium. Third-party aggregator, job board, or a single weak hit: Low.
- Status meanings: `confirmed_in_role` (the listed person still holds it; for a seat with no contact on file, the holder you found), `replaced` (named successor found), `role_mismatch` (the listed person never headed this seat; say who does if found), `vacant_interim` (vacant or interim holder), `unclear` (conflicting or partial evidence), `unable_to_confirm` (no usable current source for this seat).
- The head of each function only: not an assistant, deputy, specialist or departmental staff, unless the seat's definition says otherwise. A deputy seat is a deputy, not the top executive.
- If a tool was refused or blocked, say so in `unresolved_reason` (`budget_exhausted` / `fetch_blocked`). Do not report "not found" when you did not look. A page that loads but names no one for a seat is `no_staff_listed`.
- The listed person's absence from a page is weak evidence of departure: use `unclear` or Low confidence unless a source names a successor or the departure.
- `source_url` must be a page you actually retrieved.
- Keep `notes` to one or two sentences per seat about the evidence and its date. Never include allegations, arrests, disputes or other personal matters about anyone.
- Never invent a name, date, URL or email.

Return only the JSON object with one entry in `results` for every seat above, each with its `seat_ref`.
