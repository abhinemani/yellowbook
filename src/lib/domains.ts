import type { Db } from './db';

/**
 * Does each contact email domain still receive mail? A DNS lookup per domain over HTTPS (plain DNS is blocked
 * in cloud sessions). Only domain names leave the machine, never addresses or names.
 *  mx        the domain publishes mail servers
 *  a_only    no mail servers but the domain resolves (mail may still be delivered to it; weak)
 *  no_mail   a "null MX" (RFC 7505): the domain says it accepts no mail
 *  nxdomain  the domain does not exist: every address on it is dead
 *  error     the lookup failed; retried next time
 * A domain that receives mail says nothing about whether the person still holds the seat. A dead domain says
 * every old address on it is gone, which is evidence worth a note, not a finding.
 */
export type DomainStatus = 'mx' | 'a_only' | 'no_mail' | 'nxdomain' | 'error';

interface DohAnswer { Status: number; Answer?: { type: number; data: string }[] }
export type DohLookup = (name: string, type: 'MX' | 'A') => Promise<DohAnswer>;

const DOH = 'https://cloudflare-dns.com/dns-query';
export const dohLookup: DohLookup = async (name, type) => {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`DoH ${res.status}`);
  return (await res.json()) as DohAnswer;
};

export async function classifyDomain(domain: string, lookup: DohLookup = dohLookup): Promise<{ status: DomainStatus; mx: string[] }> {
  try {
    const mx = await lookup(domain, 'MX');
    if (mx.Status === 3) return { status: 'nxdomain', mx: [] };
    if (mx.Status !== 0) return { status: 'error', mx: [] };
    const hosts = (mx.Answer ?? [])
      .filter((a) => a.type === 15)
      .map((a) => { const [pref, host] = a.data.trim().split(/\s+/); return { pref: Number(pref), host: (host ?? '').replace(/\.$/, '') }; })
      .sort((a, b) => a.pref - b.pref);
    if (hosts.length === 1 && hosts[0].host === '') return { status: 'no_mail', mx: [] };
    if (hosts.length) return { status: 'mx', mx: hosts.map((h) => h.host) };
    const a = await lookup(domain, 'A');
    if (a.Status === 3) return { status: 'nxdomain', mx: [] };
    return { status: (a.Answer ?? []).some((x) => x.type === 1) ? 'a_only' : 'no_mail', mx: [] };
  } catch {
    return { status: 'error', mx: [] };
  }
}

export function domainOf(email: string | null | undefined): string | null {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(email ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** Look up every active contact's email domain not checked within maxAgeDays (errors always retried). */
export async function checkDomains(db: Db, opts: { maxAgeDays?: number; concurrency?: number; lookup?: DohLookup } = {}): Promise<Record<DomainStatus, number>> {
  const rows = db.prepare(`SELECT DISTINCT email FROM contacts WHERE status = 'active' AND email LIKE '%@%'`).all() as { email: string }[];
  const all = [...new Set(rows.map((r) => domainOf(r.email)).filter((d): d is string => !!d))];
  const fresh = new Set(
    (db.prepare(`SELECT domain FROM email_domains WHERE status != 'error' AND checked_at > datetime('now', ?)`).all(`-${opts.maxAgeDays ?? 30} days`) as { domain: string }[]).map((r) => r.domain.toLowerCase()),
  );
  const todo = all.filter((d) => !fresh.has(d));
  const up = db.prepare(`INSERT INTO email_domains (domain, status, mx_hosts, checked_at) VALUES (?,?,?, datetime('now'))
                         ON CONFLICT(domain) DO UPDATE SET status = excluded.status, mx_hosts = excluded.mx_hosts, checked_at = excluded.checked_at`);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const d = todo[i++];
      const r = await classifyDomain(d, opts.lookup);
      up.run(d, r.status, r.mx.join(',') || null);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  const counts = { mx: 0, a_only: 0, no_mail: 0, nxdomain: 0, error: 0 } as Record<DomainStatus, number>;
  for (const r of db.prepare(`SELECT status, COUNT(*) n FROM email_domains GROUP BY status`).all() as { status: DomainStatus; n: number }[]) counts[r.status] = r.n;
  return counts;
}

/** Status of the email domain behind an address, if checked. */
export function emailDomainStatus(db: Db, email: string | null | undefined): DomainStatus | null {
  const d = domainOf(email);
  if (!d) return null;
  return ((db.prepare(`SELECT status FROM email_domains WHERE domain = ?`).get(d) as { status: DomainStatus } | undefined)?.status) ?? null;
}
