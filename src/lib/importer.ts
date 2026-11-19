import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { Db } from './db';
import { isGenericMailbox } from './rules';

export interface ImportReport {
  file: string;
  rows: number;
  agenciesNew: number;
  contactsNew: number;
  seatsNew: number;
  rolesCreated: string[];
  conflicts: number;
  skipped: number;
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "28-Mar-24" -> "2024-03-28". Two-digit years are 20xx. */
export function parsePaDate(s: string | null | undefined): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec((s ?? '').trim());
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${mo}-${m[1].padStart(2, '0')}`;
}

export function parsePopulation(s: string | null | undefined): number | null {
  const t = (s ?? '').replace(/[,\s]/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** The exports mangle "Power Almanac Account ID" into scientific notation. The Person ID prefix is the real account id. */
export function accountIdFromPersonId(personId: string): string | null {
  const m = /^(\d+)-/.exec(personId.replace(/\s+/g, ''));
  return m ? m[1] : null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function t(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

/** Import a Power Almanac export (any role file). Idempotent: re-importing the same file changes nothing. */
export function importPowerAlmanac(db: Db, file: string): ImportReport {
  const text = fs.readFileSync(file, 'utf8');
  const rows = parse(text, {
    columns: (h: string[]) => h.map((x) => x.trim()),
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const report: ImportReport = { file, rows: rows.length, agenciesNew: 0, contactsNew: 0, seatsNew: 0, rolesCreated: [], conflicts: 0, skipped: 0 };

  const roleByPa = new Map<string, { key: string; multi: boolean }>();
  for (const r of db.prepare('SELECT key, power_almanac_role, multi FROM roles WHERE power_almanac_role IS NOT NULL').all() as { key: string; power_almanac_role: string; multi: number }[]) {
    roleByPa.set(r.power_almanac_role, { key: r.key, multi: !!r.multi });
  }

  const findAgency = db.prepare('SELECT id FROM agencies WHERE power_almanac_account_id = ?');
  const insAgency = db.prepare(
    `INSERT INTO agencies (name, category, state, county, population, website, main_phone, street_address, city, zip, fiscal_year_end, power_almanac_account_id, source)
     VALUES (@name,@category,@state,@county,@pop,@website,@phone,@street,@city,@zip,@fy,@acct,'power_almanac')`,
  );
  const findContact = db.prepare('SELECT id FROM contacts WHERE agency_id = ? AND power_almanac_person_id = ?');
  const findContactNoId = db.prepare('SELECT id FROM contacts WHERE agency_id = ? AND power_almanac_person_id IS NULL AND LOWER(COALESCE(email,\'\')) = ? AND first_name IS ? AND last_name IS ?');
  const insContact = db.prepare(
    `INSERT INTO contacts (agency_id, first_name, last_name, title, email, email_is_generic, phone, phone_ext, street_address, suite, city, state, zip, power_almanac_person_id, source_last_verified, source)
     VALUES (@agency,@first,@last,@title,@email,@generic,@phone,@ext,@street,@suite,@city,@state,@zip,@pid,@verified,'power_almanac')`,
  );
  const insRole = db.prepare(`INSERT INTO roles (key, label, power_almanac_role, definition, title_hints) VALUES (?,?,?,?,'[]')`);
  const seatsFor = db.prepare('SELECT id, slot, current_contact_id FROM seats WHERE agency_id = ? AND role_key = ? ORDER BY slot');
  const insSeat = db.prepare('INSERT INTO seats (agency_id, role_key, slot, current_contact_id) VALUES (?,?,?,?)');
  const setSeatHolder = db.prepare('UPDATE seats SET current_contact_id = ? WHERE id = ?');

  db.transaction(() => {
    for (const row of rows) {
      const personId = t(row['Person ID'])?.replace(/\s+/g, '') ?? null; // one real row has a stray space: "2052030001 00000 -50132AE"
      const acct = personId ? accountIdFromPersonId(personId) : null;
      const name = t(row['Government Designated Name']);
      const state = t(row['Government State']) ?? t(row['State']);
      if (!acct || !name || !state) {
        report.skipped++;
        continue;
      }
      let agencyId = (findAgency.get(acct) as { id: number } | undefined)?.id;
      if (!agencyId) {
        const cat = (t(row['Government Category']) ?? 'other').toLowerCase();
        agencyId = Number(
          insAgency.run({
            name,
            category: ['county', 'municipality', 'township'].includes(cat) ? cat : 'other',
            state: state.toUpperCase(),
            county: t(row['Government County Location']),
            pop: parsePopulation(row['Population']),
            website: t(row['Government Web Address']),
            phone: t(row['Government Main Phone Number']),
            street: t(row['Government Street Address']),
            city: t(row['Government City']),
            zip: t(row['Government Zip Code']),
            fy: t(row['Fiscal Year End']),
            acct,
          }).lastInsertRowid,
        );
        report.agenciesNew++;
      }

      const email = t(row['Email Address']);
      let contactId = (findContact.get(agencyId, personId) as { id: number } | undefined)?.id;
      if (!contactId) {
        contactId = Number(
          insContact.run({
            agency: agencyId,
            first: t(row['First Name']),
            last: t(row['Last Name']),
            title: t(row['Title']),
            email,
            generic: isGenericMailbox(email) ? 1 : 0,
            phone: t(row['Phone Number']),
            ext: t(row['Phone Number Ext']),
            street: t(row['Street Address or PO Box Number']),
            suite: t(row['Suite Number']),
            city: t(row['City']),
            state: t(row['State']),
            zip: t(row['Zip Code']),
            pid: personId,
            verified: parsePaDate(row['Last Verified Date']),
          }).lastInsertRowid,
        );
        report.contactsNew++;
      }
      void findContactNoId;

      const roleValues = (t(row['Role']) ?? '').split(',').map((r) => r.trim()).filter(Boolean);
      for (const rv of roleValues) {
        let role = roleByPa.get(rv);
        if (!role) {
          const key = slug(rv) || 'unknown_role';
          insRole.run(key, rv, rv, `Imported from Power Almanac as "${rv}". Refine this definition so the verifier knows what counts as this seat.`);
          role = { key, multi: false };
          roleByPa.set(rv, role);
          report.rolesCreated.push(rv);
        }
        const seats = seatsFor.all(agencyId, role.key) as { id: number; slot: number; current_contact_id: number | null }[];
        if (role.multi) {
          if (seats.some((s) => s.current_contact_id === contactId)) continue;
          const open = seats.find((s) => s.current_contact_id == null);
          if (open) setSeatHolder.run(contactId, open.id);
          else {
            insSeat.run(agencyId, role.key, (seats.at(-1)?.slot ?? 0) + 1, contactId);
            report.seatsNew++;
          }
        } else if (!seats.length) {
          insSeat.run(agencyId, role.key, 1, contactId);
          report.seatsNew++;
        } else if (seats[0].current_contact_id == null) {
          setSeatHolder.run(contactId, seats[0].id);
        } else if (seats[0].current_contact_id !== contactId) {
          report.conflicts++; // another person is already listed for this single-holder role; keep the first
        }
      }
    }
  })();
  return report;
}
