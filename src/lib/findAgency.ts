import type Anthropic from '@anthropic-ai/sdk';
import { cfg } from './config';
import type { Db } from './db';
import { costUsd } from './pricing';
import { loadPrompt, render } from './prompts';
import { BLOCKED_DOMAINS, callMessages, extractEvidence, parseModelJson } from './verifier';

export interface AgencyCandidate {
  name: string;
  category: 'county' | 'municipality' | 'township' | 'other';
  state: string;
  county: string | null;
  population: number | null;
  website: string | null;
  main_phone: string | null;
  street_address: string | null;
  city: string | null;
  zip: string | null;
  source_url: string | null;
  confidence: 'High' | 'Medium' | 'Low';
}
export interface FindAgencyResult {
  matches: AgencyCandidate[];
  needsClarification: string | null;
  costUsd: number;
}

/** Cheap local search first. Only go to the web when the database has nothing. */
export function searchAgenciesLocal(db: Db, q: string, state?: string, limit = 25) {
  const like = `%${q.trim().replace(/[%_]/g, '')}%`;
  return db
    .prepare(
      `SELECT id, name, category, state, population, website FROM agencies
       WHERE name LIKE ? COLLATE NOCASE ${state ? 'AND state = ?' : ''} ORDER BY COALESCE(population,0) DESC LIMIT ${limit}`,
    )
    .all(...(state ? [like, state.toUpperCase()] : [like])) as { id: number; name: string; category: string; state: string; population: number | null; website: string | null }[];
}

const CATEGORIES = ['county', 'municipality', 'township', 'other'];

function asCandidate(x: Record<string, unknown>): AgencyCandidate | null {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const name = s(x.name);
  const state = s(x.state)?.toUpperCase();
  if (!name || !state || state.length !== 2) return null;
  const cat = String(x.category ?? 'other').toLowerCase();
  const pop = typeof x.population === 'number' ? Math.round(x.population) : null;
  const conf = ['High', 'Medium', 'Low'].includes(String(x.confidence)) ? (x.confidence as AgencyCandidate['confidence']) : 'Low';
  return {
    name, state, category: (CATEGORIES.includes(cat) ? cat : 'other') as AgencyCandidate['category'], county: s(x.county), population: pop,
    website: s(x.website), main_phone: s(x.main_phone), street_address: s(x.street_address), city: s(x.city), zip: s(x.zip), source_url: s(x.source_url), confidence: conf,
  };
}

/** Look an agency up on the web (one small search-enabled call). Returns candidates for the user to confirm; inserts nothing. */
export async function findAgencyOnWeb(client: Anthropic, query: string, hint?: string, c = cfg()): Promise<FindAgencyResult> {
  const prompt = render(loadPrompt('find_agency'), {
    today: new Date().toISOString().slice(0, 10),
    query,
    hint_clause: hint ? `(hint: ${hint})` : '',
  });
  const message = await callMessages(client, {
    model: c.modelT2,
    max_tokens: 2000,
    system: loadPrompt('system').replace('for a contact database', 'for a government directory'),
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3, blocked_domains: BLOCKED_DOMAINS, allowed_callers: ['direct'] },
      { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2, max_content_tokens: c.maxContentTokens, blocked_domains: BLOCKED_DOMAINS, allowed_callers: ['direct'] },
    ],
    messages: [{ role: 'user', content: prompt }],
  });
  const ev = extractEvidence(message.content as unknown[], message.usage as never);
  const cost = costUsd({ model: c.modelT2, usage: message.usage, searches: ev.searches, batch: false });
  const parsed = parseModelJson(message.content as unknown[]) as { matches?: Record<string, unknown>[]; needs_clarification?: string | null };
  const matches = (parsed.matches ?? []).map(asCandidate).filter((m): m is AgencyCandidate => !!m).slice(0, 5);
  return { matches, needsClarification: parsed.needs_clarification ?? null, costUsd: cost };
}

/** Insert a confirmed agency (source web_lookup or manual) and create empty seats for the chosen roles. */
export function addAgency(db: Db, a: Omit<AgencyCandidate, 'confidence'>, source: 'web_lookup' | 'manual', roleKeys: string[]): number {
  const existing = db.prepare(`SELECT id FROM agencies WHERE name = ? COLLATE NOCASE AND state = ?`).get(a.name, a.state) as { id: number } | undefined;
  return db.transaction(() => {
    const id =
      existing?.id ??
      Number(
        db
          .prepare(
            `INSERT INTO agencies (name, category, state, county, population, website, main_phone, street_address, city, zip, source, source_url)
             VALUES (@name,@category,@state,@county,@population,@website,@main_phone,@street_address,@city,@zip,@source,@source_url)`,
          )
          .run({ ...a, source }).lastInsertRowid,
      );
    const ins = db.prepare(`INSERT OR IGNORE INTO seats (agency_id, role_key, slot) VALUES (?,?,1)`);
    for (const r of roleKeys) ins.run(id, r);
    return id;
  })();
}

export function addSeat(db: Db, agencyId: number, roleKey: string): void {
  const role = db.prepare('SELECT multi FROM roles WHERE key = ?').get(roleKey) as { multi: number } | undefined;
  if (!role) throw new Error(`Unknown role ${roleKey}`);
  const max = (db.prepare('SELECT MAX(slot) m FROM seats WHERE agency_id = ? AND role_key = ?').get(agencyId, roleKey) as { m: number | null }).m;
  if (max != null && !role.multi) return; // one seat per single-holder role
  db.prepare('INSERT INTO seats (agency_id, role_key, slot) VALUES (?,?,?)').run(agencyId, roleKey, (max ?? 0) + 1);
}
