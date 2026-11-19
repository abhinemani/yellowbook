import { getDb } from '@/lib/db';
import { cfg } from '@/lib/config';
import { listRoles } from '@/lib/queries';
import { planRun } from '@/lib/runs';
import type { RunKind, Tier } from '@/lib/types';
import { scopeFromForm, startRun } from '../../actions';
import { IconCircle, Notice, usd } from '../../ui';

export const dynamic = 'force-dynamic';
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function NewRun({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = getDb();
  const c = cfg();
  const roles = listRoles(db).filter((r) => r.active && r.seats > 0);
  const chosen = ([] as string[]).concat(sp.roles ?? []);
  const go = one(sp.go) === '1';

  // Build the scope from the query string the same way the start action reads the form.
  const fd = new FormData();
  for (const [k, v] of Object.entries(sp)) for (const x of ([] as (string | undefined)[]).concat(v)) if (x != null) fd.append(k, x);
  const { maxTier, sync, cap, ...scope } = await scopeFromForm(fd);
  const plan = go ? planRun(db, scope, { kind: scope.kind as RunKind, maxTier: maxTier as Tier | undefined, batch: sync ? false : undefined }, c) : null;
  const e = plan?.estimate;

  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}><IconCircle name="play" /><h1 style={{ margin: 0 }}>New run</h1></div>
      <p className="lede" style={{ marginTop: 'var(--space-3)' }}>
        Pick what to check. You will see the seat count and the cost first, and nothing is sent until you press Start.
        Seats checked recently, waiting in the review queue, or already in a run are skipped automatically.
      </p>
      {one(sp.error) && <Notice>{one(sp.error)}</Notice>}
      <form className="panel" method="get">
        <input type="hidden" name="go" value="1" />
        <p className="small" style={{ marginTop: 0 }}><strong>Roles</strong></p>
        <div className="checks">
          {roles.map((r) => <label key={r.key}><input type="checkbox" name="roles" value={r.key} defaultChecked={chosen.includes(r.key)} /> {r.label} <span className="muted">({r.seats.toLocaleString('en-US')})</span></label>)}
        </div>
        <div className="row" style={{ marginTop: 'var(--space-4)' }}>
          <label>States<input name="states" defaultValue={one(sp.states)} placeholder="MO, KS (blank = all)" /></label>
          <label>Population at least<input name="minPop" defaultValue={one(sp.minPop)} inputMode="numeric" /></label>
          <label>Largest N seats<input name="limit" defaultValue={one(sp.limit)} inputMode="numeric" placeholder="25 for a pilot" /></label>
          <label>Up to tier
            <select name="maxTier" defaultValue={one(sp.maxTier) || String(c.maxTier)}>
              <option value="1">1 · site read only</option><option value="2">2 · plus web search</option><option value="3">3 · plus stronger model</option>
            </select>
          </label>
          <label>Spend cap (USD)<input name="cap" defaultValue={one(sp.cap) || String(c.maxRunCostUsd)} inputMode="decimal" size={6} /></label>
          <label>Kind<select name="kind" defaultValue={one(sp.kind) || 'verify'}><option value="verify">Verify listed contacts</option><option value="discover">Find holders for empty seats</option></select></label>
        </div>
        <p className="small" style={{ marginBottom: 0 }}><label style={{ display: 'inline-flex', flexDirection: 'row', gap: 8, textTransform: 'none', fontWeight: 400, alignItems: 'center' }}><input type="checkbox" name="sync" defaultChecked={sync} /> Run now at full price instead of batch (for small pilots)</label></p>
        <p style={{ marginBottom: 0 }}><button type="submit">Show seats and cost</button></p>
      </form>

      {e && (
        <section className="hero">
          <h2>{e.seats.toLocaleString('en-US')} seats, about {usd(e.expectedTotalUsd)}</h2>
          <p style={{ margin: 0, maxWidth: '70ch' }}>
            {e.startAtTier1} start with a free-to-search read of the agency&apos;s own site; {e.startAtTier2} have no website on file and start with web search.
            About {e.expectedEscalations} are expected to need web search. {e.batch ? 'Batch pricing: half the token cost; web search is full price.' : 'Full price: no batch discount.'}
          </p>
          <div className="stats">
            <div className="stat"><div className="big-number">{usd(e.expectedTotalUsd)}</div><div className="label">Expected</div><div className="note">{usd(e.perSeatExpectedUsd)} per seat</div></div>
            <div className="stat"><div className="big-number">{usd(e.ceilingUsd)}</div><div className="label">If every seat escalates</div><div className="note">the most this plan should cost</div></div>
            <div className="stat"><div className="big-number rose">{usd(cap ?? e.cappedAtUsd)}</div><div className="label">Spend cap</div><div className="note">no new batch is sent past it</div></div>
          </div>
          <p className="small" style={{ marginBottom: 0 }}>
            Estimates use {e.basis.tokens === 'measured' ? 'measured token use from your past runs' : 'default token assumptions (measured numbers replace them after a pilot)'} and a {(e.basis.escalationRate * 100).toFixed(0)}% {e.basis.escalation} escalation rate.
          </p>
          {e.seats > 0 ? (
            <form action={startRun} style={{ marginTop: 'var(--space-4)' }}>
              {Object.entries(sp).flatMap(([k, v]) => ([] as (string | undefined)[]).concat(v).map((x, i) => <input key={`${k}${i}`} type="hidden" name={k} value={x ?? ''} />))}
              <button className="btn" type="submit">Start this run</button>
              <span className="small" style={{ marginLeft: 12 }}>You can cancel it from the run page.</span>
            </form>
          ) : <p>Nothing is due for that scope.</p>}
        </section>
      )}
    </>
  );
}
