import Link from 'next/link';
import { getDb } from '@/lib/db';
import { listAgencies } from '@/lib/queries';
import { IconCircle, pop } from '../ui';

export const dynamic = 'force-dynamic';

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function Agencies({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const { rows, total, per } = listAgencies(getDb(), { q: one(sp.q), state: one(sp.state), category: one(sp.category), page });
  const qs = (p: number) => new URLSearchParams({ q: one(sp.q), state: one(sp.state), category: one(sp.category), page: String(p) }).toString();
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <IconCircle name="building" />
          <h1 style={{ margin: 0 }}>Agencies</h1>
        </div>
        <Link className="btn" href="/agencies/new">Add an agency</Link>
      </div>
      <p className="lede" style={{ marginTop: 'var(--space-3)' }}>Counties, cities and townships, largest first. Each has seats: one per role you track.</p>
      <form className="panel row" method="get">
        <label>Name<input name="q" defaultValue={one(sp.q)} placeholder="Boone, Springfield..." /></label>
        <label>State<input name="state" defaultValue={one(sp.state)} maxLength={2} size={4} placeholder="MO" /></label>
        <label>Type
          <select name="category" defaultValue={one(sp.category)}>
            <option value="">All</option><option value="county">County</option><option value="municipality">City or town</option><option value="township">Township</option><option value="other">Other</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <div className="panel flush">
        <table>
          <thead><tr><th>Agency</th><th>State</th><th>Type</th><th className="num">Population</th><th className="num">Seats</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td><Link href={`/agencies/${a.id}`}>{a.name}</Link></td><td>{a.state}</td><td>{a.category}</td>
                <td className="num">{pop(a.population)}</td><td className="num">{a.seats}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted">No agency matches. <Link href={`/agencies/new?q=${encodeURIComponent(one(sp.q))}`}>Look it up and add it</Link>.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager small">
        <span>{total.toLocaleString('en-US')} agencies</span>
        {page > 1 && <Link href={`/agencies?${qs(page - 1)}`}>Previous</Link>}
        {page * per < total && <Link href={`/agencies?${qs(page + 1)}`}>Next</Link>}
      </div>
    </>
  );
}
