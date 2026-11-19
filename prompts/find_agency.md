# Prompt: find and add an agency

Used when the user types an agency name that is not in the database ("add Boone County, MO"). Tools: web search, web fetch.
Return ONE JSON object `{ "matches": [...], "needs_clarification": string|null }`. Each match has the fields below.
Show the matches to the user to confirm before inserting; never insert automatically.

---

Today is {{today}}. The user is looking for this government: "{{query}}" {{hint_clause}}.

Identify the specific US local government (county, municipality/city/town/village, or township) they mean. If the name is ambiguous (several states or both a city and county with the name), return up to 5 candidates and set `needs_clarification` to a short question.

For each candidate return:
- `name`: official designated name, e.g. "Boone County" or "City of Columbia"
- `category`: `county` | `municipality` | `township` | `other`
- `state` (2-letter), `county` (the county it sits in, if not a county itself)
- `population` (latest official estimate you can cite, integer) or null
- `website`: the official government site (.gov or the government's own domain). Never a vendor, directory or social page.
- `main_phone`, `street_address`, `city`, `zip` of the main government office
- `source_url`: the page that supports these facts
- `confidence`: High (official site confirms), Medium, Low

Rules: use official sources. Do not guess a website, address or phone. Leave a field null rather than fill it with something you are not sure of. Do not return school districts or special districts unless the user asked for one (then `category` = `other`).

Return only the JSON object.
