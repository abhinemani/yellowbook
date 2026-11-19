import Link from 'next/link';
import { getDb } from '@/lib/db';
import { overview } from '@/lib/queries';
import { Stat, usd } from './ui';

export const dynamic = 'force-dynamic';

export default function Overview() {
  const o = overview(getDb());
  const empty = o.seats === 0;
  return (
    <>
      <section className="hero">
        <h1>{empty ? 'Start by importing contacts' : `${o.confirmed.toLocaleString('en-US')} confirmed, ${o.replaced.toLocaleString('en-US')} replaced`}</h1>
        <p style={{ margin: 0, maxWidth: '60ch' }}>
          {empty ? (
            <>Import a Power Almanac export, or <Link href="/agencies/new">add an agency</Link> by hand. Then check any position at any agency.</>
          ) : (
            <>Of {o.checked.toLocaleString('en-US')} seats checked so far. Replacements wait in the <Link href="/review">review queue</Link>; nothing changes until you accept it.</>
          )}
        </p>
        <div className="stats">
          <Stat n={o.agencies} label="Agencies" note="in the database" />
          <Stat n={o.seats} label="Seats" note="a role at an agency, each with a contact" />
          <Stat n={o.checked} label="Checked" note="have at least one result" />
          <Stat n={o.pending} label="Awaiting review" note="need a human decision" rose />
          <Stat n={o.due} label="Due" note="not checked, or older than the stale window" />
          <Stat n={usd(o.spend)} label="Spent on checks" note="from stored usage, to date" />
        </div>
      </section>
      <div className="panel">
        <h3>Where to go next</h3>
        <p className="small" style={{ margin: 0 }}>
          <strong>Run a check:</strong> <Link href="/runs/new">choose roles, states and a size floor</Link> and see the cost before anything starts.{' '}
          <strong>Add an agency:</strong> <Link href="/agencies/new">search the database, then the web</Link>.{' '}
          <strong>Take it with you:</strong> <Link href="/data">export a CSV</Link> in the Power Almanac layout plus the check columns.
        </p>
      </div>
    </>
  );
}
