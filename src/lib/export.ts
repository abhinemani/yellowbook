import { stringify } from 'csv-stringify/sync';
import type { Db } from './db';

/** Same columns and order as the Power Almanac exports, then the check columns. One row per seat. */
export const PA_COLUMNS = [
  'Email Address', 'First Name', 'Last Name', 'Title', 'Government Designated Name', 'Person ID', 'Power Almanac Account ID', 'Role',
  'Phone Number', 'Phone Number Ext', 'Street Address or PO Box Number', 'Suite Number', 'City', 'State', 'Zip Code',
  'Government Category', 'Government Place Name', 'Government Category Name', 'Government County Location', 'Government Web Address',
  'Government Main Phone Number', 'Government Street Address', 'Government City', 'Government State', 'Government Zip Code',
  'Population', 'Last Verified Date', 'Fiscal Year End', 'Update Status',
] as const;
export const CHECK_COLUMNS = ['Check Status', 'Current Name', 'Current Title', 'Current Email', 'Current Phone', 'Source URL', 'Confidence', 'Check Notes', 'Review State', 'Checked At'] as const;

const STATUS_LABEL: Record<string, string> = {
  confirmed_in_role: 'Confirmed in role',
  replaced: 'Replaced',
  role_mismatch: 'Role mismatch',
  vacant_interim: 'Vacant/interim',
  unclear: 'Unclear',
  unable_to_confirm: 'Unable to confirm',
};
export const statusLabel = (s: string | null | undefined): string => (s ? STATUS_LABEL[s] ?? s : 'Not checked');

export function exportCsv(db: Db, opts: { roles?: string[]; states?: string[] } = {}): string {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.roles?.length) { where.push(`s.role_key IN (${opts.roles.map(() => '?').join(',')})`); args.push(...opts.roles); }
  if (opts.states?.length) { where.push(`a.state IN (${opts.states.map(() => '?').join(',')})`); args.push(...opts.states); }
  const rows = db
    .prepare(
      `SELECT a.*, r.label AS role_label, COALESCE(r.power_almanac_role, r.label) AS pa_role, s.slot,
              c.first_name, c.last_name, c.title, c.email, c.phone, c.phone_ext, c.street_address AS c_street, c.suite, c.city AS c_city,
              c.state AS c_state, c.zip AS c_zip, c.power_almanac_person_id, c.source_last_verified,
              k.status AS k_status, k.found_name, k.found_title, k.found_email, k.found_phone, k.source_url, k.confidence, k.notes, k.review_state, k.checked_at
       FROM seats s JOIN agencies a ON a.id = s.agency_id JOIN roles r ON r.key = s.role_key
       LEFT JOIN contacts c ON c.id = s.current_contact_id
       LEFT JOIN checks k ON k.id = (SELECT id FROM checks WHERE seat_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1)
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(a.population,0) DESC, a.name, r.label, s.slot`,
    )
    .all(...args) as Record<string, unknown>[];

  const records = rows.map((r) => ({
    'Email Address': r.email, 'First Name': r.first_name, 'Last Name': r.last_name, Title: r.title,
    'Government Designated Name': r.name, 'Person ID': r.power_almanac_person_id, 'Power Almanac Account ID': r.power_almanac_account_id,
    Role: r.pa_role, 'Phone Number': r.phone, 'Phone Number Ext': r.phone_ext, 'Street Address or PO Box Number': r.c_street,
    'Suite Number': r.suite, City: r.c_city, State: r.c_state, 'Zip Code': r.c_zip, 'Government Category': r.category,
    'Government Place Name': '', 'Government Category Name': '', 'Government County Location': r.county, 'Government Web Address': r.website,
    'Government Main Phone Number': r.main_phone, 'Government Street Address': r.street_address, 'Government City': r.city,
    'Government State': r.state, 'Government Zip Code': r.zip, Population: r.population, 'Last Verified Date': r.source_last_verified,
    'Fiscal Year End': r.fiscal_year_end, 'Update Status': '',
    'Check Status': statusLabel(r.k_status as string | null), 'Current Name': r.found_name, 'Current Title': r.found_title,
    'Current Email': r.found_email, 'Current Phone': r.found_phone, 'Source URL': r.source_url, Confidence: r.confidence,
    'Check Notes': r.notes, 'Review State': r.review_state, 'Checked At': r.checked_at,
  }));
  return stringify(records, { header: true, columns: [...PA_COLUMNS, ...CHECK_COLUMNS] });
}
