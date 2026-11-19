import { getDb } from '@/lib/db';
import { listRoles } from '@/lib/queries';
import { importAction } from '../actions';
import { IconCircle, Notice } from '../ui';

export const dynamic = 'force-dynamic';
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function Data({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const roles = listRoles(getDb()).filter((r) => r.seats > 0);
  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}><IconCircle name="file" /><h1 style={{ margin: 0 }}>Import and export</h1></div>
      <p className="lede" style={{ marginTop: 'var(--space-3)' }}>Bring in Power Almanac exports (any role file) and take the results back out in the same columns, plus the check columns.</p>
      {one(sp.imported) && <Notice ok>{one(sp.imported)}</Notice>}
      {one(sp.error) && <Notice>{one(sp.error)}</Notice>}
      <h2>Import</h2>
      <form className="panel row" action={importAction} encType="multipart/form-data">
        <label>Power Almanac CSV files<input type="file" name="files" accept=".csv" multiple /></label>
        <button type="submit">Import</button>
        <span className="small muted">Safe to repeat: re-importing a file changes nothing. Contact data stays in your local database and is never committed to git.</span>
      </form>
      <h2>Export</h2>
      <p className="small">One row per seat. The listed columns show what is on file now; the check columns show the latest result, including anything still awaiting review.</p>
      <div className="panel">
        <p style={{ marginTop: 0 }}><a className="btn" href="/export">Everything</a></p>
        <div className="chips">
          {roles.map((r) => <a key={r.key} className="btn ghost small" href={`/export?roles=${r.key}`}>{r.label}</a>)}
        </div>
      </div>
    </>
  );
}
