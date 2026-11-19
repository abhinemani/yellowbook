import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getRun, refreshRunStatus, runSummary } from '@/lib/runs';
import { advanceRun, cancelRunAction } from '../../actions';
import { Notice, StatusChip, Stat, day, usd } from '../../ui';

export const dynamic = 'force-dynamic';
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  try { getRun(db, Number(id)); } catch { notFound(); }
  const status = refreshRunStatus(db, Number(id));
  const s = runSummary(db, Number(id));
  const open = s.items.filter((i) => i.state === 'planned' || i.state === 'submitted').reduce((n, i) => n + i.n, 0);
  const planned = s.items.filter((i) => i.state === 'planned').reduce((n, i) => n + i.n, 0);
  const checks = s.checks.reduce((n, c) => n + c.n, 0);
  return (
    <>
      <section className="hero">
        <h1>Run #{s.run.id}: {status}</h1>
        <p style={{ margin: 0 }}>{s.run.kind} · started {day(s.run.created_at)} · cap {usd(s.run.spend_cap_usd)}</p>
        <div className="stats">
          <Stat n={checks} label="Results in" note="counted from the database" />
          <Stat n={open} label="Still open" note={`${planned} waiting to be sent`} />
          <Stat n={usd(s.run.actual_cost_usd)} label="Spent" note={`estimated ${usd(s.run.est_cost_usd)}`} rose />
        </div>
        {status !== 'done' && status !== 'canceled' && (
          <div className="row" style={{ marginTop: 'var(--space-4)' }}>
            <form action={advanceRun.bind(null, s.run.id)}><button className="btn" type="submit">Check for results</button></form>
            <form action={cancelRunAction.bind(null, s.run.id)}><button className="ghost" type="submit">Cancel run</button></form>
          </div>
        )}
      </section>
      {one(sp.error) && <Notice>{one(sp.error)}</Notice>}
      <h2>By result</h2>
      <div className="panel flush">
        <table>
          <thead><tr><th>Result</th><th className="num">Seats</th><th className="num">Searches</th><th className="num">Cost</th></tr></thead>
          <tbody>
            {s.checks.map((c) => <tr key={c.status}><td><StatusChip status={c.status} /></td><td className="num">{c.n}</td><td className="num">{c.searches ?? 0}</td><td className="num cost">{usd(c.usd)}</td></tr>)}
            {s.checks.length === 0 && <tr><td colSpan={4} className="muted">No results yet. Batches usually finish within an hour or two.</td></tr>}
          </tbody>
        </table>
      </div>
      <h2>By tier</h2>
      <p className="small">Tier 1 reads the agency&apos;s own site. Tier 2 adds web search for seats tier 1 could not settle.</p>
      <div className="panel flush">
        <table>
          <thead><tr><th>Tier</th><th className="num">Checks</th><th className="num">Total</th><th className="num">Average</th></tr></thead>
          <tbody>{s.byTier.map((t) => <tr key={t.tier}><td>Tier {t.tier}</td><td className="num">{t.n}</td><td className="num cost">{usd(t.usd)}</td><td className="num cost">{usd(t.avg_usd)}</td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}
