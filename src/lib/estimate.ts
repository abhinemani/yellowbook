import { cfg, type Config } from './config';
import type { Db } from './db';
import { costUsd } from './pricing';
import { modelFor, firstTier } from './verifier';
import { needsEscalation } from './rules';
import type { SeatContext, Tier } from './types';

export interface TierAssumption {
  inputTokens: number;
  outputTokens: number;
  searches: number;
  basis: 'default' | 'measured';
  samples: number;
}

/**
 * Starting guesses, to be replaced by measured averages as checks accumulate (>= MIN_SAMPLES per tier).
 * Tier 1: ~1.5k prompt + up to 4 fetched pages (~2.5-3k tokens each at the 12k content cap).
 * Tier 2/3: same prompt + 2 searches of results (~5k each) + up to 3 pages.
 */
const DEFAULTS: Record<Tier, Omit<TierAssumption, 'basis' | 'samples'>> = {
  1: { inputTokens: 14_000, outputTokens: 450, searches: 0 },
  2: { inputTokens: 32_000, outputTokens: 600, searches: 2 },
  3: { inputTokens: 32_000, outputTokens: 600, searches: 2 },
};
const MIN_SAMPLES = 20;

export function tierAssumptions(db: Db): Record<Tier, TierAssumption> {
  const out = {} as Record<Tier, TierAssumption>;
  for (const t of [1, 2, 3] as Tier[]) {
    const row = db
      .prepare(
        `SELECT COUNT(*) n, AVG(input_tokens) i, AVG(output_tokens) o, AVG(searches_used) s
         FROM checks WHERE tier = ? AND input_tokens IS NOT NULL AND validation_error IS NULL`,
      )
      .get(t) as { n: number; i: number | null; o: number | null; s: number | null };
    out[t] =
      row.n >= MIN_SAMPLES
        ? { inputTokens: row.i ?? 0, outputTokens: row.o ?? 0, searches: row.s ?? 0, basis: 'measured', samples: row.n }
        : { ...DEFAULTS[t], basis: 'default', samples: row.n };
  }
  return out;
}

/** Share of tier-1 checks that needed tier 2. Measured once there is enough history, else a planning guess. */
export function escalationRate(db: Db, c: Config = cfg()): { rate: number; basis: 'default' | 'measured'; samples: number } {
  const rows = db
    .prepare(`SELECT status, confidence, unresolved_reason FROM checks WHERE tier = 1 AND validation_error IS NULL`)
    .all() as { status: never; confidence: never; unresolved_reason: never }[];
  if (rows.length < 50) return { rate: c.escalationRateGuess, basis: 'default', samples: rows.length };
  const n = rows.filter((r) => needsEscalation(r, c.escalateBelow)).length;
  return { rate: n / rows.length, basis: 'measured', samples: rows.length };
}

export function tierCost(a: TierAssumption, tier: Tier, batch: boolean, c: Config = cfg()): number {
  return costUsd({ model: modelFor(tier, c), usage: { input_tokens: a.inputTokens, output_tokens: a.outputTokens }, searches: a.searches, batch });
}

export interface Estimate {
  seats: number;
  startAtTier1: number;
  startAtTier2: number;
  batch: boolean;
  tier1Usd: number;
  expectedEscalations: number;
  expectedTotalUsd: number;
  /** Every seat uses every enabled tier. The most this plan can cost if the assumptions hold. */
  ceilingUsd: number;
  perSeatExpectedUsd: number;
  basis: { tokens: 'default' | 'measured'; escalation: 'default' | 'measured'; escalationRate: number };
  cappedAtUsd: number;
}

export function estimateRun(db: Db, seats: SeatContext[], opts: { batch?: boolean; maxTier?: Tier } = {}, c: Config = cfg()): Estimate {
  const batch = opts.batch ?? c.useBatch;
  const maxTier = opts.maxTier ?? c.maxTier;
  const a = tierAssumptions(db);
  const esc = escalationRate(db, c);
  const t1 = seats.filter((s) => firstTier(s) === 1).length;
  const t2 = seats.length - t1;
  const c1 = tierCost(a[1], 1, batch, c);
  const c2 = tierCost(a[2], 2, batch, c);
  const c3 = tierCost(a[3], 3, batch, c);

  const t1Cost = t1 * c1;
  const escalated = maxTier >= 2 ? t1 * esc.rate : 0;
  const t2Starts = t2;
  const t2Cost = maxTier >= 2 ? (escalated + t2Starts) * c2 : 0;
  // Of those that reach tier 2, assume the same share fail again and go to tier 3 (only if enabled).
  const t3Cost = maxTier >= 3 ? (escalated + t2Starts) * esc.rate * c3 : 0;
  const expected = t1Cost + t2Cost + t3Cost;
  const ceiling = t1 * (c1 + (maxTier >= 2 ? c2 : 0) + (maxTier >= 3 ? c3 : 0)) + t2 * ((maxTier >= 2 ? c2 : 0) + (maxTier >= 3 ? c3 : 0));
  return {
    seats: seats.length,
    startAtTier1: t1,
    startAtTier2: t2,
    batch,
    tier1Usd: t1Cost,
    expectedEscalations: Math.round(escalated),
    expectedTotalUsd: expected,
    ceilingUsd: ceiling,
    perSeatExpectedUsd: seats.length ? expected / seats.length : 0,
    basis: { tokens: a[1].basis === 'measured' && a[2].basis === 'measured' ? 'measured' : 'default', escalation: esc.basis, escalationRate: esc.rate },
    cappedAtUsd: c.maxRunCostUsd,
  };
}

export function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}
