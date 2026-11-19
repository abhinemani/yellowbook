import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/db';
import { checkDomains, classifyDomain, domainOf, type DohLookup } from '../src/lib/domains';
import { fixtureDb } from './helpers';

const zone: Record<string, { MX?: any; A?: any }> = {
  'examplecounty.gov': { MX: { Status: 0, Answer: [{ type: 15, data: '20 mx2.examplecounty.gov.' }, { type: 15, data: '10 mx1.examplecounty.gov.' }] } },
  'oldtown.example.us': { MX: { Status: 3 } },
  'nomail.example.org': { MX: { Status: 0, Answer: [{ type: 15, data: '0 .' }] } },
  'aonly.example.org': { MX: { Status: 0 }, A: { Status: 0, Answer: [{ type: 1, data: '192.0.2.1' }] } },
};
const fake: DohLookup = async (name, type) => {
  const z = zone[name];
  if (!z) throw new Error('network');
  return z[type] ?? { Status: 0 };
};

describe('email domain check', () => {
  it('classifies mail servers, missing domains, null MX, A-only and failures', async () => {
    expect(await classifyDomain('examplecounty.gov', fake)).toEqual({ status: 'mx', mx: ['mx1.examplecounty.gov', 'mx2.examplecounty.gov'] });
    expect((await classifyDomain('oldtown.example.us', fake)).status).toBe('nxdomain');
    expect((await classifyDomain('nomail.example.org', fake)).status).toBe('no_mail');
    expect((await classifyDomain('aonly.example.org', fake)).status).toBe('a_only');
    expect((await classifyDomain('unreachable.example.net', fake)).status).toBe('error');
  });

  it('reads the domain from an address and ignores junk', () => {
    expect(domainOf('Jane.Doe@ExampleCounty.gov ')).toBe('examplecounty.gov');
    expect(domainOf('not an email')).toBeNull();
    expect(domainOf(null)).toBeNull();
  });

  it('stores one row per contact domain and only sends domains', async () => {
    const db = fixtureDb();
    const seen: string[] = [];
    await checkDomains(db, { lookup: async (n, t) => { seen.push(n); return fake(n, t).catch(() => ({ Status: 3 })); } });
    expect(seen.every((n) => !n.includes('@'))).toBe(true);
    const n = (db.prepare('SELECT COUNT(*) n FROM email_domains').get() as { n: number }).n;
    expect(n).toBeGreaterThan(0);
  });
});

describe('migrations', () => {
  it('upgrades a v1 database to the current schema without touching its data', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yb-mig-')), 'v1.sqlite');
    const raw = new Database(file);
    const schema = fs.readFileSync('db/schema.sql', 'utf8').split('-- v2:')[0];
    raw.exec(schema);
    raw.pragma('user_version = 1');
    raw.prepare(`INSERT INTO agencies (name, category, state) VALUES ('Example County', 'county', 'OH')`).run();
    raw.close();
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'email_domains'`).get()).toBeTruthy();
    expect((db.prepare('SELECT COUNT(*) n FROM agencies').get() as { n: number }).n).toBe(1);
  });
});
