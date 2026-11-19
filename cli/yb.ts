import 'dotenv/config';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { parse } from 'csv-parse/sync';
import { getClient } from '../src/lib/client';
import { cfg } from '../src/lib/config';
import { openDb } from '../src/lib/db';
import { usd } from '../src/lib/estimate';
import { exportCsv, statusLabel } from '../src/lib/export';
import { importPowerAlmanac } from '../src/lib/importer';
import { cancelRun, collectRun, createRun, getRun, planRun, refreshRunStatus, runSummary, runSync, submitWave } from '../src/lib/runs';
import type { Scope } from '../src/lib/seats';
import type { RunKind, Tier } from '../src/lib/types';

const HELP = `yellowbook CLI

  yb import <file.csv...>            import Power Almanac exports (any role file)
  yb plan   [scope]                  show seats and estimated cost. Sends nothing.
  yb run    [scope] --yes            start a run (batch by default, half price). Add --sync for immediate full-price results.
  yb watch  <runId>                  poll batches, process results, submit the next tier, until the run is done
  yb collect <runId>                 one poll-and-process pass
  yb status [runId]                  counts and dollars from the database
  yb cancel <runId>
  yb export <out.csv> [--roles a,b]  Power Almanac columns plus check columns
  yb compare <earlier_checked.csv>   compare stored checks with an earlier manual pass (benchmark)

scope:  --roles head_of_purchasing,head_of_finance  --states MO,KS  --category county  --min-pop 50000  --max-pop N
        --limit 25  --kind verify|discover  --max-tier 1|2|3  --cap 25 (USD)  --include-fresh  --ignore-cooldown
`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    roles: { type: 'string' }, states: { type: 'string' }, category: { type: 'string' },
    'min-pop': { type: 'string' }, 'max-pop': { type: 'string' }, limit: { type: 'string' },
    kind: { type: 'string' }, 'max-tier': { type: 'string' }, cap: { type: 'string' },
    sync: { type: 'boolean' }, yes: { type: 'boolean' }, 'include-fresh': { type: 'boolean' }, 'ignore-cooldown': { type: 'boolean' },
    interval: { type: 'string' },
  },
});
const [cmd, ...rest] = positionals;

function scope(): Scope {
  const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  return {
    roles: list(v.roles), states: list(v.states), category: v.category,
    minPop: v['min-pop'] ? Number(v['min-pop']) : undefined, maxPop: v['max-pop'] ? Number(v['max-pop']) : undefined,
    limit: v.limit ? Number(v.limit) : undefined, kind: (v.kind as RunKind | undefined) ?? 'verify',
    includeFresh: v['include-fresh'], ignoreCooldown: v['ignore-cooldown'],
  };
}
const runOpts = () => ({ kind: scope().kind, maxTier: v['max-tier'] ? (Number(v['max-tier']) as Tier) : undefined, batch: v.sync ? false : undefined, capUsd: v.cap ? Number(v.cap) : undefined });

function printEstimate(db: ReturnType<typeof openDb>) {
  const { seats, estimate: e } = planRun(db, scope(), runOpts());
  const mode = e.batch ? 'Batch API (50% off tokens)' : 'Messages API (full price)';
  console.log(`\n${e.seats} seats  (${e.startAtTier1} start at tier 1 fetch-only, ${e.startAtTier2} start at tier 2 with search)   ${mode}`);
  console.log(`Tier 1 cost             ${usd(e.tier1Usd)}`);
  console.log(`Expected total          ${usd(e.expectedTotalUsd)}   (about ${usd(e.perSeatExpectedUsd)} per seat; ~${e.expectedEscalations} seats expected to need tier 2)`);
  console.log(`Ceiling if all escalate ${usd(e.ceilingUsd)}`);
  console.log(`Spend cap               ${usd(v.cap ? Number(v.cap) : e.cappedAtUsd)}  (no new batch is sent past this)`);
  console.log(`Basis: token use ${e.basis.tokens}, escalation rate ${(e.basis.escalationRate * 100).toFixed(0)}% ${e.basis.escalation}. Replace with measured numbers after a pilot.`);
  if (seats.length) console.log(`Largest: ${seats.slice(0, 3).map((s) => `${s.agencyName} ${s.state}`).join('; ')}`);
  return e;
}

async function watch(db: ReturnType<typeof openDb>, runId: number) {
  const client = getClient();
  const every = Number(v.interval ?? 60) * 1000;
  for (;;) {
    const w = await submitWave(db, client, runId);
    if (w.submitted) console.log(`submitted ${w.submitted} request(s) in ${w.batchIds.length} batch(es)`);
    if (w.deferredForCap) console.log(`${w.deferredForCap} request(s) held back by the spend cap`);
    const c = await collectRun(db, client, runId);
    if (c.processed) console.log(`processed ${c.processed}, escalated ${c.escalated}`);
    const run = getRun(db, runId);
    const open = (db.prepare(`SELECT COUNT(*) n FROM run_items WHERE run_id = ? AND state IN ('planned','submitted')`).get(runId) as { n: number }).n;
    if (open === 0 || run.status === 'canceled') break;
    const planned = (db.prepare(`SELECT COUNT(*) n FROM run_items WHERE run_id = ? AND state = 'planned'`).get(runId) as { n: number }).n;
    const submitted = open - planned;
    if (submitted === 0 && w.submitted === 0) { console.log('Nothing in flight and the cap holds the rest. Raise --cap or MAX_RUN_COST_USD and run watch again.'); break; }
    console.log(`waiting: ${submitted} in flight, ${planned} planned. Next check in ${every / 1000}s`);
    await new Promise((r) => setTimeout(r, every));
  }
  printStatus(db, runId);
}

function printStatus(db: ReturnType<typeof openDb>, runId: number) {
  const s = runSummary(db, runId);
  console.log(`\nRun ${runId} (${s.run.kind}) ${refreshRunStatus(db, runId)}  spent ${usd(s.run.actual_cost_usd)} of cap ${usd(s.run.spend_cap_usd)}  (estimated ${usd(s.run.est_cost_usd ?? 0)})`);
  console.log('Items: ' + (s.items.map((i) => `tier ${i.tier} ${i.state}: ${i.n}`).join(' | ') || 'none'));
  for (const t of s.byTier) console.log(`Tier ${t.tier}: ${t.n} checks, ${usd(t.usd)} total, ${usd(t.avg_usd)} average`);
  for (const c of s.checks) console.log(`  ${statusLabel(c.status).padEnd(18)} ${String(c.n).padStart(5)}`);
}

async function main() {
  const db = openDb();
  switch (cmd) {
    case 'import': {
      if (!rest.length) throw new Error('Give one or more CSV files.');
      for (const f of rest) {
        const r = importPowerAlmanac(db, f);
        console.log(`${f}: ${r.rows} rows, +${r.agenciesNew} agencies, +${r.contactsNew} contacts, +${r.seatsNew} seats, ${r.conflicts} conflicts, ${r.skipped} skipped${r.rolesCreated.length ? `, new roles: ${r.rolesCreated.join('; ')}` : ''}`);
      }
      break;
    }
    case 'plan':
      printEstimate(db);
      break;
    case 'run': {
      const e = printEstimate(db);
      if (!e.seats) { console.log('Nothing is due.'); break; }
      if (!v.yes) { console.log('\nDry run. Add --yes to start.'); break; }
      const { runId } = createRun(db, scope(), runOpts());
      console.log(`\nRun ${runId} created.`);
      if (v.sync) {
        const r = await runSync(db, getClient(), runId, cfg(), (m) => console.log('  ' + m));
        console.log(r.stoppedForCap ? 'Stopped at the spend cap.' : 'Done.');
        printStatus(db, runId);
      } else {
        await watch(db, runId);
      }
      break;
    }
    case 'watch':
      await watch(db, Number(rest[0]));
      break;
    case 'collect': {
      const c = await collectRun(db, getClient(), Number(rest[0]));
      console.log(c);
      printStatus(db, Number(rest[0]));
      break;
    }
    case 'status': {
      const id = rest[0] ? Number(rest[0]) : (db.prepare('SELECT MAX(id) id FROM runs').get() as { id: number | null }).id;
      if (!id) { console.log('No runs yet.'); break; }
      printStatus(db, id);
      break;
    }
    case 'cancel':
      await cancelRun(db, cfg().apiKey ? getClient() : null, Number(rest[0]));
      console.log('Canceled.');
      break;
    case 'export': {
      const out = rest[0];
      if (!out) throw new Error('Give an output file.');
      fs.writeFileSync(out, exportCsv(db, { roles: v.roles?.split(','), states: v.states?.split(',') }));
      console.log(`Wrote ${out}`);
      break;
    }
    case 'compare':
      compare(db, rest[0]);
      break;
    default:
      console.log(HELP);
  }
}

/** Benchmark: how does the stored result agree with an earlier manual pass (the Purchasing_checked CSV)? */
function compare(db: ReturnType<typeof openDb>, file: string) {
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: (h: string[]) => h.map((x) => x.trim()), bom: true, skip_empty_lines: true }) as Record<string, string>[];
  const tally = new Map<string, number>();
  const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
  for (const r of rows) {
    const old = r['Check Status'];
    if (!old || old === 'Not checked') continue;
    const row = db.prepare(
      `SELECT k.status, k.found_name FROM contacts c JOIN seats s ON s.agency_id = c.agency_id JOIN checks k ON k.seat_id = s.id
       WHERE c.power_almanac_person_id = ? AND s.role_key = 'head_of_purchasing' ORDER BY k.id DESC LIMIT 1`,
    ).get(r['Person ID']) as { status: string; found_name: string | null } | undefined;
    if (!row) { bump(`${old} -> not rechecked`); continue; }
    bump(`${old} -> ${statusLabel(row.status)}`);
  }
  console.log('Earlier manual status -> new status');
  for (const [k, n] of [...tally].sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

main().catch((e) => {
  console.error(`\nError: ${(e as Error).message}`);
  process.exit(1);
});
