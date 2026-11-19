# Prompt: verify one seat

Used by `verify` runs, as the user message. Placeholders in double braces are filled per seat (`src/lib/prompts.ts` refuses to send a prompt with an unfilled placeholder).
The model must return ONE JSON object matching `schemas/check_result.schema.json` and nothing else.

---

Today is {{today}}.

**Seat:** {{role_label}} for {{agency_name}} ({{agency_category}}, {{agency_state}}{{agency_county_clause}}).
**What counts as this seat:** {{role_definition}}

**Listed contact (from a source last verified {{source_last_verified}}, so possibly out of date):**
{{contact_name}}, {{contact_title}}, {{contact_email}}, {{contact_phone}}

**Start from:**
{{start_urls}}

**Task.** Decide whether the listed person STILL holds this seat. If not, find who holds it now and their contact details.

**Tools.**
{{tool_instructions}}

**Rules (non-negotiable).**
- `found_email`: only an address you saw verbatim on a fetched page. NEVER guess. If you can only infer one from the agency's pattern, put it in `notes` as "Pattern guess (UNVERIFIED): ...".
- Set `found_email_is_generic` true for office mailboxes (purchasing@, procurement@, info@).
- `confidence`: High only with a dated (2025+) official source (set `evidence_date`). Undated live official page: Medium. Third-party aggregator, job board, or a single weak hit: Low.
- Status meanings: `confirmed_in_role`, `replaced` (named successor found), `role_mismatch` (the listed person never headed this seat, e.g. a departmental buyer; say who does if found), `vacant_interim` (vacant or interim holder), `unclear` (conflicting or partial evidence), `unable_to_confirm` (no usable current source).
- The head of the function only: not an assistant, deputy, specialist or departmental buyer, unless the role definition says otherwise.
- If a tool was refused or blocked, say so in `unresolved_reason` (`budget_exhausted` / `fetch_blocked`). Do not report "not found" when you did not look. A page that loads but names no staff is `no_staff_listed`.
- The listed person's absence from a page is weak evidence of departure: use `unclear` or Low confidence unless a source names a successor or the departure.
- `source_url` must be a page you actually retrieved.
- Keep `notes` to one or two sentences about the evidence and its date. Never include allegations, arrests, disputes or other personal matters about anyone.
- Never invent a name, date, URL or email.

Return only the JSON object.
