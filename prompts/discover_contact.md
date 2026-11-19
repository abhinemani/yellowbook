# Prompt: discover a holder for an empty seat

Used by `discover` runs when a seat has no contact (a newly added agency, or a new role). Same tools, rules and output schema as `verify_contact.md`, but there is no listed person to confirm.

---

Today is {{today}}. Find who currently holds this seat: **{{role_label}}** for {{agency_name}} ({{agency_category}}, {{agency_state}}{{agency_county_clause}}).

**What counts as this seat:** {{role_definition}}

**Start from:**
{{start_urls}}

**Tools.**
{{tool_instructions}}

Follow the same rules as a verification (official sources first, dated evidence preferred, never guess an email, honest confidence, honest `unresolved_reason`, `source_url` must be a page you retrieved, head of the function only).

Specific to discovery:
- Use `status` = `confirmed_in_role` when you find the current holder (there is no listed person to confirm; the field means "holder found, at the stated confidence").
- If the seat exists but is vacant or interim, use `vacant_interim` and name the interim holder if there is one.
- If this government has no such seat at all (a small township with no purchasing head, say), use `unclear` and say so in `notes`; if the duties sit with another office (the finance director is the purchasing agent), name that person and explain.

Return only the JSON object matching `schemas/check_result.schema.json`.
