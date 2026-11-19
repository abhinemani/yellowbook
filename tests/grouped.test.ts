import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectRun, createRun, submitWave } from '../src/lib/runs';
import { fakeClient, fakeMessage, fixtureDb, result } from './helpers';

beforeAll(() => {
  process.env.QC_SAMPLE_RATE = '0';
  process.env.REVIEW_MODE = 'queue';
  process.env.RAW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-raw-g-'));
});

// Invented agency pages. The staff page names Pat Lee with the generic purchasing mailbox; it never shows Sam Roe's address.
const SV_STAFF = { url: 'https://samplecity.org/staff', text: 'Staff directory. Purchasing: Pat Lee, purchasing@samplecity.org. City Manager: Sam Roe.' };
const NONE = { status: 'unable_to_confirm', found_name: null, found_title: null, found_email: null, found_phone: null, source_url: null, evidence_date: null, confidence: null, unresolved_reason: 'no_staff_listed' };

/** Answer a grouped request by reading which listed person each seat ref carries. `omit` drops refs from the answer. */
function groupScript(omit: string[] = []) {
  return (cid: string, params: any) => {
    const prompt = String(params.messages[0].content);
    if (!params.output_config?.format?.schema?.required?.includes('results')) {
      return fakeMessage(result(), { fetches: [{ url: 'https://www.examplecounty.gov/staff', text: 'Jane Doe, Purchasing Agent. jane.doe@examplecounty.gov 555-0100' }] });
    }
    const refs = [...prompt.matchAll(/\*\*(S\d+): ([^*]+)\*\*[^\n]*\n\s+([^\n]+)/g)];
    const results = refs
      .filter(([, ref]) => !omit.includes(ref))
      .map(([, ref, , who]) => {
        if (who.includes('Pat Lee')) return { seat_ref: ref, ...result({ found_name: 'Pat Lee', found_title: 'Purchasing Manager', found_email: 'purchasing@samplecity.org', found_email_is_generic: true, found_phone: null, source_url: SV_STAFF.url, evidence_date: null, confidence: 'Medium' }) };
        if (who.includes('Sam Roe')) return { seat_ref: ref, ...result({ found_name: 'Sam Roe', found_title: 'City Manager', found_email: 'sam.roe@samplecity.org', found_phone: null, source_url: SV_STAFF.url, evidence_date: null, confidence: 'Medium' }) };
        return { seat_ref: ref, ...result(NONE) };
      });
    return fakeMessage({ results }, { fetches: [SV_STAFF], inputTokens: 50000, outputTokens: 2500 });
  };
}

const svChecks = (db: ReturnType<typeof fixtureDb>, tier: number) =>
  db.prepare(`SELECT s.role_key, s.slot, k.status, k.found_email, k.cost_usd, k.raw_path FROM checks k JOIN seats s ON s.id = k.seat_id JOIN agencies a ON a.id = s.agency_id
              WHERE a.name LIKE '%Sampleville%' AND k.tier = ? ORDER BY s.role_key, s.slot`).all(tier) as any[];

describe('grouped requests: one call per agency, one check per seat, every rule still applied', () => {
  it('sends one request for an agency with several due seats and a plain request for a single seat', async () => {
    const db = fixtureDb();
    const client = fakeClient(groupScript());
    const { runId } = createRun(db, {}, { group: true, batch: true });
    await submitWave(db, client, runId);
    const ids = client.sent.map((s) => s.custom_id);
    expect(ids.filter((id) => /-g\d+-n5-/.test(id))).toHaveLength(1); // Sampleville's five seats together
    expect(ids.filter((id) => /-s\d+-t1$/.test(id)).length).toBeGreaterThanOrEqual(1); // Example County alone, as before
    const grouped = client.sent.find((s) => /-n5-/.test(s.custom_id))!;
    expect(grouped.params.output_config.format.schema.required).toEqual(['results']);
    expect(String(grouped.params.messages[0].content)).not.toMatch(/\{\{/);
  });

  it('splits the answer into a check per seat, shares the cost, stores the raw once, and still strips an email not on the page', async () => {
    const db = fixtureDb();
    const client = fakeClient(groupScript());
    const { runId } = createRun(db, {}, { group: true, batch: true });
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    const t1 = svChecks(db, 1);
    expect(t1).toHaveLength(5);
    expect(new Set(t1.map((k) => k.cost_usd)).size).toBe(1); // even share of one call
    expect(new Set(t1.map((k) => k.raw_path)).size).toBe(1); // one raw file for the group
    const purchasing = t1.find((k) => k.role_key === 'head_of_purchasing');
    expect(purchasing.found_email).toBe('purchasing@samplecity.org'); // on the fetched page: kept
    const manager = t1.find((k) => k.role_key === 'top_appointed_executive');
    expect(manager.status).toBe('confirmed_in_role');
    expect(manager.found_email).toBeNull(); // never on a fetched page: stripped by applyRules
    // The two unsettled deputy seats climb to tier 2 together (the facilities seat is Sam Roe too, confirmed).
    await submitWave(db, client, runId);
    expect(client.sent.filter((s) => /-n2-/.test(s.custom_id))).toHaveLength(1);
  });

  it('a seat left out of the answer is retried, not recorded as found or not found', async () => {
    const db = fixtureDb();
    const client = fakeClient(groupScript(['S2']));
    const { runId } = createRun(db, {}, { group: true, batch: true });
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
    expect(svChecks(db, 1)).toHaveLength(4);
    const retry = db.prepare(`SELECT state, attempts FROM run_items WHERE run_id = ? AND state = 'planned' AND tier = 1`).all(runId) as any[];
    expect(retry).toEqual([{ state: 'planned', attempts: 1 }]);
  });
});
