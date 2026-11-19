# Data model

The SQL is in `db/schema.sql` (tested on SQLite). This page explains the model and how Power Almanac exports map onto it.

## Concepts

- **Agency**: a county, municipality, township or other government. Added from an import or by hand.
- **Role**: a type of position (Head of Purchasing, Head of Finance...). Roles are rows in the `roles` table, seeded from `config/roles.json`. Anyone can add a custom role.
- **Seat**: one role at one agency. `UNIQUE(agency_id, role_key, slot)`. A seat may have no holder yet. Roles marked `multi` (Deputy Top Appointed Executive) can have several seats per agency, numbered by `slot` (1, 2, 3...); every other role has one seat. (Decision D-6, resolved: numbered seats.)
- **Contact**: a person record. One contact can hold several seats (the Power Almanac `Role` column is multi-valued, for example "Top Appointed Executive,Head of Facilities Management").
- **Check**: one verification attempt on a seat. Append-only. The latest check per seat drives the table view (`v_seat_status`).
- **Run**: a batch of checks started together, with scope, model, estimated cost, a spend cap and actual cost. Each (run, seat, tier) is a `run_items` row, which makes runs resumable and idempotent.
- **Tier**: which rung of the cost ladder produced a check (1 site read, 2 plus search, 3 stronger model). Stored on every check with its dollar cost, token counts and the path of the raw API response.

## Replacement flow

1. A check returns `replaced` with a new name.
2. It sits in the review queue (`review_state = pending`).
3. On accept: insert a new `contacts` row (`source = 'web_check'`), set the old contact `status = 'superseded'` with `superseded_by`, point `seats.current_contact_id` at the new contact, stamp `seats.last_checked_at`.
4. On reject: nothing changes; the check stays as history.

A `role_mismatch` finding means the listed person never held the seat (for example a departmental buyer in a "Head of Purchasing" file). Treat it like a replacement if a head is named; otherwise leave the seat flagged.

## Power Almanac import: column mapping

| Power Almanac column | Goes to |
|---|---|
| Email Address | `contacts.email` (set `email_is_generic` by pattern) |
| First Name, Last Name, Title | `contacts.first_name`, `last_name`, `title` |
| Phone Number, Phone Number Ext | `contacts.phone`, `phone_ext` |
| Street Address or PO Box Number, Suite Number, City, State, Zip Code | `contacts.street_address`, `suite`, `city`, `state`, `zip` |
| Person ID (e.g. `205101901900000-A2B1EA4`) | `contacts.power_almanac_person_id` |
| **Power Almanac Account ID** | **Do not use.** In the exports it is mangled into scientific notation (`2.05102E+14`). Derive the account id from the **Person ID prefix before the hyphen** (`205101901900000`) and store it in `agencies.power_almanac_account_id`. |
| Role (comma-separated) | one `seats` row per value, `current_contact_id` = this contact |
| Government Designated Name | `agencies.name` |
| Government Category (`county`/`municipality`/`township`) | `agencies.category` |
| Government Place Name, Government Category Name | informational only (Category Name is "County", "City"...) |
| Government County Location | `agencies.county` |
| Government Web Address | `agencies.website` |
| Government Main Phone Number | `agencies.main_phone` |
| Government Street Address, City, State, Zip Code | `agencies.street_address`, `city`, `state`, `zip` |
| Population | `agencies.population` (see parsing notes) |
| Last Verified Date (`28-Mar-24`) | `contacts.source_last_verified` as ISO |
| Fiscal Year End | `agencies.fiscal_year_end` |
| Update Status | ignore (every row in the sample exports says "SAME") |

## Parsing gotchas (all seen in the real exports)

- Files start with a UTF-8 BOM. Read as `utf-8-sig`.
- Some headers have stray spaces (`Government Place Name `, `Government City `, ` Population `). Strip header names.
- Population is sometimes plain (`10019635`) and sometimes padded with thousands separators (` 10,019,635 `). Strip spaces and commas.
- Values like `SAME ` have trailing spaces. Trim all strings.
- The same person (same Person ID) can appear in more than one export. Upsert on Person ID + agency; merge roles.
- The same email can appear on several rows (shared or generic mailboxes; the deputy file had 31 repeats). Duplicate email is not a duplicate person. Dedupe on Person ID, not email.
- One real row has a stray space inside the Person ID (`205203000100000 -50132AE`). Strip all whitespace from Person IDs before parsing.
- Contacts in one file often hold other roles too: the Purchasing file's 1,132 contacts fill 1,452 Head of Purchasing seats across all four files.
- Dates are `d-MMM-yy`.
- Governments are not unique by name alone ("Washington County" exists in many states). Agency identity is `power_almanac_account_id`, or (name, state) for hand-added agencies.
- The listed contact for a role is sometimes a departmental person, not the head of the function. That is a `role_mismatch` finding, not an import error.

## Adding an agency by hand

1. Search the local database (name, state; full-text on `agencies.name`).
2. If missing: run the `find_agency` prompt, show candidates with sources, user confirms one, insert with `source = 'web_lookup'` and the evidence in `source_url`.
3. Choose roles to create seats for (default: the roles the user last used), then run `discover_contact` for each.

## Export

Same columns and order as the Power Almanac files, so the output can go back into the user's existing workflow, plus: `Check Status, Current Name, Current Title, Current Email, Current Phone, Source URL, Confidence, Check Notes`. For rows never checked, `Check Status` is `Not checked`.
