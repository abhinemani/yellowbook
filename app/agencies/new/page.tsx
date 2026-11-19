import Link from 'next/link';
import { getClient } from '@/lib/client';
import { getDb } from '@/lib/db';
import { findAgencyOnWeb, searchAgenciesLocal, type AgencyCandidate } from '@/lib/findAgency';
import { listRoles } from '@/lib/queries';
import { addAgencyAction } from '../../actions';
import { IconCircle, Notice, pop, usd } from '../../ui';

export const dynamic = 'force-dynamic';

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

function RoleBoxes({ roles, defaults }: { roles: { key: string; label: string }[]; defaults: string[] }) {
  return (
    <div className="checks">
      {roles.map((r) => (
        <label key={r.key}><input type="checkbox" name="roles" value={r.key} defaultChecked={defaults.includes(r.key)} /> {r.label}</label>
      ))}
    </div>
  );
}

function CandidateForm({ c, roles, source }: { c: AgencyCandidate; roles: { key: string; label: string }[]; source: 'web_lookup' | 'manual' }) {
  const hidden: [string, string | number | null][] = [
    ['name', c.name], ['state', c.state], ['category', c.category], ['county', c.county], ['population', c.population], ['website', c.website],
    ['main_phone', c.main_phone], ['street_address', c.street_address], ['city', c.city], ['zip', c.zip], ['source_url', c.source_url], ['source', source],
  ];
  return (
    <form action={addAgencyAction} className="panel">
      {hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v ?? ''} />)}
      <h3 style={{ color: 'var(--navy)', fontWeight: 700 }}>{c.name}, {c.state}</h3>
      <p className="small" style={{ margin: '0 0 var(--space-3)' }}>
        {c.category}{c.population ? ` · population ${pop(c.population)}` : ''} · confidence {c.confidence}
        {c.website && <> · <a href={c.website} target="_blank" rel="noreferrer">{c.website}</a></>}
        {c.source_url && <> · <a href={c.source_url} target="_blank" rel="noreferrer">source</a></>}
      </p>
      <p className="small" style={{ margin: '0 0 var(--space-2)' }}><strong>Create seats for:</strong></p>
      <RoleBoxes roles={roles} defaults={['head_of_purchasing', 'head_of_finance', 'top_appointed_executive']} />
      <p style={{ marginBottom: 0 }}><button type="submit">Add this agency</button></p>
    </form>
  );
}

export default async function NewAgency({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = one(sp.q).trim();
  const state = one(sp.state).trim();
  const web = one(sp.web) === '1';
  const db = getDb();
  const roles = listRoles(db).filter((r) => r.active);
  const local = q ? searchAgenciesLocal(db, q, state || undefined, 10) : [];
  let found: Awaited<ReturnType<typeof findAgencyOnWeb>> | null = null;
  let webError = '';
  if (q && web) {
    try { found = await findAgencyOnWeb(getClient(), q, state ? `state: ${state}` : undefined); } catch (e) { webError = (e as Error).message; }
  }
  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}><IconCircle name="plus" /><h1 style={{ margin: 0 }}>Add an agency</h1></div>
      <p className="lede" style={{ marginTop: 'var(--space-3)' }}>Search what you already have first. If it is not there, look it up on the web, confirm the match, and choose which seats to create.</p>
      {one(sp.error) && <Notice>{one(sp.error)}</Notice>}
      <form className="panel row" method="get">
        <label>Agency name<input name="q" defaultValue={q} placeholder="Boone County" required /></label>
        <label>State<input name="state" defaultValue={state} maxLength={2} size={4} placeholder="MO" /></label>
        <button type="submit">Search my agencies</button>
      </form>

      {q && (
        <>
          <h2>In your database</h2>
          <div className="panel flush">
            <table>
              <tbody>
                {local.map((a) => <tr key={a.id}><td><Link href={`/agencies/${a.id}`}>{a.name}</Link></td><td>{a.state}</td><td>{a.category}</td><td className="num">{pop(a.population)}</td></tr>)}
                {local.length === 0 && <tr><td className="muted">No match here.</td></tr>}
              </tbody>
            </table>
          </div>
          {!web && (
            <p><Link className="btn ghost" href={`/agencies/new?q=${encodeURIComponent(q)}&state=${encodeURIComponent(state)}&web=1`}>Look it up on the web</Link> <span className="small muted">One small search, roughly 2 to 4 cents. Nothing is added until you confirm.</span></p>
          )}
        </>
      )}

      {webError && <Notice>{webError}</Notice>}
      {found && (
        <>
          <h2>Found on the web</h2>
          {found.needsClarification && <Notice>{found.needsClarification}</Notice>}
          {found.matches.length === 0 && <p>Nothing confident came back. Add it by hand below.</p>}
          {found.matches.map((m, i) => <CandidateForm key={i} c={m} roles={roles} source="web_lookup" />)}
          <p className="small muted">Lookup cost {usd(found.costUsd)}.</p>
        </>
      )}

      <h2>Or add by hand</h2>
      <form action={addAgencyAction} className="panel">
        <input type="hidden" name="source" value="manual" />
        <div className="row">
          <label>Name<input name="name" required /></label>
          <label>State<input name="state" maxLength={2} size={4} required /></label>
          <label>Type<select name="category"><option value="county">County</option><option value="municipality">City or town</option><option value="township">Township</option><option value="other">Other</option></select></label>
          <label>County<input name="county" /></label>
          <label>Population<input name="population" inputMode="numeric" /></label>
          <label>Website<input name="website" placeholder="https://" /></label>
        </div>
        <p className="small" style={{ margin: 'var(--space-4) 0 var(--space-2)' }}><strong>Create seats for:</strong></p>
        <RoleBoxes roles={roles} defaults={['head_of_purchasing', 'head_of_finance', 'top_appointed_executive']} />
        <p style={{ marginBottom: 0 }}><button type="submit">Add agency</button></p>
      </form>
    </>
  );
}
