import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { cfg, type Config } from './config';
import type { Db } from './db';
import { estimateRun, tierAssumptions, tierCost, type Estimate } from './estimate';
import { needsEscalation } from './rules';
import { getSeatContext, selectSeats, type Scope } from './seats';
import type { Evidence, FinalCheck, RunKind, SeatContext, Tier } from './types';
import { buildParams, callMessages, finalize, firstTier, modelErrorCheck, modelFor } from './verifier';

export interface RunOptions {
  kind?: RunKind;
  maxTier?: Tier;
  batch?: boolean;
  capUsd?: number;
}

interface RunRow {
  id: number;
  created_at: string;
  kind: RunKind;
  status: string;
  spend_cap_usd: number;
  actual_cost_usd: number;
  est_cost_usd: number | null;
  options_json: string;
}
interface ItemRow {
  id: number;
  run_id: number;
  seat_id: number;
  tier: Tier;
  custom_id: string;
  state: string;
  batch_id: string | null;
  attempts: number;
}

const MAX_ATTEMPTS = 2; // a bad response is retried once, then recorded as model_error

function runOptions(run: RunRow): { maxTier: Tier; batch: boolean } {
  return JSON.parse(run.options_json) as { maxTier: Tier; batch: boolean };
}

export function getRun(db: Db, runId: number): RunRow {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
  if (!run) throw new Error(`No run ${runId}`);
  return run;
}

/** Read-only: what would this scope cost? Shown to the user before anything starts. */
export function planRun(db: Db, scope: Scope, opts: RunOptions = {}, c: Config = cfg()): { seats: SeatContext[]; estimate: Estimate } {
  const seats = selectSeats(db, { ...scope, kind: opts.kind ?? scope.kind });
  return { seats, estimate: estimateRun(db, seats, { batch: opts.batch, maxTier: opts.maxTier }, c) };
}

/** Create the run and one planned item per seat at its first tier. Nothing is sent to the API yet. */
export function createRun(db: Db, scope: Scope, opts: RunOptions = {}, c: Config = cfg()): { runId: number; seats: number; estimate: Estimate } {
  const kind = opts.kind ?? scope.kind ?? 'verify';
  const maxTier = opts.maxTier ?? c.maxTier;
  const batch = opts.batch ?? c.useBatch;
  const { seats, estimate } = planRun(db, scope, { ...opts, kind }, c);
  const model = modelFor(1, c);
  const runId = db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO runs (kind, scope_json, model, status, est_cost_usd, spend_cap_usd, options_json) VALUES (?,?,?,?,?,?,?)`)
      .run(kind, JSON.stringify({ ...scope, kind }), model, 'queued', estimate.expectedTotalUsd, opts.capUsd ?? c.maxRunCostUsd, JSON.stringify({ maxTier, batch }));
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO run_items (run_id, seat_id, tier, custom_id) VALUES (?,?,?,?)`);
    for (const s of seats) {
      const t = firstTier(s);
      ins.run(id, s.seatId, t, customId(id, s.seatId, t));
    }
    return id;
  })();
  return { runId, seats: seats.length, estimate };
}

function customId(runId: number, seatId: number, tier: number): string {
  return `r${runId}-s${seatId}-t${tier}`;
}

function committedUsd(db: Db, run: RunRow, c: Config): number {
  const a = tierAssumptions(db);
  const inFlight = db.prepare(`SELECT tier, COUNT(*) n FROM run_items WHERE run_id = ? AND state = 'submitted' GROUP BY tier`).all(run.id) as { tier: Tier; n: number }[];
  const opts = runOptions(run);
  return run.actual_cost_usd + inFlight.reduce((sum, r) => sum + r.n * tierCost(a[r.tier], r.tier, opts.batch, c), 0);
}

function rawPath(runId: number, id: string, c: Config): string {
  return path.join(c.rawDir, String(runId), `${id}.json`);
}
function writeRaw(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

// ---------- submitting ----------

export interface WaveResult {
  submitted: number;
  deferredForCap: number;
  batchIds: string[];
}

/** Send planned items to the Batches API, within the run's spend cap. */
export async function submitWave(db: Db, client: Anthropic, runId: number, c: Config = cfg()): Promise<WaveResult> {
  const run = getRun(db, runId);
  if (run.status === 'canceled') return { submitted: 0, deferredForCap: 0, batchIds: [] };
  const a = tierAssumptions(db);
  const opts = runOptions(run);
  const today = new Date();
  const planned = db.prepare(`SELECT * FROM run_items WHERE run_id = ? AND state = 'planned' ORDER BY tier, id`).all(runId) as ItemRow[];
  const batchIds: string[] = [];
  let submitted = 0;
  let deferred = 0;
  let budget = run.spend_cap_usd - committedUsd(db, run, c);

  for (const tier of [1, 2, 3] as Tier[]) {
    const items = planned.filter((i) => i.tier === tier);
    if (!items.length) continue;
    const per = tierCost(a[tier], tier, opts.batch, c);
    const afford = per > 0 ? Math.max(0, Math.floor(budget / per)) : items.length;
    const send = items.slice(0, afford);
    deferred += items.length - send.length;
    budget -= send.length * per;
    for (let i = 0; i < send.length; i += c.batchChunk) {
      const chunk = send.slice(i, i + c.batchChunk);
      const requests = chunk.map((item) => {
        const seat = getSeatContext(db, item.seat_id)!;
        return { custom_id: item.custom_id, params: buildParams(seat, tier, run.kind, today, c) };
      });
      const batch = await client.messages.batches.create({ requests });
      db.transaction(() => {
        const up = db.prepare(`UPDATE run_items SET state = 'submitted', batch_id = ? WHERE id = ?`);
        for (const item of chunk) up.run(batch.id, item.id);
        db.prepare(`UPDATE runs SET status = 'running', batch_id = COALESCE(batch_id, ?) WHERE id = ?`).run(batch.id, runId);
      })();
      batchIds.push(batch.id);
      submitted += chunk.length;
    }
  }
  return { submitted, deferredForCap: deferred, batchIds };
}

// ---------- collecting ----------

type Outcome =
  | { kind: 'message'; message: Pick<Anthropic.Messages.Message, 'content' | 'usage' | 'stop_reason'> }
  | { kind: 'error'; error: string; retryable: boolean };

export interface CollectResult {
  batchesPending: number;
  processed: number;
  escalated: number;
}

/** Poll this run's batches; process every finished one. Safe to call repeatedly. */
export async function collectRun(db: Db, client: Anthropic, runId: number, c: Config = cfg()): Promise<CollectResult> {
  const batches = db.prepare(`SELECT DISTINCT batch_id FROM run_items WHERE run_id = ? AND state = 'submitted' AND batch_id IS NOT NULL`).all(runId) as { batch_id: string }[];
  const out: CollectResult = { batchesPending: 0, processed: 0, escalated: 0 };
  for (const { batch_id } of batches) {
    const b = await client.messages.batches.retrieve(batch_id);
    if (b.processing_status !== 'ended') {
      out.batchesPending++;
      continue;
    }
    const results = await client.messages.batches.results(batch_id);
    for await (const entry of results) {
      const item = db.prepare(`SELECT * FROM run_items WHERE custom_id = ?`).get(entry.custom_id) as ItemRow | undefined;
      if (!item || item.state !== 'submitted') continue;
      const r = entry.result as { type: string; message?: Anthropic.Messages.Message; error?: { error?: { type?: string; message?: string } } };
      let outcome: Outcome;
      if (r.type === 'succeeded' && r.message) outcome = { kind: 'message', message: r.message };
      else if (r.type === 'errored') {
        const t = r.error?.error?.type ?? 'error';
        outcome = { kind: 'error', error: `${t}: ${r.error?.error?.message ?? ''}`, retryable: t !== 'invalid_request_error' };
      } else outcome = { kind: 'error', error: r.type, retryable: true }; // expired or canceled
      const res = processOutcome(db, runId, item, outcome, true, c);
      out.processed++;
      if (res.escalated) out.escalated++;
    }
  }
  refreshRunStatus(db, runId);
  return out;
}

export interface ProcessResult {
  checkId: number | null;
  escalated: boolean;
}

/** Turn one API outcome into a stored check (or a retry). The only place results enter the database. */
export function processOutcome(db: Db, runId: number, item: ItemRow, outcome: Outcome, batch: boolean, c: Config = cfg()): ProcessResult {
  const run = getRun(db, runId);
  const seat = getSeatContext(db, item.seat_id);
  if (!seat) {
    db.prepare(`UPDATE run_items SET state = 'skipped', error = 'seat deleted' WHERE id = ?`).run(item.id);
    return { checkId: null, escalated: false };
  }
  const attempts = item.attempts + 1;

  if (outcome.kind === 'error') {
    const again = outcome.retryable && attempts < 3;
    db.prepare(`UPDATE run_items SET state = ?, attempts = ?, error = ?, batch_id = NULL WHERE id = ?`).run(again ? 'planned' : 'error', attempts, outcome.error.slice(0, 300), item.id);
    return { checkId: null, escalated: false };
  }

  const file = rawPath(runId, `${item.custom_id}-a${attempts}`, c);
  writeRaw(file, { custom_id: item.custom_id, tier: item.tier, model: modelFor(item.tier, c), message: outcome.message });
  const fin = finalize(seat, item.tier, outcome.message, batch, new Date(), c);
  db.prepare(`UPDATE runs SET actual_cost_usd = actual_cost_usd + ? WHERE id = ?`).run(fin.cost, runId);

  let final: FinalCheck;
  let validationError: string | null = null;
  if (fin.check) {
    final = fin.check;
  } else {
    if (attempts < MAX_ATTEMPTS) {
      db.prepare(`UPDATE run_items SET state = 'planned', attempts = ?, error = ?, batch_id = NULL WHERE id = ?`).run(attempts, (fin.validationError ?? '').slice(0, 300), item.id);
      return { checkId: null, escalated: false };
    }
    validationError = fin.validationError;
    final = modelErrorCheck(fin.validationError ?? 'unknown');
  }

  const opts = runOptions(run);
  const escalate = !validationError && item.tier < opts.maxTier && needsEscalation(final, c.escalateBelow);
  const checkId = insertCheck(db, { seat, runId, tier: item.tier, final, evidence: fin.evidence, cost: fin.cost, inputTokens: fin.inputTokens, outputTokens: fin.outputTokens, rawFile: file, validationError, supersededByEscalation: escalate }, c);

  db.prepare(`UPDATE run_items SET state = 'done', attempts = ?, check_id = ?, error = NULL WHERE id = ?`).run(attempts, checkId, item.id);
  if (escalate) {
    const next = (item.tier + 1) as Tier;
    db.prepare(`INSERT OR IGNORE INTO run_items (run_id, seat_id, tier, custom_id) VALUES (?,?,?,?)`).run(runId, item.seat_id, next, customId(runId, item.seat_id, next));
  }
  return { checkId, escalated: escalate };
}

function digits(s: string | null): string {
  return (s ?? '').replace(/\D/g, '').slice(-10);
}

/** Would accepting this result change the stored contact? An unchanged confirmation needs no human. */
export function changesContact(seat: SeatContext, f: FinalCheck): boolean {
  if (f.status !== 'confirmed_in_role') return true;
  const eq = (a: string | null, b: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
  if (f.found_email && !eq(f.found_email, seat.contactEmail)) return true;
  if (f.found_phone && digits(f.found_phone) !== digits(seat.contactPhone)) return true;
  if (f.found_title && !eq(f.found_title, seat.contactTitle)) return true;
  if (f.found_name && !eq(f.found_name.replace(/\s+/g, ' '), (seat.contactName ?? '').replace(/\s+/g, ' '))) return true;
  return false;
}

const RANK = { Low: 0, Medium: 1, High: 2 } as const;

export function decideReviewState(seat: SeatContext, f: FinalCheck, c: Config = cfg(), rand: () => number = Math.random): 'pending' | 'auto_accepted' | 'not_needed' {
  if (f.status === 'unable_to_confirm') return 'not_needed';
  if (f.status === 'unclear' && !f.found_name) return 'not_needed';
  if (f.status !== 'confirmed_in_role') return 'pending'; // anything that changes a contact is a human action
  if (c.autoAcceptAtOrAbove === 'None' || !f.confidence) return 'pending';
  if (RANK[f.confidence] < RANK[c.autoAcceptAtOrAbove]) return 'pending';
  if (changesContact(seat, f)) return 'pending';
  if (rand() < c.qcSampleRate) return 'pending'; // random second look at auto-accepted work
  return 'auto_accepted';
}

interface InsertArgs {
  seat: SeatContext;
  runId: number | null;
  tier: Tier;
  final: FinalCheck;
  evidence: Evidence;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  rawFile: string | null;
  validationError: string | null;
  /** True when the next tier will re-check this seat, so this result is not the one to review. */
  supersededByEscalation: boolean;
}

export function insertCheck(db: Db, a: InsertArgs, c: Config = cfg()): number {
  const f = a.final;
  const review = a.supersededByEscalation ? 'not_needed' : decideReviewState(a.seat, f, c);
  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO checks (seat_id, contact_id, run_id, status, unresolved_reason, found_name, found_title, found_email, found_email_generic,
           found_phone, source_url, evidence_date, confidence, notes, review_state, model, searches_used, fetches_used,
           input_tokens, output_tokens, tier, cost_usd, raw_path, validation_error)
         VALUES (@seat_id,@contact_id,@run_id,@status,@reason,@name,@title,@email,@generic,@phone,@url,@date,@conf,@notes,@review,@model,@searches,@fetches,
           @in,@out,@tier,@cost,@raw,@verr)`,
      )
      .run({
        seat_id: a.seat.seatId,
        contact_id: a.seat.contactId,
        run_id: a.runId,
        status: f.status,
        reason: f.unresolved_reason,
        name: f.found_name,
        title: f.found_title,
        email: f.found_email,
        generic: f.found_email_is_generic ? 1 : 0,
        phone: f.found_phone,
        url: f.source_url,
        date: f.evidence_date,
        conf: f.confidence,
        notes: f.notes,
        review,
        model: modelFor(a.tier, c),
        searches: a.evidence.searches,
        fetches: a.evidence.fetches,
        in: a.inputTokens,
        out: a.outputTokens,
        tier: a.tier,
        cost: a.cost,
        raw: a.rawFile,
        verr: a.validationError,
      });
    if (review === 'auto_accepted') db.prepare(`UPDATE seats SET last_checked_at = datetime('now') WHERE id = ?`).run(a.seat.seatId);
    return Number(info.lastInsertRowid);
  })();
  return id;
}

export function refreshRunStatus(db: Db, runId: number): string {
  const run = getRun(db, runId);
  if (run.status === 'canceled') return 'canceled';
  const open = db.prepare(`SELECT COUNT(*) n FROM run_items WHERE run_id = ? AND state IN ('planned','submitted')`).get(runId) as { n: number };
  const status = open.n === 0 ? 'done' : 'running';
  db.prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(status, runId);
  return status;
}

// ---------- synchronous (full price) execution ----------

export interface SyncResult {
  done: number;
  stoppedForCap: boolean;
}

/**
 * Run planned items now through the Messages API, climbing tiers as needed. Full price (no batch discount):
 * use for one seat, a small pilot, or when an answer is needed immediately.
 */
export async function runSync(db: Db, client: Anthropic, runId: number, c: Config = cfg(), onProgress?: (msg: string) => void): Promise<SyncResult> {
  let done = 0;
  let stoppedForCap = false;
  for (;;) {
    const run = getRun(db, runId);
    if (run.status === 'canceled') break;
    const planned = db.prepare(`SELECT * FROM run_items WHERE run_id = ? AND state = 'planned' ORDER BY tier, id LIMIT ?`).all(runId, c.syncConcurrency) as ItemRow[];
    if (!planned.length) break;
    if (run.actual_cost_usd >= run.spend_cap_usd) {
      stoppedForCap = true;
      break;
    }
    db.prepare(`UPDATE run_items SET state = 'submitted' WHERE id IN (${planned.map((p) => p.id).join(',')})`).run();
    await Promise.all(
      planned.map(async (item) => {
        const seat = getSeatContext(db, item.seat_id)!;
        let outcome: Outcome;
        try {
          const message = await callMessages(client, buildParams(seat, item.tier, run.kind, new Date(), c));
          outcome = { kind: 'message', message };
        } catch (e) {
          outcome = { kind: 'error', error: (e as Error).message, retryable: true };
        }
        const res = processOutcome(db, runId, { ...item, state: 'submitted' }, outcome, false, c);
        done++;
        onProgress?.(`${seat.agencyName} · ${seat.roleLabel} · tier ${item.tier}${res.escalated ? ' → escalating' : ''}`);
      }),
    );
  }
  refreshRunStatus(db, runId);
  return { done, stoppedForCap };
}

/** Check one seat right now (all tiers it needs), at full price. Used by the "Check now" button. */
export async function verifySeatNow(db: Db, client: Anthropic, seatId: number, opts: { maxTier?: Tier; capUsd?: number } = {}, c: Config = cfg()): Promise<{ runId: number; checkId: number | null }> {
  const seat = getSeatContext(db, seatId);
  if (!seat) throw new Error(`No seat ${seatId}`);
  const kind: RunKind = seat.contactId ? 'verify' : 'discover';
  const { runId, seats } = createRun(db, { seatIds: [seatId], kind, includeFresh: true, ignoreCooldown: true }, { kind, batch: false, maxTier: opts.maxTier, capUsd: opts.capUsd ?? 1 }, c);
  if (seats === 0) throw new Error('This seat is already queued or waiting in the review queue.');
  await runSync(db, client, runId, c);
  const last = db.prepare(`SELECT id FROM checks WHERE seat_id = ? AND run_id = ? ORDER BY id DESC LIMIT 1`).get(seatId, runId) as { id: number } | undefined;
  return { runId, checkId: last?.id ?? null };
}

export async function cancelRun(db: Db, client: Anthropic | null, runId: number): Promise<void> {
  const batches = db.prepare(`SELECT DISTINCT batch_id FROM run_items WHERE run_id = ? AND state = 'submitted' AND batch_id IS NOT NULL`).all(runId) as { batch_id: string }[];
  if (client) for (const b of batches) await client.messages.batches.cancel(b.batch_id).catch(() => undefined);
  db.transaction(() => {
    db.prepare(`UPDATE run_items SET state = 'skipped' WHERE run_id = ? AND state = 'planned'`).run(runId);
    db.prepare(`UPDATE runs SET status = 'canceled' WHERE id = ?`).run(runId);
  })();
}

/** Counts straight from the database, never from a model's account of its own work. */
export function runSummary(db: Db, runId: number) {
  const run = getRun(db, runId);
  const items = db.prepare(`SELECT tier, state, COUNT(*) n FROM run_items WHERE run_id = ? GROUP BY tier, state`).all(runId) as { tier: number; state: string; n: number }[];
  const checks = db
    .prepare(`SELECT status, COUNT(*) n, ROUND(SUM(cost_usd),4) usd, SUM(searches_used) searches FROM checks WHERE run_id = ? GROUP BY status`)
    .all(runId) as { status: string; n: number; usd: number; searches: number }[];
  const byTier = db
    .prepare(`SELECT tier, COUNT(*) n, ROUND(SUM(cost_usd),4) usd, ROUND(AVG(cost_usd),5) avg_usd FROM checks WHERE run_id = ? GROUP BY tier ORDER BY tier`)
    .all(runId) as { tier: number; n: number; usd: number; avg_usd: number }[];
  return { run, items, checks, byTier };
}
