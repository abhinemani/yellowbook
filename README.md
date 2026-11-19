# yellowbook

Keep government contact lists honest. yellowbook holds agencies and the people in their key positions, asks Claude (with live web search) whether each person still holds the job, finds the current holder when they don't, and lets you add new agencies and positions as you come across them.

> Status: design and specs only. No application code yet. Start with `HANDOFF.md`.

## Why

Contact lists for city and county officials go stale fast. In a first manual pass over a Power Almanac purchasing list that was last verified in late 2023 and early 2024, about 30% of the contacts that could be settled had already been replaced. Checking by hand does not scale, and doing it through a chat session hit shared tool limits. This app runs the same check through the Claude API, repeatably.

## What it does

- **Any position, not just purchasing.** Roles are data (`config/roles.json`): Head of Purchasing, Head of Finance, Top Appointed Executive, Deputy Top Appointed Executive, Head Clerk, Head of IT, and more. Add your own.
- **Many contacts per agency.** An agency has one seat per role. One person can fill several seats, as in Power Almanac's multi-valued `Role` column.
- **Verify at any scope.** "Head of Finance, counties over 250,000 people, not checked in 12 months." See the estimated cost before it runs.
- **Search and add agencies.** Look an agency up in the database; if it is missing, find it on the web, confirm it, add it, then discover contacts for the roles you choose.
- **Review before anything changes.** Findings go to a review queue with the source link. Accepting a replacement keeps the old contact as history.
- **Import and export Power Almanac CSVs**, with extra columns for the check results.

## Repo layout

```
README.md              this file
CLAUDE.md              instructions for Claude Code sessions in this repo
HANDOFF.md             current state, decisions, open questions, next steps (read first)
docs/ARCHITECTURE.md   components, API usage, enforced rules, stack proposal
docs/DATA_MODEL.md     tables, Power Almanac column mapping, import gotchas
docs/VERIFICATION.md   statuses, confidence rubric, evidence rules, known failure modes
docs/DESIGN.md         the Sovra visual style and the screens
db/schema.sql          SQLite schema (tested)
config/roles.json      seed roles with definitions and title hints
prompts/               verify_contact, find_agency, discover_contact
schemas/               JSON schema for a check result
design/tokens.css      colors, type, status chips, icon circles
data/                  git-ignored: database, raw responses, CSVs
```

## Getting started (once code exists)

```bash
cp .env.example .env          # add ANTHROPIC_API_KEY
# install, import a Power Almanac CSV, run a 25-seat pilot, review, export
```

The first build step is a 25-seat pilot that records tokens and cost per seat; see `HANDOFF.md`.

## Data

Contact data is third-party and about real people. It is git-ignored; see `data/README.md`.

## Design

Navy and maroon, Open Sans Light, line icons in colored circles. See `docs/DESIGN.md`.
