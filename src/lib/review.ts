import type { Db } from './db';
import { cfg } from './config';
import { changesContact } from './runs';
import { getSeatContext } from './seats';
import type { Confidence, FinalCheck } from './types';

/** Split "Jane Q. Doe Jr." into first/last. Good enough for display; the full string is kept in first_name when unsure. */
export function splitName(full: string): { first: string; last: string } {
  let name = full.replace(/\s+/g, ' ').trim();
  // Drop trailing generational suffixes and credentials ("Jr.", "II", ", JD", ", CPPO, CPPB", "MBA").
  const tail = /,?\s+(jr|sr|ii|iii|iv|j\.?d|ph\.?d|m\.?b\.?a|m\.?p\.?a|c\.?p\.?a|esq|cppo|cppb|cpsm|cpm|nigp-cpp|cpcm|pmp)\.?$/i;
  while (tail.test(name)) name = name.replace(tail, '');
  const parts = name.replace(/,$/, '').split(' ');
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

interface CheckRow {
  id: number;
  seat_id: number;
  review_state: string;
  status: FinalCheck['status'];
  found_name: string | null;
  found_title: string | null;
  found_email: string | null;
  found_email_generic: number;
  found_phone: string | null;
  confidence: Confidence | null;
}

export interface PendingRow extends CheckRow {
  agency: string;
  state: string;
  role: string;
  slot: number;
  listed_name: string | null;
  listed_title: string | null;
  listed_email: string | null;
  listed_phone: string | null;
  source_url: string | null;
  evidence_date: string | null;
  notes: string | null;
  checked_at: string;
  tier: number | null;
  model: string | null;
}

export function listPending(db: Db, opts: { status?: string; limit?: number } = {}): PendingRow[] {
  const args: unknown[] = [];
  let where = `k.review_state = 'pending'`;
  if (opts.status) {
    where += ' AND k.status = ?';
    args.push(opts.status);
  }
  return db
    .prepare(
      `SELECT k.*, a.name AS agency, a.state, r.label AS role, s.slot,
              TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS listed_name,
              c.title AS listed_title, c.email AS listed_email, c.phone AS listed_phone
       FROM checks k JOIN seats s ON s.id = k.seat_id JOIN agencies a ON a.id = s.agency_id JOIN roles r ON r.key = s.role_key
       LEFT JOIN contacts c ON c.id = s.current_contact_id
       WHERE ${where}
       ORDER BY CASE k.status WHEN 'replaced' THEN 0 WHEN 'role_mismatch' THEN 1 WHEN 'vacant_interim' THEN 2 WHEN 'unclear' THEN 3 ELSE 4 END,
                COALESCE(a.population,0) DESC, k.id
       LIMIT ${opts.limit ?? 500}`,
    )
    .all(...args) as PendingRow[];
}

function newContactVersion(db: Db, seatId: number, k: CheckRow, keepIdentity: boolean): number {
  const seat = getSeatContext(db, seatId)!;
  const old = seat.contactId ? (db.prepare('SELECT * FROM contacts WHERE id = ?').get(seat.contactId) as Record<string, unknown>) : null;
  const name = k.found_name ? splitName(k.found_name) : { first: String(old?.first_name ?? ''), last: String(old?.last_name ?? '') };
  const info = db
    .prepare(
      `INSERT INTO contacts (agency_id, first_name, last_name, title, email, email_is_generic, phone, street_address, suite, city, state, zip,
         power_almanac_person_id, source_last_verified, source)
       VALUES (@agency,@first,@last,@title,@email,@generic,@phone,@street,@suite,@city,@state,@zip,@pid,NULL,'web_check')`,
    )
    .run({
      agency: seat.agencyId,
      first: name.first,
      last: name.last,
      title: k.found_title ?? (keepIdentity ? (old?.title as string | null) : null),
      email: k.found_email ?? (keepIdentity ? (old?.email as string | null) : null),
      generic: k.found_email ? k.found_email_generic : keepIdentity ? Number(old?.email_is_generic ?? 0) : 0,
      phone: k.found_phone ?? (keepIdentity ? (old?.phone as string | null) : null),
      street: keepIdentity ? (old?.street_address as string | null) : null,
      suite: keepIdentity ? (old?.suite as string | null) : null,
      city: keepIdentity ? (old?.city as string | null) : null,
      state: keepIdentity ? (old?.state as string | null) : null,
      zip: keepIdentity ? (old?.zip as string | null) : null,
      pid: keepIdentity ? (old?.power_almanac_person_id as string | null) : null,
    });
  const id = Number(info.lastInsertRowid);
  if (seat.contactId) db.prepare(`UPDATE contacts SET status = 'superseded', superseded_by = ?, updated_at = datetime('now') WHERE id = ?`).run(id, seat.contactId);
  db.prepare(`UPDATE seats SET current_contact_id = ?, last_checked_at = datetime('now') WHERE id = ?`).run(id, seatId);
  return id;
}

/** A human accepts a finding. History is kept: the old contact is superseded, never overwritten. */
export function acceptCheck(db: Db, checkId: number): void {
  db.transaction(() => {
    const k = db.prepare('SELECT * FROM checks WHERE id = ?').get(checkId) as CheckRow | undefined;
    if (!k) throw new Error(`No check ${checkId}`);
    if (k.review_state !== 'pending') throw new Error(`Check ${checkId} is not pending`);
    applyCheck(db, checkId, 'replace');
    db.prepare(`UPDATE checks SET review_state = 'accepted' WHERE id = ?`).run(checkId);
  })();
}

const sameName = (a: string | null | undefined, b: string | null | undefined) => {
  const n = (x: string | null | undefined) => {
    const { first, last } = splitName(x ?? '');
    return `${first.split(' ')[0] ?? ''} ${last}`.toLowerCase().replace(/[^a-z ]/g, '').trim();
  };
  return !!a && !!b && n(a) !== '' && n(a) === n(b);
};

/** Other slots of the same role at the same agency, with their holder's name. */
function siblingHolders(db: Db, seatId: number): { seat_id: number; contact_id: number; name: string }[] {
  return db
    .prepare(
      `SELECT s2.id seat_id, c.id contact_id, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) name
       FROM seats s JOIN seats s2 ON s2.agency_id = s.agency_id AND s2.role_key = s.role_key AND s2.id != s.id
       JOIN contacts c ON c.id = s2.current_contact_id WHERE s.id = ?`,
    )
    .all(seatId) as { seat_id: number; contact_id: number; name: string }[];
}

/**
 * Write a check's finding into the contact records. History is kept: a replaced contact is marked superseded, never deleted.
 * mode 'replace': the finding takes the seat. mode 'add': the found person joins the role in a new slot and the
 * current holder stays (used for conflicting or weak findings, so both people are kept).
 * A person who already holds another slot of the same role is never added twice.
 */
export function applyCheck(db: Db, checkId: number, mode: 'replace' | 'add'): void {
  const k = db.prepare('SELECT * FROM checks WHERE id = ?').get(checkId) as CheckRow;
  const seat = getSeatContext(db, k.seat_id)!;
  const asFinal = { status: k.status, found_name: k.found_name, found_title: k.found_title, found_email: k.found_email, found_phone: k.found_phone } as FinalCheck;
  const siblings = siblingHolders(db, k.seat_id);
  const dup = k.found_name ? siblings.find((x) => sameName(x.name, k.found_name)) : undefined;

  if (k.status === 'confirmed_in_role') {
    if (changesContact(seat, asFinal)) newContactVersion(db, k.seat_id, k, true);
    else db.prepare(`UPDATE seats SET last_checked_at = datetime('now') WHERE id = ?`).run(k.seat_id);
  } else if (k.found_name && ['replaced', 'role_mismatch', 'vacant_interim', 'unclear'].includes(k.status)) {
    if (sameName(seat.contactName, k.found_name)) {
      newContactVersion(db, k.seat_id, k, true); // same person, new details
    } else if (dup) {
      // The found person already holds a sibling slot. This slot's holder is out; do not create a duplicate.
      if (seat.slot > 1) {
        if (seat.contactId) db.prepare(`UPDATE contacts SET status = 'superseded', superseded_by = ?, updated_at = datetime('now') WHERE id = ?`).run(dup.contact_id, seat.contactId);
        db.prepare(`UPDATE seats SET current_contact_id = NULL, last_checked_at = datetime('now') WHERE id = ?`).run(k.seat_id);
      } else {
        db.prepare(`UPDATE seats SET last_checked_at = datetime('now') WHERE id = ?`).run(k.seat_id);
      }
    } else if (mode === 'add' && seat.contactId) {
      addHolder(db, k.seat_id, k);
    } else {
      newContactVersion(db, k.seat_id, k, false);
    }
  } else if (k.status === 'vacant_interim') {
    if (seat.contactId) db.prepare(`UPDATE contacts SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(seat.contactId);
    db.prepare(`UPDATE seats SET current_contact_id = NULL, last_checked_at = datetime('now') WHERE id = ?`).run(k.seat_id);
  }
  // role_mismatch or unclear without a name: nothing to write; the seat stays flagged by its latest check.
}

/** Put the found person in a new slot of the same role, leaving the current holder in place. */
function addHolder(db: Db, seatId: number, k: CheckRow): number {
  const seat = db.prepare('SELECT agency_id, role_key FROM seats WHERE id = ?').get(seatId) as { agency_id: number; role_key: string };
  const { first, last } = splitName(k.found_name!);
  const cid = Number(
    db
      .prepare(`INSERT INTO contacts (agency_id, first_name, last_name, title, email, email_is_generic, phone, source) VALUES (?,?,?,?,?,?,?, 'web_check')`)
      .run(seat.agency_id, first, last, k.found_title, k.found_email, k.found_email ? k.found_email_generic : 0, k.found_phone).lastInsertRowid,
  );
  const slot = (db.prepare(`SELECT MAX(slot) m FROM seats WHERE agency_id = ? AND role_key = ?`).get(seat.agency_id, seat.role_key) as { m: number }).m + 1;
  db.prepare(`INSERT INTO seats (agency_id, role_key, current_contact_id, slot, last_checked_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(seat.agency_id, seat.role_key, cid, slot);
  db.prepare(`UPDATE seats SET last_checked_at = datetime('now') WHERE id = ?`).run(seatId);
  return cid;
}

export function rejectCheck(db: Db, checkId: number): void {
  const info = db.prepare(`UPDATE checks SET review_state = 'rejected' WHERE id = ? AND review_state = 'pending'`).run(checkId);
  if (info.changes === 0) throw new Error(`Check ${checkId} is not pending`);
}

/** Bulk-accept pending confirmations at or above a confidence. Never touches replacements. */
export function acceptConfirmations(db: Db, atOrAbove: Confidence = 'Medium'): number {
  const levels: Confidence[] = atOrAbove === 'High' ? ['High'] : atOrAbove === 'Medium' ? ['High', 'Medium'] : ['High', 'Medium', 'Low'];
  const ids = db
    .prepare(`SELECT id FROM checks WHERE review_state = 'pending' AND status = 'confirmed_in_role' AND confidence IN (${levels.map(() => '?').join(',')})`)
    .all(...levels) as { id: number }[];
  for (const { id } of ids) acceptCheck(db, id);
  return ids.length;
}

export { cfg };
