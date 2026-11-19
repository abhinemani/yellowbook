import { describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/db';
import { accountIdFromPersonId, importPowerAlmanac, parsePaDate, parsePopulation } from '../src/lib/importer';
import { FIXTURE_CSV, fixtureDb, writeTmp } from './helpers';

describe('power almanac importer', () => {
  it('parses the quirks of the real exports', () => {
    expect(parsePopulation(' 250,000 ')).toBe(250000);
    expect(parsePopulation('10019635')).toBe(10019635);
    expect(parsePaDate('28-Mar-24')).toBe('2024-03-28');
    expect(accountIdFromPersonId('100000000000001-AAA1111')).toBe('100000000000001');
    expect(accountIdFromPersonId('100000000000001 -AAA1111')).toBe('100000000000001'); // stray space seen in a real export
  });

  it('imports agencies, contacts and seats from a BOM file with padded headers', () => {
    const db = openDb(':memory:');
    const rep = importPowerAlmanac(db, writeTmp('f.csv', FIXTURE_CSV));
    expect(rep.rows).toBe(6);
    expect(rep.agenciesNew).toBe(3);
    expect(rep.contactsNew).toBe(6);
    const ex = db.prepare(`SELECT * FROM agencies WHERE name = 'Example County'`).get() as any;
    expect(ex.population).toBe(250000);
    expect(ex.power_almanac_account_id).toBe('100000000000001');
    expect(ex.website).toBe('https://www.examplecounty.gov/');
  });

  it('turns a multi-valued Role into several seats held by one contact', () => {
    const db = fixtureDb();
    const rows = db.prepare(`SELECT s.role_key, s.current_contact_id FROM seats s JOIN agencies a ON a.id = s.agency_id WHERE a.name = 'City of Sampleville' AND s.role_key IN ('top_appointed_executive','head_of_facilities_management')`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].current_contact_id).toBe(rows[1].current_contact_id);
  });

  it('gives each deputy their own numbered seat', () => {
    const db = fixtureDb();
    const deps = db.prepare(`SELECT s.slot, c.last_name FROM seats s JOIN contacts c ON c.id = s.current_contact_id WHERE s.role_key = 'deputy_top_appointed_executive' ORDER BY s.slot`).all() as any[];
    expect(deps.map((d) => [d.slot, d.last_name])).toEqual([[1, 'One'], [2, 'Two']]);
  });

  it('keeps the first person for a single-holder role and counts the conflict', () => {
    const db = openDb(':memory:');
    const rep = importPowerAlmanac(db, writeTmp('f.csv', FIXTURE_CSV));
    expect(rep.conflicts).toBe(0); // Pat Lee is the only purchasing head at Sampleville here
    const dup = FIXTURE_CSV.replace('Head of Quantum Procurement', 'Head of Purchasing').replace('100000000000003-FFF6666', '100000000000002-ZZZ9999');
    const rep2 = importPowerAlmanac(db, writeTmp('g.csv', dup));
    expect(rep2.conflicts).toBeGreaterThan(0);
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    const f = writeTmp('f.csv', FIXTURE_CSV);
    importPowerAlmanac(db, f);
    const before = db.prepare('SELECT (SELECT COUNT(*) FROM agencies) a, (SELECT COUNT(*) FROM contacts) c, (SELECT COUNT(*) FROM seats) s').get();
    const rep = importPowerAlmanac(db, f);
    expect(db.prepare('SELECT (SELECT COUNT(*) FROM agencies) a, (SELECT COUNT(*) FROM contacts) c, (SELECT COUNT(*) FROM seats) s').get()).toEqual(before);
    expect(rep.agenciesNew + rep.contactsNew + rep.seatsNew).toBe(0);
  });

  it('creates a custom role for an unknown Role string and reports it', () => {
    const db = openDb(':memory:');
    const rep = importPowerAlmanac(db, writeTmp('f.csv', FIXTURE_CSV));
    expect(rep.rolesCreated).toEqual(['Head of Quantum Procurement']);
    expect(db.prepare(`SELECT key FROM roles WHERE power_almanac_role = 'Head of Quantum Procurement'`).get()).toEqual({ key: 'head_of_quantum_procurement' });
  });

  it('does not merge different people who share a mailbox', () => {
    const csv = FIXTURE_CSV + 'purchasing@samplecity.org,Kim,Park,Analyst,City of Sampleville,100000000000002-GGG7777,1.00000E+14,Head of Finance,555-0204,,2 Oak Ave,,Sampleville,MO,63001,municipality,Sampleville,City,Example,https://samplecity.org,555-0001,2 Oak Ave,Sampleville,MO,63001,40000,15-Jan-24,July,SAME \n';
    const db = openDb(':memory:');
    importPowerAlmanac(db, writeTmp('f.csv', csv));
    expect((db.prepare(`SELECT COUNT(*) n FROM contacts WHERE email = 'purchasing@samplecity.org'`).get() as any).n).toBe(2);
  });
});
