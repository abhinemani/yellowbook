import { getDb } from '@/lib/db';
import { listRoles } from '@/lib/queries';
import { addRoleAction } from '../actions';
import { IconCircle, Notice } from '../ui';

export const dynamic = 'force-dynamic';
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Roles({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const roles = listRoles(getDb());
  const err = ([] as (string | undefined)[]).concat(sp.error)[0];
  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}><IconCircle name="tag" /><h1 style={{ margin: 0 }}>Roles</h1></div>
      <p className="lede" style={{ marginTop: 'var(--space-3)' }}>A role is a kind of position. The definition is what the checker reads to decide who counts, so be precise about the head of the whole function versus a departmental person. Add any position you track.</p>
      {err && <Notice>{err}</Notice>}
      <div className="panel flush">
        <table>
          <thead><tr><th>Role</th><th>What counts</th><th>Typical titles</th><th className="num">Seats</th></tr></thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.key}>
                <td><strong>{r.label}</strong>{r.multi ? <div className="small muted">several per agency</div> : null}</td>
                <td className="small">{r.definition}</td>
                <td className="small">{(JSON.parse(r.title_hints) as string[]).join(', ')}</td>
                <td className="num">{r.seats.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Add a role</h2>
      <form className="panel" action={addRoleAction}>
        <div className="row">
          <label>Name<input name="label" required placeholder="Head of Emergency Management" /></label>
          <label>Typical titles (comma separated)<input name="hints" size={40} placeholder="Emergency Manager, Director of Emergency Services" /></label>
        </div>
        <label style={{ marginTop: 'var(--space-3)' }}>What counts as this seat<textarea name="definition" rows={3} required placeholder="Leads emergency management for the whole government. Not a deputy or coordinator." /></label>
        <p className="small"><label style={{ display: 'inline-flex', flexDirection: 'row', gap: 8, textTransform: 'none', fontWeight: 400, alignItems: 'center' }}><input type="checkbox" name="multi" /> Several holders per agency (like deputies)</label></p>
        <button type="submit">Add role</button>
      </form>
    </>
  );
}
