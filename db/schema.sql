-- yellowbook schema (SQLite). Proposed; see docs/DATA_MODEL.md.
-- Core idea: an AGENCY has SEATS (one per role, e.g. "Head of Purchasing").
-- A seat is held by a CONTACT. A CHECK is one verification attempt on a seat.
-- When a check finds a replacement, a NEW contact is created and the old one is
-- marked 'superseded' (history is kept, never overwritten).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agencies (
  id                        INTEGER PRIMARY KEY,
  name                      TEXT NOT NULL,                 -- "Government Designated Name"
  category                  TEXT NOT NULL CHECK (category IN ('county','municipality','township','other')),
  state                     TEXT NOT NULL,                 -- 2-letter
  county                    TEXT,                          -- "Government County Location"
  population                INTEGER,
  website                   TEXT,
  main_phone                TEXT,
  street_address            TEXT,
  city                      TEXT,
  zip                       TEXT,
  fiscal_year_end           TEXT,
  power_almanac_account_id  TEXT UNIQUE,                   -- NULL for agencies added by hand
  source                    TEXT NOT NULL DEFAULT 'power_almanac'
                            CHECK (source IN ('power_almanac','manual','web_lookup')),
  source_url                TEXT,                          -- evidence for web_lookup/manual adds
  notes                     TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agencies_state ON agencies(state);
CREATE INDEX IF NOT EXISTS idx_agencies_pop   ON agencies(population DESC);
CREATE INDEX IF NOT EXISTS idx_agencies_name  ON agencies(name COLLATE NOCASE);

-- Roles are data, not code: add any position without a migration. Seed: config/roles.json
CREATE TABLE IF NOT EXISTS roles (
  key                 TEXT PRIMARY KEY,                    -- e.g. head_of_purchasing
  label               TEXT NOT NULL,                       -- "Head of Purchasing"
  power_almanac_role  TEXT UNIQUE,                         -- exact PA string, NULL for custom roles
  definition          TEXT NOT NULL,                       -- what counts as this seat (fed to the model)
  title_hints         TEXT NOT NULL DEFAULT '[]',          -- JSON array of common job titles
  active              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS contacts (
  id                       INTEGER PRIMARY KEY,
  agency_id                INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  first_name               TEXT,
  last_name                TEXT,
  title                    TEXT,
  email                    TEXT,
  email_is_generic         INTEGER NOT NULL DEFAULT 0,     -- 1 for purchasing@, info@, etc.
  phone                    TEXT,
  phone_ext                TEXT,
  street_address           TEXT,
  suite                    TEXT,
  city                     TEXT,
  state                    TEXT,
  zip                      TEXT,
  power_almanac_person_id  TEXT,                           -- same person can appear in several PA files
  source_last_verified     TEXT,                           -- PA "Last Verified Date" (ISO) if imported
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','superseded','removed')),
  superseded_by            INTEGER REFERENCES contacts(id),
  source                   TEXT NOT NULL DEFAULT 'power_almanac'
                           CHECK (source IN ('power_almanac','manual','web_check')),
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_agency ON contacts(agency_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email  ON contacts(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_contacts_pid    ON contacts(power_almanac_person_id);

-- One seat per (agency, role). Holder may be NULL (vacant / unknown / not yet found).
-- One contact can hold several seats (Power Almanac "Role" is multi-valued).
CREATE TABLE IF NOT EXISTS seats (
  id                  INTEGER PRIMARY KEY,
  agency_id           INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  role_key            TEXT    NOT NULL REFERENCES roles(key),
  current_contact_id  INTEGER REFERENCES contacts(id),
  last_checked_at     TEXT,
  UNIQUE (agency_id, role_key)
);
CREATE INDEX IF NOT EXISTS idx_seats_role   ON seats(role_key);
CREATE INDEX IF NOT EXISTS idx_seats_holder ON seats(current_contact_id);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  kind         TEXT NOT NULL CHECK (kind IN ('verify','discover','find_agency')),
  scope_json   TEXT NOT NULL,                              -- filters used: roles, states, min_pop, max_age...
  model        TEXT NOT NULL,
  batch_id     TEXT,                                       -- Message Batches id, if used
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','failed','canceled')),
  est_cost_usd REAL
);

-- One verification attempt on one seat. Append-only.
CREATE TABLE IF NOT EXISTS checks (
  id                 INTEGER PRIMARY KEY,
  seat_id            INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  contact_id         INTEGER REFERENCES contacts(id),      -- the holder we were testing (may be NULL for discover)
  run_id             INTEGER REFERENCES runs(id),
  checked_at         TEXT NOT NULL DEFAULT (datetime('now')),
  status             TEXT NOT NULL CHECK (status IN
                       ('confirmed_in_role','replaced','role_mismatch','vacant_interim','unclear','unable_to_confirm')),
  unresolved_reason  TEXT CHECK (unresolved_reason IN
                       ('not_searched','budget_exhausted','fetch_blocked','no_staff_listed','no_current_source') OR unresolved_reason IS NULL),
  found_name         TEXT,
  found_title        TEXT,
  found_email        TEXT,                                 -- ONLY if seen verbatim on a page
  found_email_generic INTEGER NOT NULL DEFAULT 0,
  found_phone        TEXT,
  source_url         TEXT,
  evidence_date      TEXT,                                 -- date of the source if stated (ISO), else NULL
  confidence         TEXT CHECK (confidence IN ('High','Medium','Low')),
  notes              TEXT,
  review_state       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (review_state IN ('pending','accepted','rejected','auto_accepted')),
  model              TEXT,
  searches_used      INTEGER,
  fetches_used       INTEGER,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  -- guard: High needs a dated source
  CHECK (confidence <> 'High' OR evidence_date IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_checks_seat ON checks(seat_id, checked_at DESC);

-- Latest check per seat, with holder + agency, for the main table view.
CREATE VIEW IF NOT EXISTS v_seat_status AS
SELECT s.id AS seat_id, a.id AS agency_id, a.name AS agency, a.state, a.category, a.population,
       r.key AS role_key, r.label AS role,
       c.first_name || ' ' || c.last_name AS listed_name, c.title AS listed_title, c.email AS listed_email,
       k.status AS check_status, k.confidence, k.found_name, k.found_title, k.found_email,
       k.source_url, k.review_state, k.checked_at
FROM seats s
JOIN agencies a ON a.id = s.agency_id
JOIN roles r    ON r.key = s.role_key
LEFT JOIN contacts c ON c.id = s.current_contact_id
LEFT JOIN checks k ON k.id = (SELECT id FROM checks WHERE seat_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1);
