import { stringify } from 'csv-stringify/sync';
import type { Db } from './db';
import { emailDomainStatus } from './domains';
import { emailQuality } from './export';

/**
 * Unverified email guesses for people whose seat is settled but who have no usable email.
 * Hard rule 2: a guess is never stored as an email. Guesses exist only in this export, in a column
 * labelled unverified, with the basis for each one. Nothing here writes to the database.
 */

export type Pattern = 'first.last' | 'flast' | 'firstl' | 'first_last' | 'firstlast' | 'f.last' | 'last.first' | 'lastf' | 'first' | 'last';

const clean = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

/** First and last name as an address uses them: letters only, middle names and initials dropped. */
export function nameParts(first: string | null | undefined, last: string | null | undefined): { f: string; l: string } | null {
  const f = clean((first ?? '').trim().split(/\s+/)[0]);
  const lastWords = (last ?? '').trim().split(/\s+/);
  const l = clean(lastWords[lastWords.length - 1]);
  return f.length >= 2 && l.length >= 2 ? { f, l } : null;
}

export function render(p: Pattern, f: string, l: string): string {
  switch (p) {
    case 'first.last': return `${f}.${l}`;
    case 'flast': return `${f[0]}${l}`;
    case 'firstl': return `${f}${l[0]}`;
    case 'first_last': return `${f}_${l}`;
    case 'firstlast': return `${f}${l}`;
    case 'f.last': return `${f[0]}.${l}`;
    case 'last.first': return `${l}.${f}`;
    case 'lastf': return `${l}${f[0]}`;
    case 'first': return f;
    case 'last': return l;
  }
}
const PATTERNS: Pattern[] = ['first.last', 'first_last', 'f.last', 'last.first', 'firstlast', 'flast', 'firstl', 'lastf', 'first', 'last'];

/** Which pattern produced this address's local part from this name, if any. */
export function detectPattern(email: string, first: string | null, last: string | null): Pattern | null {
  const np = nameParts(first, last);
  const local = email.split('@')[0]?.toLowerCase().replace(/[0-9]+$/, '');
  if (!np || !local) return null;
  return PATTERNS.find((p) => render(p, np.f, np.l) === local) ?? null;
}

export interface AgencyFormat { pattern: Pattern; domain: string; seen: number; of: number }

/**
 * An agency's email format, from its people with personal addresses on file: the most common pattern on the
 * most common domain. Needs at least two addresses that agree, and agreement from most of those checked.
 */
export function agencyFormat(examples: { email: string; first: string | null; last: string | null }[]): AgencyFormat | null {
  const byDomain = new Map<string, { p: Pattern | null }[]>();
  for (const e of examples) {
    const domain = e.email.split('@')[1]?.toLowerCase().trim();
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push({ p: detectPattern(e.email, e.first, e.last) });
  }
  let best: AgencyFormat | null = null;
  for (const [domain, list] of byDomain) {
    const counts = new Map<Pattern, number>();
    for (const x of list) if (x.p) counts.set(x.p, (counts.get(x.p) ?? 0) + 1);
    for (const [pattern, seen] of counts) {
      if (seen < 2 || seen / list.length < 0.6) continue;
      if (!best || seen > best.seen) best = { pattern, domain, seen, of: list.length };
    }
  }
  return best;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** The address the model wrote as "Pattern guess (UNVERIFIED): ..." in a check's notes, if any. */
export function noteGuess(notes: string | null | undefined): string | null {
  const m = /Pattern guess \(UNVERIFIED\)\s*:?\s*([^\n]{0,160})/i.exec(notes ?? '');
  const e = m ? EMAIL_RE.exec(m[1]) : null;
  return e ? e[0].toLowerCase().replace(/[.,;)]+$/, '') : null;
}

const SETTLED = new Set(['confirmed_in_role', 'replaced', 'role_mismatch', 'vacant_interim']);

export interface KnownPerson {
  agency: string; state: string; population: number | null; role: string; name: string; title: string | null; phone: string | null;
  status: string; confidence: string; source_url: string | null; evidence_date: string | null; checked_at: string | null;
  guess: string | null; basis: string;
}

/** People whose seat is settled at Medium or High but who have no usable email, each with an unverified guess. */
export function knownPeople(db: Db, opts: { roles?: string[] } = {}): KnownPerson[] {
  const where = opts.roles?.length ? `WHERE s.role_key IN (${opts.roles.map(() => '?').join(',')})` : '';
  const rows = db
    .prepare(
      `SELECT s.agency_id, a.name agency, a.state, a.population, r.label role, c.first_name, c.last_name, c.title, c.phone, c.email,
              k.status k_status, k.confidence, k.found_email, k.notes, k.source_url, k.evidence_date, k.checked_at
       FROM seats s JOIN agencies a ON a.id = s.agency_id JOIN roles r ON r.key = s.role_key
       LEFT JOIN contacts c ON c.id = s.current_contact_id
       LEFT JOIN checks k ON k.id = (SELECT id FROM checks WHERE seat_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1)
       ${where}
       ORDER BY COALESCE(a.population,0) DESC, a.name, r.label, s.slot`,
    )
    .all(...(opts.roles ?? [])) as Record<string, any>[];

  const examples = db.prepare(
    `SELECT email, first_name first, last_name last FROM contacts WHERE agency_id = ? AND status = 'active' AND email IS NOT NULL AND email_is_generic = 0`,
  );
  const formats = new Map<number, AgencyFormat | null>();
  const formatFor = (id: number) => {
    if (!formats.has(id)) formats.set(id, agencyFormat(examples.all(id) as { email: string; first: string | null; last: string | null }[]));
    return formats.get(id)!;
  };

  const out: KnownPerson[] = [];
  for (const r of rows) {
    if (!SETTLED.has(r.k_status) || (r.confidence !== 'High' && r.confidence !== 'Medium')) continue;
    if (!r.first_name || !r.last_name) continue;
    if (emailQuality(r, emailDomainStatus(db, r.email))) continue; // already usable: not this list
    const np = nameParts(r.first_name, r.last_name);
    const fmt = formatFor(r.agency_id);
    let guess: string | null = null;
    let basis = 'No guess: no agency format and no model guess';
    if (np && fmt) {
      guess = `${render(fmt.pattern, np.f, np.l)}@${fmt.domain}`;
      basis = `Agency format ${fmt.pattern}@${fmt.domain}, seen in ${fmt.seen} of ${fmt.of} staff addresses on file`;
    } else {
      const g = noteGuess(r.notes);
      if (g) { guess = g; basis = 'Model inferred from pages it read (no agency format on file)'; }
    }
    const dom = guess ? emailDomainStatus(db, guess) : null;
    if (guess && dom && dom !== 'mx' && dom !== 'a_only') basis += '; domain does not receive mail';
    out.push({
      agency: r.agency, state: r.state, population: r.population, role: r.role,
      name: `${r.first_name} ${r.last_name}`.trim(), title: r.title, phone: r.phone,
      status: r.k_status, confidence: r.confidence, source_url: r.source_url, evidence_date: r.evidence_date, checked_at: r.checked_at,
      guess, basis,
    });
  }
  return out;
}

const STATUS: Record<string, string> = { confirmed_in_role: 'Confirmed in role', replaced: 'Replaced (new person)', role_mismatch: 'Role mismatch (actual holder)', vacant_interim: 'Interim holder' };

export function knownPeopleCsv(db: Db, opts: { roles?: string[] } = {}): string {
  const rows = knownPeople(db, opts).map((p) => ({
    Government: p.agency, State: p.state, Population: p.population, Role: p.role, Name: p.name, Title: p.title, Phone: p.phone,
    'Check Status': STATUS[p.status] ?? p.status, Confidence: p.confidence, 'Source URL': p.source_url, 'Evidence Date': p.evidence_date,
    'Unverified Email Guess': p.guess ?? '', 'Guess Basis': p.basis, 'Checked At': p.checked_at,
  }));
  return stringify(rows, { header: true, columns: ['Government', 'State', 'Population', 'Role', 'Name', 'Title', 'Phone', 'Check Status', 'Confidence', 'Source URL', 'Evidence Date', 'Unverified Email Guess', 'Guess Basis', 'Checked At'] });
}
