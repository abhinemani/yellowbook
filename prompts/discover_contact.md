# Prompt: discover a holder for an empty seat

Used when an agency has a seat with no contact (a newly added agency, or a new role). Same tools, same rules, same output schema as `verify_contact.md`, but there is no listed person to confirm.

---

Today is {{today}}. Find who currently holds this seat: **{{role_label}}** for {{agency_name}} ({{agency_category}}, {{agency_state}}{{agency_county_clause}}).

**What counts as this seat:** {{role_definition}}
**Agency website:** {{agency_website}}
**Likely titles:** {{title_hints}}

Follow the Method and Rules in `verify_contact.md` exactly (official sources first, dated evidence preferred, never guess an email, confidence rubric, honest `unresolved_reason`).

Specific to discovery:
- Use `status` = `confirmed_in_role` when you find the current holder (there is no listed person to confirm; the field means "holder found and verified at the stated confidence").
- If the seat exists but is vacant or interim, use `vacant_interim` and name the interim holder if there is one.
- If this government has no such seat at all (e.g. a small township with no purchasing head), use `unclear` and say so in `notes`; if the duties sit with another office (e.g. the finance director is the purchasing agent), name that person and explain.

**Budget:** at most {{max_searches}} searches and {{max_fetches}} page fetches.

Return only the JSON object matching `schemas/check_result.schema.json`.
