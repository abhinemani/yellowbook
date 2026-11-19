import Link from 'next/link';
import { getDb } from '@/lib/db';
import { listRuns } from '@/lib/queries';
import { IconCircle, day, usd } from '../ui';

export const dynamic = 'force-dynamic';

export default function Runs() {
  const runs = listRuns(getDb());
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row" style={{ alignItems: 'center' }}><IconCircle name="play" /><h1 style={{ margin: 0 }}>Runs</h1></div>
        <Link className="btn" href="/runs/new">New run</Link>
      </div>
      <p className="lede" style={{ marginTop: 'var(--space-3)' }}>A run checks a set of seats. Batch runs cost half as much and finish within hours; results arrive when you press Check for results, or run <code>npm run yb -- watch &lt;id&gt;</code>.</p>
      <div className="panel flush">
        <table>
          <thead><tr><th>Run</th><th>Started</th><th>Kind</th><th>Status</th><th className="num">Seats</th><th className="num">Open</th><th className="num">Estimated</th><th className="num">Spent</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/runs/${r.id}`}>#{r.id}</Link></td><td>{day(r.created_at)}</td><td>{r.kind}</td><td>{r.status}</td>
                <td className="num">{r.seats.toLocaleString('en-US')}</td><td className="num">{r.open_items}</td><td className="num cost">{usd(r.est_cost_usd)}</td><td className="num cost">{usd(r.actual_cost_usd)}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan={8} className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
