import type { Db } from './db';
import { cfg } from './config';
import type { RunKind, SeatContext } from './types';

export interface Scope {
  kind?: RunKind; // 'verify' = seats with a listed contact, 'discover' = seats with none
  roles?: string[];
  states?: string[];
  category?: string;
  minPop?: number;
  maxPop?: number;
  agencyIds?: number[];
  seatIds?: number[];
  /** Largest first, then cut here. */
  limit?: number;
  /** Include seats that were accepted recently (default: only seats that are due). */
  includeFresh?: boolean;
  /** Ignore the cool-down on seats that ended "searched, found nothing". */
  ignoreCooldown?: boolean;
}

const BASE = `
SELECT s.id AS seatId, s.slot, a.id AS agencyId, a.name AS agencyName, a.category, a.state, a.county, a.population, a.website,
       r.key AS roleKey, r.label AS roleLabel, r.definition AS roleDefinition, r.multi AS roleMulti, r.title_hints AS titleHints,
       c.id AS contactId, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contactName,
       c.title AS contactTitle, c.email AS contactEmail, c.phone AS contactPhone, c.source_last_verified AS sourceLastVerified,
       (SELECT k.source_url FROM checks k WHERE k.seat_id = s.id AND k.review_state IN ('accepted','auto_accepted')
          AND k.source_url IS NOT NULL ORDER BY k.checked_at DESC, k.id DESC LIMIT 1) AS priorSourceUrl
FROM seats s
JOIN agencies a ON a.id = s.agency_id
JOIN roles r ON r.key = s.role_key
LEFT JOIN contacts c ON c.id = s.current_contact_id
`;

interface Row extends Omit<SeatContext, 'roleMulti' | 'titleHints'> {
  roleMulti: number;
  titleHints: string;
}

export function toSeatContext(r: Row): SeatContext {
  return {
    ...r,
    roleMulti: !!r.roleMulti,
    titleHints: JSON.parse(r.titleHints || '[]') as string[],
    contactName: r.contactName ? r.contactName : null,
  };
}

export function getSeatContext(db: Db, seatId: number): SeatContext | null {
  const row = db.prepare(`${BASE} WHERE s.id = ?`).get(seatId) as Row | undefined;
  return row ? toSeatContext(row) : null;
}

/**
 * Seats that are worth checking now. Skips, in order of money saved:
 *  - seats already in an unfinished run item (never pay twice for the same seat)
 *  - seats whose latest check is waiting in the review queue
 *  - seats whose last check ended "searched, found nothing" within the cool-down
 *  - seats accepted within STALE_MONTHS (unless includeFresh)
 */
export function selectSeats(db: Db, scope: Scope = {}): SeatContext[] {
  const c = cfg();
  const where: string[] = ['r.active = 1'];
  const args: Record<string, unknown> = { stale: `-${c.staleMonths} months`, cool: `-${c.cooldownDays} days` };

  where.push(scope.kind === 'discover' ? 's.current_contact_id IS NULL' : 's.current_contact_id IS NOT NULL');
  // An extra holder slot of a single-holder role that has been emptied is not a seat to fill.
  if (scope.kind === 'discover') where.push('(s.slot = 1 OR r.multi = 1)');
  if (scope.roles?.length) where.push(`s.role_key IN (${scope.roles.map((_, i) => `@role${i}`).join(',')})`);
  scope.roles?.forEach((v, i) => (args[`role${i}`] = v));
  if (scope.states?.length) where.push(`a.state IN (${scope.states.map((_, i) => `@st${i}`).join(',')})`);
  scope.states?.forEach((v, i) => (args[`st${i}`] = v.toUpperCase()));
  if (scope.category) { where.push('a.category = @cat'); args.cat = scope.category; }
  if (scope.minPop != null) { where.push('a.population >= @minpop'); args.minpop = scope.minPop; }
  if (scope.maxPop != null) { where.push('a.population <= @maxpop'); args.maxpop = scope.maxPop; }
  if (scope.agencyIds?.length) where.push(`a.id IN (${scope.agencyIds.map((n) => Number(n)).join(',')})`);
  if (scope.seatIds?.length) where.push(`s.id IN (${scope.seatIds.map((n) => Number(n)).join(',')})`);

  where.push(`NOT EXISTS (SELECT 1 FROM run_items i WHERE i.seat_id = s.id AND i.state IN ('planned','submitted'))`);
  where.push(`NOT EXISTS (SELECT 1 FROM checks k WHERE k.id = (SELECT id FROM checks WHERE seat_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1) AND k.review_state = 'pending')`);
  if (!scope.ignoreCooldown) {
    where.push(`NOT EXISTS (SELECT 1 FROM checks k WHERE k.id = (SELECT id FROM checks WHERE seat_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1)
      AND k.status IN ('unable_to_confirm','unclear') AND k.unresolved_reason IN ('no_staff_listed','no_current_source','model_error')
      AND k.checked_at > datetime('now', @cool))`);
  }
  if (!scope.includeFresh) where.push(`(s.last_checked_at IS NULL OR s.last_checked_at < datetime('now', @stale))`);

  const sql = `${BASE} WHERE ${where.join(' AND ')} ORDER BY COALESCE(a.population,0) DESC, s.id ${scope.limit ? `LIMIT ${Math.floor(scope.limit)}` : ''}`;
  return (db.prepare(sql).all(args) as Row[]).map(toSeatContext);
}
