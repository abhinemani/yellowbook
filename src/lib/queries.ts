import type { Db } from './db';
import { selectSeats } from './seats';

export function overview(db: Db) {
  const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T;
  const seats = one<{ n: number }>('SELECT COUNT(*) n FROM seats').n;
  const agencies = one<{ n: number }>('SELECT COUNT(*) n FROM agencies').n;
  const latest = `FROM v_seat_status WHERE check_status IS NOT NULL`;
  const checked = one<{ n: number }>(`SELECT COUNT(*) n ${latest}`).n;
  const by = (s: string) => one<{ n: number }>(`SELECT COUNT(*) n ${latest} AND check_status = ?`, s).n;
  const pending = one<{ n: number }>(`SELECT COUNT(*) n FROM checks WHERE review_state = 'pending'`).n;
  const spend = one<{ usd: number | null }>('SELECT SUM(cost_usd) usd FROM checks').usd ?? 0;
  const due = selectSeats(db, { kind: 'verify' }).length;
  return { seats, agencies, checked, confirmed: by('confirmed_in_role'), replaced: by('replaced'), mismatch: by('role_mismatch'), unable: by('unable_to_confirm'), pending, spend, due };
}

export function listAgencies(db: Db, f: { q?: string; state?: string; category?: string; page?: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.q) { where.push('a.name LIKE ? COLLATE NOCASE'); args.push(`%${f.q}%`); }
  if (f.state) { where.push('a.state = ?'); args.push(f.state.toUpperCase()); }
  if (f.category) { where.push('a.category = ?'); args.push(f.category); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const per = 50;
  const total = (db.prepare(`SELECT COUNT(*) n FROM agencies a ${w}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(`SELECT a.id, a.name, a.category, a.state, a.population, (SELECT COUNT(*) FROM seats s WHERE s.agency_id = a.id) seats FROM agencies a ${w} ORDER BY COALESCE(a.population,0) DESC, a.name LIMIT ${per} OFFSET ${((f.page ?? 1) - 1) * per}`)
    .all(...args) as { id: number; name: string; category: string; state: string; population: number | null; seats: number }[];
  return { rows, total, per };
}

export function agencyDetail(db: Db, id: number) {
  const agency = db.prepare('SELECT * FROM agencies WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
  if (!agency) return null;
  const seats = db.prepare(`SELECT * FROM v_seat_status WHERE agency_id = ? ORDER BY role, slot`).all(id) as Record<string, string | number | null>[];
  const history = db
    .prepare(
      `SELECT k.id, k.checked_at, k.status, k.confidence, k.found_name, k.source_url, k.notes, k.review_state, k.tier, k.cost_usd, r.label role, s.slot
       FROM checks k JOIN seats s ON s.id = k.seat_id JOIN roles r ON r.key = s.role_key WHERE s.agency_id = ? ORDER BY k.id DESC LIMIT 40`,
    )
    .all(id) as Record<string, string | number | null>[];
  return { agency, seats, history };
}

export function listRuns(db: Db) {
  return db
    .prepare(
      `SELECT r.id, r.created_at, r.kind, r.status, r.est_cost_usd, r.actual_cost_usd, r.spend_cap_usd,
              (SELECT COUNT(*) FROM run_items i WHERE i.run_id = r.id AND i.tier = 1) AS seats,
              (SELECT COUNT(*) FROM run_items i WHERE i.run_id = r.id AND i.state IN ('planned','submitted')) AS open_items
       FROM runs r ORDER BY r.id DESC LIMIT 50`,
    )
    .all() as { id: number; created_at: string; kind: string; status: string; est_cost_usd: number | null; actual_cost_usd: number; spend_cap_usd: number; seats: number; open_items: number }[];
}

export function listRoles(db: Db) {
  return db
    .prepare(`SELECT r.*, (SELECT COUNT(*) FROM seats s WHERE s.role_key = r.key) seats FROM roles r ORDER BY seats DESC, label`)
    .all() as { key: string; label: string; power_almanac_role: string | null; definition: string; title_hints: string; multi: number; active: number; seats: number }[];
}

export function addRole(db: Db, label: string, definition: string, hints: string[], multi: boolean): string {
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) throw new Error('Give the role a name.');
  db.prepare(`INSERT INTO roles (key, label, power_almanac_role, definition, title_hints, multi) VALUES (?,?,NULL,?,?,?)`).run(key, label.trim(), definition.trim(), JSON.stringify(hints), multi ? 1 : 0);
  return key;
}
