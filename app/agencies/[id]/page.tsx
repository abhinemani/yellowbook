import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { agencyDetail, listRoles } from '@/lib/queries';
import { addSeatAction, checkAgencyNow, checkSeatNow } from '../../actions';
import { Notice, StatusChip, day, pop, safeLink, usd } from '../../ui';

export const dynamic = 'force-dynamic';
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function AgencyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const d = agencyDetail(db, Number(id));
  if (!d) notFound();
  const a = d.agency;
  const roles = listRoles(db).filter((r) => r.active);
  const web = safeLink(a.website);
  return (
    <>
      <section className="hero">
        <h1>{String(a.name)}</h1>
        <p style={{ margin: 0 }}>
          {String(a.category)} · {String(a.state)}{a.county ? ` · ${String(a.county)} County` : ''}{a.population ? ` · population ${pop(a.population)}` : ''}
          {web && <> · <a href={web} target="_blank" rel="noreferrer">{String(a.website)}</a></>}
        </p>
        <div className="row" style={{ alignItems: 'center', marginTop: 'var(--space-3)' }}>
          <form action={checkAgencyNow.bind(null, Number(id))}>
            <button className="btn" type="submit">Check every seat now</button>
          </form>
          <span className="small">Runs immediately at full price. For many agencies, use a batch run on the Runs page (half price).</span>
        </div>
      </section>
      {one(sp.error) && <Notice>{one(sp.error)}</Notice>}
      {one(sp.checked) && <Notice ok>Check finished. Anything that needs a decision is in the review queue.</Notice>}

      <h2>Seats</h2>
      <div className="panel flush">
        <table>
          <thead><tr><th>Role</th><th>Contact on file</th><th>Latest check</th><th>Found</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {d.seats.map((s) => {
              const link = safeLink(s.source_url);
              return (
                <tr key={String(s.seat_id)}>
                  <td><strong>{String(s.role)}</strong>{Number(s.slot) > 1 ? ` #${s.slot}` : ''}</td>
                  <td>{s.listed_name ? <>{String(s.listed_name)}<div className="small muted">{String(s.listed_title ?? '')}</div><div className="small muted">{String(s.listed_email ?? '')}</div></> : <span className="muted">Empty seat</span>}</td>
                  <td><StatusChip status={s.check_status as string | null} />{s.confidence ? <div className="small muted">{String(s.confidence)} · {day(s.checked_at)}</div> : null}{s.review_state === 'pending' ? <div className="small">Awaiting review</div> : null}</td>
                  <td>{s.found_name ? <>{String(s.found_name)}<div className="small muted">{String(s.found_title ?? '')}</div><div className="small muted">{String(s.found_email ?? '')}</div></> : null}</td>
                  <td>{link ? <a href={link} target="_blank" rel="noreferrer">source</a> : null}</td>
                  <td><form action={checkSeatNow.bind(null, Number(s.seat_id), Number(id))}><button className="small ghost" type="submit">{s.listed_name ? 'Check now' : 'Find holder'}</button></form></td>
                </tr>
              );
            })}
            {d.seats.length === 0 && <tr><td colSpan={6} className="muted">No seats yet. Add one below.</td></tr>}
          </tbody>
        </table>
      </div>
      <form className="panel row" action={addSeatAction.bind(null, Number(id))}>
        <label>Add a seat
          <select name="role">{roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
        </label>
        <button className="ghost" type="submit">Add seat</button>
        <span className="small muted">Then use Find holder to look up who holds it.</span>
      </form>

      <h2>History</h2>
      <p className="small">Every check is kept, newest first. Replacing a contact never overwrites the old record.</p>
      <div className="panel flush">
        <table>
          <thead><tr><th>When</th><th>Role</th><th>Result</th><th>Found</th><th>Notes</th><th className="num">Cost</th></tr></thead>
          <tbody>
            {d.history.map((h) => (
              <tr key={String(h.id)}>
                <td>{day(h.checked_at)}</td><td>{String(h.role)}{Number(h.slot) > 1 ? ` #${h.slot}` : ''}</td>
                <td><StatusChip status={String(h.status)} /> <span className="small muted">{String(h.confidence ?? '')}</span><div className="small muted">tier {String(h.tier ?? '')} · {String(h.review_state)}</div></td>
                <td>{String(h.found_name ?? '')}</td><td className="small">{String(h.notes ?? '')}</td><td className="num cost">{usd(h.cost_usd as number | null)}</td>
              </tr>
            ))}
            {d.history.length === 0 && <tr><td colSpan={6} className="muted">Nothing checked yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
