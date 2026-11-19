import path from 'node:path';
import type { Confidence } from './types';

/** All tunables in one place. Read from the environment (see .env.example). */
function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function bool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}
function str(name: string, dflt: string): string {
  const v = process.env[name];
  return v == null || v === '' ? dflt : v;
}

export function cfg() {
  const root = process.cwd();
  return {
    root,
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    databasePath: path.resolve(/* turbopackIgnore: true */ root, str('DATABASE_PATH', './data/yellowbook.sqlite')),
    rawDir: path.resolve(/* turbopackIgnore: true */ root, str('RAW_DIR', './data/raw')),

    // The cost ladder. Tier 1 reads the agency's own site with a cheap model and no paid search.
    // Tier 2 adds web search for what tier 1 could not settle. Tier 3 (off by default) retries with a stronger model.
    modelT1: str('MODEL_T1', 'claude-haiku-5-5'),
    modelT2: str('MODEL_T2', 'claude-haiku-5-5'),
    modelT3: str('MODEL_T3', 'claude-sonnet-5-5'),
    maxTier: Math.min(3, Math.max(1, num('MAX_TIER', 2))) as 1 | 2 | 3,

    t1MaxFetches: num('T1_MAX_FETCHES', 4),
    t2MaxSearches: num('T2_MAX_SEARCHES', 2),
    t2MaxFetches: num('T2_MAX_FETCHES', 3),
    maxContentTokens: num('MAX_CONTENT_TOKENS', 12000),
    maxOutputTokens: num('MAX_OUTPUT_TOKENS', 1500),

    useBatch: bool('USE_BATCH', true),
    batchChunk: num('BATCH_CHUNK', 5000),
    syncConcurrency: num('SYNC_CONCURRENCY', 4),

    maxRunCostUsd: num('MAX_RUN_COST_USD', 25),
    staleMonths: num('STALE_MONTHS', 12),
    /** Seats whose last check ended "searched, found nothing" are left alone this many days. */
    cooldownDays: num('COOLDOWN_DAYS', 30),
    escalateBelow: str('ESCALATE_BELOW', 'Medium') as Confidence,
    /** Confirmations at or above this confidence are accepted without a human. Replacements never are. */
    autoAcceptAtOrAbove: str('AUTO_ACCEPT', 'High') as Confidence | 'None',
    qcSampleRate: num('QC_SAMPLE_RATE', 0.05),
    /** Planning guess until real runs supply a measured rate: share of seats that tier 1 cannot settle. */
    escalationRateGuess: num('ESCALATION_RATE_GUESS', 0.4),
  };
}

export type Config = ReturnType<typeof cfg>;
