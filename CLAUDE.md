# CLAUDE.md

Instructions for Claude Code sessions in this repo. Read `HANDOFF.md` first for current state; update it before you stop.

## What this project is

yellowbook verifies and maintains government contacts. Agencies have seats (roles); seats have contacts; checks record whether a contact still holds a seat, using the Claude API with web search and fetch. See `README.md` and `docs/ARCHITECTURE.md`.

## Where things live

- Schema: `db/schema.sql` (source of truth; migrate by editing it and writing a migration, never by hand-editing a live DB)
- Roles: `config/roles.json` seeds the `roles` table. Roles are data; never hard-code a role in application logic
- Prompts: `prompts/*.md`. The result contract: `schemas/check_result.schema.json`
- Rules and failure modes: `docs/VERIFICATION.md`. Data mapping and import gotchas: `docs/DATA_MODEL.md`
- Look and feel: `docs/DESIGN.md`, `design/tokens.css`

## Hard rules

1. **Never commit contact data or secrets.** `data/`, `*.csv`, `*.sqlite`, `.env` are git-ignored. Do not paste real contacts into issues, commit messages, tests or fixtures. Use invented examples ("Example County").
2. **Never record a guessed email as an email.** An address is stored only if it appears verbatim in fetched page text. Pattern guesses go in notes as "Pattern guess (UNVERIFIED)". This is enforced in code, not only in the prompt.
3. **"High" confidence requires a dated (2025+) official source.** Undated live pages are Medium at most.
4. **Separate "not searched" from "not found".** Tool refusals and blocks set `unresolved_reason` (`budget_exhausted`, `fetch_blocked`) and are retried; they are never reported as "the person is gone".
5. **Replacements are never auto-applied.** Accepting a change is a human action in the review queue. History is kept (`superseded`), never overwritten.
6. **No personal matters in notes** (allegations, arrests, disputes). Evidence and dates only.
7. **Counts come from the database,** never from a model's own summary of how many it did.
8. **Show estimated cost and seat count before any bulk run starts,** and let the user cancel.

## Conventions

- Stack is proposed in `docs/ARCHITECTURE.md` (TypeScript, Next.js, SQLite). Confirm decision D-1 in `HANDOFF.md` before scaffolding.
- Validate every model response against `schemas/check_result.schema.json`; on failure retry once, then store as `unable_to_confirm` with the validation error in notes.
- Keep prompts in `prompts/` as templates; do not inline long prompts in code.
- Store every raw API response under `data/raw/<run_id>/` for audit.
- UI follows `docs/DESIGN.md`: navy dominant, Open Sans (Light for headlines and big numbers), line icons in colored circles, no stock imagery, short plain titles, status shown by text label as well as color.
- Write tests with invented data. Test the enforcement rules (email-on-page check, confidence downgrade, replaced-without-name downgrade) first; they are the product's integrity.

## Commands

None yet. When code exists, list install, dev, test, import, verify and export commands here.

## Before you stop

Update `HANDOFF.md`: what changed, what is in progress, decisions made, open questions, next step.
