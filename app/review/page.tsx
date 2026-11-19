import { getDb } from '@/lib/db';
import { listPending } from '@/lib/review';
import { acceptAction, acceptConfirmationsAction, rejectAction } from '../actions';
import { IconCircle, Notice, StatusChip, day, safeLink } from '../ui';

export const dynamic = 'force-dynamic';
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

const HEAD: Record<string, string> = {
  replaced: 'Someone new holds this seat',
  role_mismatch: 'The listed person is not the head of this function',
  vacant_interim: 'The seat looks vacant or interim',
  unclear: 'Candidate found, not confirmed',
  confirmed_in_role: 'Still in the seat',
};

export default async function Review({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const status = one(sp.status);
  const rows = listPending(getDb(), { status: status || undefined });
  const confirmations = rows.filter((r) => r.status === 'confirmed_in_role').length;
  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}><IconCircle name="check" /><h1 style={{ margin: 0 }}>Review queue</h1></div>
      <p className="lede" style={{ marginTop: 'var(--space-3)' }}>
        Nothing changes until you accept it. Accepting a replacement adds the new person and keeps the old record as history.
        Replacements are always shown first, largest agencies first.
      </p>
      {one(sp.accepted) && <Notice ok>Accepted {one(sp.accepted)} confirmations.</Notice>}
      <form className="panel row" method="get">
        <label>Show
          <select name="status" defaultValue={status}>
            <option value="">Everything pending</option><option value="replaced">Replaced</option><option value="role_mismatch">Role mismatch</option>
            <option value="vacant_interim">Vacant/interim</option><option value="unclear">Unclear</option><option value="confirmed_in_role">Confirmations</option>
          </select>
        </label>
        <button className="ghost" type="submit">Filter</button>
        <span className="small muted">{rows.length} waiting</span>
      </form>
      {confirmations > 0 && (
        <form className="panel row" action={acceptConfirmationsAction}>
          <label>Accept all pending confirmations at or above
            <select name="level" defaultValue="Medium"><option>High</option><option>Medium</option><option>Low</option></select>
          </label>
          <button type="submit">Accept {confirmations} confirmations</button>
          <span className="small muted">Never touches replacements. Changed emails or phones still create a new version of the contact.</span>
        </form>
      )}
      {rows.map((r) => {
        const link = safeLink(r.source_url);
        return (
          <article key={r.id} className="review">
            <header>
              <StatusChip status={r.status} />
              <strong>{r.agency}, {r.state}</strong>
              <span>{r.role}{r.slot > 1 ? ` #${r.slot}` : ''}</span>
              <span className="small muted">{r.confidence ?? ''}{r.evidence_date ? ` · source dated ${r.evidence_date}` : ' · source undated'} · checked {day(r.checked_at)} · tier {r.tier}</span>
            </header>
            <p className="small" style={{ margin: '0 0 var(--space-3)' }}>{HEAD[r.status] ?? ''}</p>
            <div className="cols">
              <div>
                <h3>Listed</h3>
                <dl className="kv"><dt>Name</dt><dd>{r.listed_name || '—'}</dd><dt>Title</dt><dd>{r.listed_title || '—'}</dd><dt>Email</dt><dd>{r.listed_email || '—'}</dd><dt>Phone</dt><dd>{r.listed_phone || '—'}</dd></dl>
              </div>
              <div>
                <h3>Found</h3>
                <dl className="kv"><dt>Name</dt><dd>{r.found_name || '—'}</dd><dt>Title</dt><dd>{r.found_title || '—'}</dd><dt>Email</dt><dd>{r.found_email || '—'}{r.found_email_generic ? ' (office mailbox)' : ''}</dd><dt>Phone</dt><dd>{r.found_phone || '—'}</dd></dl>
              </div>
            </div>
            <p className="small" style={{ margin: 'var(--space-3) 0 0' }}>{r.notes} {link && <a href={link} target="_blank" rel="noreferrer">Open source</a>}</p>
            <div className="actions">
              <form action={acceptAction.bind(null, r.id)}><button type="submit">Accept</button></form>
              <form action={rejectAction.bind(null, r.id)}><button className="danger" type="submit">Reject</button></form>
            </div>
          </article>
        );
      })}
      {rows.length === 0 && <div className="panel">Nothing waiting. New findings from runs show up here.</div>}
    </>
  );
}
