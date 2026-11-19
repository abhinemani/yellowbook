import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptCheck, acceptConfirmations, listPending, rejectCheck } from '../src/lib/review';
import { collectRun, createRun, planRun, processOutcome, runSummary, runSync, submitWave, verifySeatNow } from '../src/lib/runs';
import { selectSeats } from '../src/lib/seats';
import { exportCsv } from '../src/lib/export';
import { fakeClient, fakeMessage, fixtureDb, result, seatId } from './helpers';

beforeAll(() => {
  process.env.QC_SAMPLE_RATE = '0';
  process.env.REVIEW_MODE = 'queue'; // most tests cover the human review queue; the auto mode has its own block
  process.env.RAW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-raw-'));
});

const EX_STAFF = { url: 'https://www.examplecounty.gov/staff', text: 'Jane Doe, Purchasing Agent. jane.doe@examplecounty.gov 555-0100' };
const SV_HOME = { url: 'https://samplecity.org', text: 'Welcome to Sampleville.' };
const SV_STAFF = { url: 'https://samplecity.org/finance/purchasing', text: 'Purchasing Manager: Alex New, alex.new@samplecity.org, 555-0210' };

/** Tier 1 settles Example County; Sampleville needs tier 2, where a replacement is found. */
function script(db: ReturnType<typeof fixtureDb>, svOver: Record<string, unknown> = {}) {
  const ex = seatId(db, 'Example County', 'head_of_purchasing');
  const sv = seatId(db, 'Sampleville', 'head_of_purchasing');
  return (cid: string, params: any) => {
    const tools = params.tools.map((t: any) => t.name).join(',');
    if (cid.includes(`-s${ex}-t1`) || (cid === 'sync' && params.messages[0].content.includes('Jane Doe')))
      return fakeMessage(result(), { fetches: [EX_STAFF] });
    if (tools === 'web_fetch')
      return fakeMessage(result({ status: 'unable_to_confirm', found_name: null, found_title: null, found_email: null, found_phone: null, source_url: null, evidence_date: null, confidence: null, unresolved_reason: 'no_staff_listed' }), { fetches: [SV_HOME] });
    void sv;
    return fakeMessage(
      result({ status: 'replaced', found_name: 'Alex New', found_title: 'Purchasing Manager', found_email: 'alex.new@samplecity.org', found_phone: '555-0210', source_url: SV_STAFF.url, evidence_date: '2026-05-01', confidence: 'High', ...svOver }),
      { searchUrls: [SV_STAFF.url], fetches: [SV_STAFF], inputTokens: 30000, outputTokens: 500 },
    );
  };
}

describe('planning and the tier ladder', () => {
  it('plans a run, estimates its cost, and sends nothing', () => {
    const db = fixtureDb();
    const { seats, estimate } = planRun(db, { roles: ['head_of_purchasing'] });
    expect(seats.map((s) => s.agencyName).sort()).toEqual(['City of Sampleville', 'Example County']);
    expect(estimate.seats).toBe(2);
    expect(estimate.startAtTier1).toBe(2);
    expect(estimate.expectedTotalUsd).toBeGreaterThan(0);
    expect(estimate.ceilingUsd).toBeGreaterThanOrEqual(estimate.expectedTotalUsd);
    expect(estimate.batch).toBe(true);
  });

  it('tier 1 is fetch-only on the cheap model, restricted to the agency domain; tier 2 adds search', async () => {
    const db = fixtureDb();
    const client = fakeClient(script(db));
    const { runId } = createRun(db, { roles: ['head_of_purchasing'] });
    await submitWave(db, client, runId);
    const t1 = client.sent[0].params;
    expect(t1.model).toBe('claude-haiku-5-5');
    expect(t1.tools.map((t: any) => t.name)).toEqual(['web_fetch']);
    expect(t1.tools[0].allowed_domains.length).toBeGreaterThan(0);
    expect(t1.tools[0].max_content_tokens).toBe(8000);
    expect(t1.messages[0].content).toContain('https://');
    await collectRun(db, client, runId);
    await submitWave(db, client, runId);
    const t2 = client.sent.at(-1)!.params;
    expect(t2.tools.map((t: any) => t.name)).toEqual(['web_search', 'web_fetch']);
    expect(t2.tools[0].max_uses).toBe(2);
    expect(t2.tools[0].blocked_domains).toContain('zoominfo.com');
  });

  it('settles the easy seat at tier 1 and escalates only the unsettled one', async () => {
    const db = fixtureDb();
    const client = fakeClient(script(db));
    const { runId } = createRun(db, { roles: ['head_of_purchasing'] });
    await submitWave(db, client, runId);
    const c1 = await collectRun(db, client, runId);
    expect(c1.processed).toBe(2);
    expect(c1.escalated).toBe(1);
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);

    const sum = runSummary(db, runId);
    expect(sum.run.status).toBe('done');
    expect(sum.byTier.map((t) => [t.tier, t.n])).toEqual([[1, 2], [2, 1]]);
    // the escalated tier-1 result is superseded, not queued for review
    const t1Sv = db.prepare(`SELECT review_state FROM checks WHERE tier = 1 AND status = 'unable_to_confirm'`).get() as any;
    expect(t1Sv.review_state).toBe('not_needed');
    // Example County auto-accepted (High, nothing changed); Sampleville's replacement waits for a human
    const pending = listPending(db);
    expect(pending.map((p) => [p.agency, p.status, p.found_name])).toEqual([['City of Sampleville', 'replaced', 'Alex New']]);
    expect(db.prepare(`SELECT last_checked_at FROM seats WHERE id = ?`).get(seatId(db, 'Example County', 'head_of_purchasing'))).not.toEqual({ last_checked_at: null });
    // money: counts and dollars come from stored usage
    expect(sum.run.actual_cost_usd).toBeGreaterThan(0);
    const tier2 = sum.byTier.find((t) => t.tier === 2)!;
    const tier1 = sum.byTier.find((t) => t.tier === 1)!;
    expect(tier2.avg_usd).toBeGreaterThan(tier1.avg_usd * 3); // the paid search is what costs
  });

  it('never sends a seat to the API twice, and skips seats awaiting review', async () => {
    const db = fixtureDb();
    const client = fakeClient(script(db));
    const { runId } = createRun(db, { roles: ['head_of_purchasing'] });
    expect(selectSeats(db, { roles: ['head_of_purchasing'] })).toHaveLength(0); // all in flight
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    // Sampleville is pending review, Example County was accepted this minute: nothing is due
    expect(selectSeats(db, { roles: ['head_of_purchasing'] })).toHaveLength(0);
  });

  it('stops at the spend cap and leaves the rest planned', async () => {
    const db = fixtureDb();
    const client = fakeClient(script(db));
    const { runId } = createRun(db, { roles: ['head_of_purchasing'] }, { capUsd: 0.0001 });
    const w = await submitWave(db, client, runId);
    expect(w.submitted).toBe(0);
    expect(w.deferredForCap).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) n FROM run_items WHERE run_id = ? AND state = 'planned'`).get(runId)).toEqual({ n: 2 });
  });

  it('respects MAX_TIER=1', async () => {
    const db = fixtureDb();
    const client = fakeClient(script(db));
    const { runId } = createRun(db, { roles: ['head_of_purchasing'] }, { maxTier: 1 });
    await submitWave(db, client, runId);
    const c = await collectRun(db, client, runId);
    expect(c.escalated).toBe(0);
    expect(runSummary(db, runId).run.status).toBe('done');
  });
});

describe('failures are recorded honestly', () => {
  it('a confident answer with no tool use is discarded as not_searched and escalates', async () => {
    const db = fixtureDb();
    const client = fakeClient(() => fakeMessage(result())); // no fetches: answered from memory
    const { runId } = createRun(db, { roles: ['head_of_purchasing'] });
    await submitWave(db, client, runId);
    const c = await collectRun(db, client, runId);
    expect(c.escalated).toBe(2);
    const row = db.prepare(`SELECT status, unresolved_reason, found_name FROM checks WHERE tier = 1 LIMIT 1`).get() as any;
    expect(row).toEqual({ status: 'unable_to_confirm', unresolved_reason: 'not_searched', found_name: null });
  });

  it('retries invalid JSON once, then stores model_error without escalating', async () => {
    const db = fixtureDb();
    const client = fakeClient(() => fakeMessage('I could not do that.', { fetches: [EX_STAFF] }));
    const { runId } = createRun(db, { roles: ['head_of_purchasing'], limit: 1 } as any);
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    expect(db.prepare(`SELECT COUNT(*) n FROM checks WHERE run_id = ?`).get(runId)).toEqual({ n: 0 }); // first failure: retry
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    const rows = db.prepare(`SELECT status, unresolved_reason, tier FROM checks WHERE run_id = ?`).all(runId) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'unable_to_confirm' && r.unresolved_reason === 'model_error' && r.tier === 1)).toBe(true);
    // the failed attempts were still paid for and are counted
    expect(runSummary(db, runId).run.actual_cost_usd).toBeGreaterThan(0);
  });

  it('a blocked fetch is reported as fetch_blocked, not as "nobody found"', async () => {
    const db = fixtureDb();
    const client = fakeClient((_, params) =>
      params.tools.length === 1
        ? fakeMessage(result({ status: 'unable_to_confirm', found_name: null, found_email: null, found_phone: null, source_url: null, evidence_date: null, confidence: null, unresolved_reason: 'no_current_source' }), { errors: [{ tool: 'web_fetch', code: 'url_not_allowed' }] })
        : fakeMessage(result({ status: 'unable_to_confirm', found_name: null, found_email: null, found_phone: null, source_url: null, evidence_date: null, confidence: null, unresolved_reason: 'no_current_source' }), { errors: [{ tool: 'web_search', code: 'max_uses_exceeded' }] }),
    );
    const { runId } = createRun(db, { roles: ['head_of_purchasing'] });
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    const reasons = (db.prepare(`SELECT tier, unresolved_reason r FROM checks WHERE run_id = ? ORDER BY tier`).all(runId) as any[]).map((x) => [x.tier, x.r]);
    expect(reasons).toContainEqual([1, 'fetch_blocked']);
    expect(reasons).toContainEqual([2, 'budget_exhausted']);
  });

  it('retries a batch item that errored at the API', async () => {
    const db = fixtureDb();
    let first = true;
    const client = fakeClient((cid, p) => {
      if (first) { first = false; return new Error('overloaded'); }
      return fakeMessage(result(), { fetches: [EX_STAFF] }) as any;
    });
    const { runId } = createRun(db, { roles: ['head_of_purchasing'], seatIds: [seatId(db, 'Example County', 'head_of_purchasing')] });
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    expect(db.prepare(`SELECT state, attempts FROM run_items WHERE run_id = ?`).get(runId)).toEqual({ state: 'planned', attempts: 1 });
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    expect(db.prepare(`SELECT state FROM run_items WHERE run_id = ?`).get(runId)).toEqual({ state: 'done' });
  });

  it('cooldown: a seat that was searched and found nothing is not re-run for 30 days; a blocked one is', async () => {
    const db = fixtureDb();
    const sv = seatId(db, 'Sampleville', 'head_of_purchasing');
    const ins = (reason: string) => db.prepare(`INSERT INTO checks (seat_id, status, unresolved_reason, review_state, tier) VALUES (?, 'unable_to_confirm', ?, 'not_needed', 2)`).run(sv, reason);
    ins('no_current_source');
    expect(selectSeats(db, { roles: ['head_of_purchasing'] }).some((s) => s.seatId === sv)).toBe(false);
    expect(selectSeats(db, { roles: ['head_of_purchasing'], ignoreCooldown: true }).some((s) => s.seatId === sv)).toBe(true);
    ins('fetch_blocked');
    expect(selectSeats(db, { roles: ['head_of_purchasing'] }).some((s) => s.seatId === sv)).toBe(true);
  });
});

describe('synchronous check of one seat', () => {
  it('climbs tiers in one call at full price', async () => {
    const db = fixtureDb();
    const client = fakeClient(script(db));
    const { checkId } = await verifySeatNow(db, client, seatId(db, 'Sampleville', 'head_of_purchasing'));
    const row = db.prepare(`SELECT tier, status, cost_usd FROM checks WHERE id = ?`).get(checkId) as any;
    expect(row.tier).toBe(2);
    expect(row.status).toBe('replaced');
    expect(db.prepare(`SELECT COUNT(*) n FROM checks`).get()).toEqual({ n: 2 });
    void runSync; void processOutcome;
  });
});

describe('review: accepting is a human action and history is kept', () => {
  async function withReplacement() {
    const db = fixtureDb();
    const client = fakeClient(script(db));
    const { runId } = createRun(db, { roles: ['head_of_purchasing'] });
    for (let i = 0; i < 2; i++) { await submitWave(db, client, runId); await collectRun(db, client, runId); }
    return db;
  }

  it('accept creates a new contact, supersedes the old one, and points the seat at the new one', async () => {
    const db = await withReplacement();
    const sv = seatId(db, 'Sampleville', 'head_of_purchasing');
    const before = db.prepare(`SELECT current_contact_id c FROM seats WHERE id = ?`).get(sv) as any;
    const [p] = listPending(db);
    acceptCheck(db, p.id);
    const after = db.prepare(`SELECT current_contact_id c, last_checked_at FROM seats WHERE id = ?`).get(sv) as any;
    expect(after.c).not.toBe(before.c);
    expect(after.last_checked_at).not.toBeNull();
    const old = db.prepare(`SELECT status, superseded_by FROM contacts WHERE id = ?`).get(before.c) as any;
    expect(old).toEqual({ status: 'superseded', superseded_by: after.c });
    const neu = db.prepare(`SELECT first_name, last_name, email, source FROM contacts WHERE id = ?`).get(after.c) as any;
    expect(neu).toEqual({ first_name: 'Alex', last_name: 'New', email: 'alex.new@samplecity.org', source: 'web_check' });
    expect(() => acceptCheck(db, p.id)).toThrow(/not pending/);
  });

  it('reject changes nothing', async () => {
    const db = await withReplacement();
    const sv = seatId(db, 'Sampleville', 'head_of_purchasing');
    const before = db.prepare(`SELECT current_contact_id c FROM seats WHERE id = ?`).get(sv);
    const [p] = listPending(db);
    rejectCheck(db, p.id);
    expect(db.prepare(`SELECT current_contact_id c FROM seats WHERE id = ?`).get(sv)).toEqual(before);
    expect(db.prepare(`SELECT review_state FROM checks WHERE id = ?`).get(p.id)).toEqual({ review_state: 'rejected' });
  });

  it('bulk accept never touches replacements', async () => {
    const db = await withReplacement();
    expect(acceptConfirmations(db, 'Low')).toBe(0);
    expect(listPending(db)).toHaveLength(1);
  });

  it('a confirmation that brings a verified new email is a human decision and keeps history', async () => {
    const db = fixtureDb();
    const ex = seatId(db, 'Example County', 'head_of_purchasing');
    const client = fakeClient(() => fakeMessage(result({ found_email: 'j.doe@examplecounty.gov' }), { fetches: [{ ...EX_STAFF, text: 'Jane Doe j.doe@examplecounty.gov' }] }));
    const { runId } = createRun(db, { seatIds: [ex] });
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    const [p] = listPending(db);
    expect(p.status).toBe('confirmed_in_role');
    const old = (db.prepare(`SELECT current_contact_id c FROM seats WHERE id = ?`).get(ex) as any).c;
    acceptCheck(db, p.id);
    const cur = (db.prepare(`SELECT current_contact_id c FROM seats WHERE id = ?`).get(ex) as any).c;
    expect(cur).not.toBe(old);
    expect(db.prepare(`SELECT email, power_almanac_person_id FROM contacts WHERE id = ?`).get(cur)).toEqual({ email: 'j.doe@examplecounty.gov', power_almanac_person_id: '100000000000001-AAA1111' });
    expect(db.prepare(`SELECT email, status FROM contacts WHERE id = ?`).get(old)).toEqual({ email: 'jane.doe@examplecounty.gov', status: 'superseded' });
  });
});

describe('export', () => {
  it('has the Power Almanac columns first, then the check columns, one row per seat', async () => {
    const db = fixtureDb();
    const csv = exportCsv(db, { roles: ['head_of_purchasing'] });
    const [header, ...lines] = csv.trim().split('\n');
    expect(header.startsWith('Email Address,First Name,Last Name,Title,Government Designated Name,Person ID')).toBe(true);
    expect(header.endsWith('Check Status,Current Name,Current Title,Current Email,Current Phone,Source URL,Confidence,Check Notes,Review State,Checked At,Email Domain Status,Email Quality,Office Mailbox')).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Not checked');
  });
});

import { addAgency, addSeat, searchAgenciesLocal } from '../src/lib/findAgency';
import { buildParams } from '../src/lib/verifier';
import { getSeatContext } from '../src/lib/seats';

describe('adding agencies and seats by hand', () => {
  it('adds an agency with empty seats, finds it locally, and does not duplicate', () => {
    const db = fixtureDb();
    const a = { name: 'Boone County', category: 'county' as const, state: 'MO', county: null, population: 180000, website: 'https://www.showmeboone.com', main_phone: null, street_address: null, city: null, zip: null, source_url: 'https://www.showmeboone.com' };
    const id = addAgency(db, a, 'web_lookup', ['head_of_purchasing', 'head_of_finance']);
    expect(addAgency(db, a, 'web_lookup', ['head_of_purchasing'])).toBe(id);
    expect(searchAgenciesLocal(db, 'boone', 'MO').map((x) => x.id)).toEqual([id]);
    const seats = db.prepare('SELECT role_key, current_contact_id FROM seats WHERE agency_id = ? ORDER BY role_key').all(id);
    expect(seats).toEqual([{ role_key: 'head_of_finance', current_contact_id: null }, { role_key: 'head_of_purchasing', current_contact_id: null }]);
    expect(db.prepare('SELECT source FROM agencies WHERE id = ?').get(id)).toEqual({ source: 'web_lookup' });
  });

  it('addSeat keeps one seat for single-holder roles and numbers deputies', () => {
    const db = fixtureDb();
    const ag = (db.prepare(`SELECT id FROM agencies WHERE name = 'Example County'`).get() as any).id;
    addSeat(db, ag, 'head_of_purchasing');
    expect((db.prepare(`SELECT COUNT(*) n FROM seats WHERE agency_id = ? AND role_key = 'head_of_purchasing'`).get(ag) as any).n).toBe(1);
    addSeat(db, ag, 'deputy_top_appointed_executive');
    addSeat(db, ag, 'deputy_top_appointed_executive');
    expect(db.prepare(`SELECT slot FROM seats WHERE agency_id = ? AND role_key = 'deputy_top_appointed_executive' ORDER BY slot`).all(ag)).toEqual([{ slot: 1 }, { slot: 2 }]);
    expect(() => addSeat(db, ag, 'no_such_role')).toThrow();
  });

  it('an empty seat builds a discover prompt with no listed person and starts at tier 2 when there is no website', () => {
    const db = fixtureDb();
    const id = addAgency(db, { name: 'Nowebsite Township', category: 'township', state: 'OH', county: 'Lake', population: 900, website: null, main_phone: null, street_address: null, city: null, zip: null, source_url: null }, 'manual', ['head_of_finance']);
    const seat = getSeatContext(db, (db.prepare('SELECT id FROM seats WHERE agency_id = ?').get(id) as any).id)!;
    const p = buildParams(seat, 2, 'discover', new Date('2026-11-19'));
    const text = String(p.messages[0].content);
    expect(text).toContain('Find who currently holds this seat');
    expect(text).toContain('no website on file');
    expect(text).not.toMatch(/\{\{/);
    expect(p.tools!.map((t: any) => t.name)).toEqual(['web_search', 'web_fetch']);
  });

  it('every check request carries the result schema as a structured output, in the dialect the API accepts', () => {
    const db = fixtureDb();
    const id = addAgency(db, { name: 'Schema Township', category: 'township', state: 'OH', county: 'Lake', population: 900, website: 'schema.example.gov', main_phone: null, street_address: null, city: null, zip: null, source_url: null }, 'manual', ['head_of_finance']);
    const seat = getSeatContext(db, (db.prepare('SELECT id FROM seats WHERE agency_id = ?').get(id) as any).id)!;
    for (const tier of [1, 2] as const) {
      const schema = (buildParams(seat, tier, 'verify', new Date('2026-11-19')) as any).output_config.format.schema;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain('found_name');
      for (const prop of Object.values(schema.properties) as any[]) expect(prop.enum && Array.isArray(prop.type)).toBeFalsy();
      expect(schema.properties.confidence.anyOf).toEqual([{ type: 'string', enum: ['High', 'Medium', 'Low'] }, { type: 'null' }]);
    }
  });
});

describe('auto review mode (owner decision): findings are applied without a queue, history kept, weak names added', () => {
  beforeAll(() => { process.env.REVIEW_MODE = 'auto'; });
  afterAll(() => { process.env.REVIEW_MODE = 'queue'; });

  async function runOnce(db: ReturnType<typeof fixtureDb>, svOver: Record<string, unknown> = {}) {
    const client = fakeClient(script(db, svOver));
    const { runId } = createRun(db, { roles: ['head_of_purchasing'], includeFresh: true, ignoreCooldown: true });
    for (let i = 0; i < 2; i++) { await submitWave(db, client, runId); await collectRun(db, client, runId); }
  }
  const holders = (db: ReturnType<typeof fixtureDb>) =>
    db.prepare(`SELECT s.slot, c.first_name || ' ' || c.last_name who FROM seats s JOIN agencies a ON a.id = s.agency_id JOIN contacts c ON c.id = s.current_contact_id
                WHERE a.name LIKE '%Sampleville%' AND s.role_key = 'head_of_purchasing' ORDER BY s.slot`).all();

  it('a clear replacement takes the seat at once, the old contact is superseded, nothing waits for review', async () => {
    const db = fixtureDb();
    const sv = seatId(db, 'Sampleville', 'head_of_purchasing');
    const before = (db.prepare(`SELECT current_contact_id c FROM seats WHERE id = ?`).get(sv) as any).c;
    await runOnce(db);
    expect(listPending(db)).toHaveLength(0);
    expect(holders(db)).toEqual([{ slot: 1, who: 'Alex New' }]);
    expect(db.prepare(`SELECT status FROM contacts WHERE id = ?`).get(before)).toEqual({ status: 'superseded' });
  });

  it('an unclear or Low-confidence name is added beside the current holder, not in place of them', async () => {
    const db = fixtureDb();
    const listed = holders(db) as any[];
    await runOnce(db, { status: 'unclear', confidence: 'Low', found_email: null, unresolved_reason: 'no_current_source' });
    expect(holders(db)).toEqual([listed[0], { slot: 2, who: 'Alex New' }]);
  });

  it('finding the same person again never adds a duplicate holder', async () => {
    const db = fixtureDb();
    const over = { status: 'unclear', confidence: 'Low', found_email: null, unresolved_reason: 'no_current_source' };
    await runOnce(db, over);
    await runOnce(db, over);
    expect((holders(db) as any[]).map((h) => h.who).filter((w) => w === 'Alex New')).toHaveLength(1);
    expect(holders(db)).toHaveLength(2);
  });
});
