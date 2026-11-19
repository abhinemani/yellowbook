import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/lib/db';
import { importPowerAlmanac } from '../src/lib/importer';

/** Invented data only ("Example County"). Never put real contacts in tests. */
export const FIXTURE_CSV = `﻿Email Address,First Name,Last Name,Title,Government Designated Name,Person ID,Power Almanac Account ID,Role,Phone Number,Phone Number Ext,Street Address or PO Box Number,Suite Number,City,State,Zip Code,Government Category,Government Place Name ,Government Category Name,Government County Location,Government Web Address,Government Main Phone Number,Government Street Address,Government City ,Government State,Government Zip Code, Population ,Last Verified Date,Fiscal Year End,Update Status
jane.doe@examplecounty.gov,Jane,Doe,Purchasing Agent,Example County,100000000000001-AAA1111,1.00000E+14,Head of Purchasing,555-0100,,1 Main St,,Exampleton,MO,63000,county,Example,County,Example,https://www.examplecounty.gov/,555-0000,1 Main St,Exampleton,MO,63000," 250,000 ",28-Mar-24,June,SAME 
sam.roe@samplecity.org,Sam,Roe,City Manager,City of Sampleville,100000000000002-BBB2222,1.00000E+14,"Top Appointed Executive,Head of Facilities Management",555-0200,,2 Oak Ave,,Sampleville,MO,63001,municipality,Sampleville,City,Example,https://samplecity.org,555-0001,2 Oak Ave,Sampleville,MO,63001,40000,15-Jan-24,July,SAME 
purchasing@samplecity.org,Pat,Lee,Buyer,City of Sampleville,100000000000002-CCC3333,1.00000E+14,Head of Purchasing,555-0201,,2 Oak Ave,,Sampleville,MO,63001,municipality,Sampleville,City,Example,https://samplecity.org,555-0001,2 Oak Ave,Sampleville,MO,63001,40000,15-Jan-24,July,SAME 
dep1@samplecity.org,Dee,One,Deputy City Manager,City of Sampleville,100000000000002-DDD4444,1.00000E+14,Deputy Top Appointed Executive,555-0202,,2 Oak Ave,,Sampleville,MO,63001,municipality,Sampleville,City,Example,https://samplecity.org,555-0001,2 Oak Ave,Sampleville,MO,63001,40000,15-Jan-24,July,SAME 
dep2@samplecity.org,Dan,Two,Assistant City Manager,City of Sampleville,100000000000002-EEE5555,1.00000E+14,Deputy Top Appointed Executive,555-0203,,2 Oak Ave,,Sampleville,MO,63001,municipality,Sampleville,City,Example,https://samplecity.org,555-0001,2 Oak Ave,Sampleville,MO,63001,40000,15-Jan-24,July,SAME 
x.y@testtownship.us,Xia,Yu,Clerk,Test Township,100000000000003-FFF6666,1.00000E+14,Head of Quantum Procurement,555-0300,,3 Elm Rd,,Testburg,OH,44000,township,Testburg,Township,Other,,555-0002,3 Elm Rd,Testburg,OH,44000,1200,01-Feb-24,Dec,SAME 
`;

export function writeTmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

export function fixtureDb(): Db {
  const db = openDb(':memory:');
  importPowerAlmanac(db, writeTmp('fixture.csv', FIXTURE_CSV));
  return db;
}

export function seatId(db: Db, agencyLike: string, roleKey: string, slot = 1): number {
  const row = db
    .prepare(`SELECT s.id FROM seats s JOIN agencies a ON a.id = s.agency_id WHERE a.name LIKE ? AND s.role_key = ? AND s.slot = ?`)
    .get(`%${agencyLike}%`, roleKey, slot) as { id: number } | undefined;
  if (!row) throw new Error(`no seat ${agencyLike}/${roleKey}/${slot}`);
  return row.id;
}

// ---------- fake API ----------

export interface FakeMsgOpts {
  fetches?: { url: string; text: string }[];
  searchUrls?: string[];
  errors?: { tool: 'web_fetch' | 'web_search'; code: string }[];
  stop?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export function fakeMessage(json: unknown | string, o: FakeMsgOpts = {}) {
  const content: unknown[] = [];
  for (const f of o.fetches ?? []) {
    content.push({ type: 'server_tool_use', id: `f_${content.length}`, name: 'web_fetch', input: { url: f.url } });
    content.push({ type: 'web_fetch_tool_result', tool_use_id: 'x', content: { type: 'web_fetch_result', url: f.url, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: f.text } } } });
  }
  if (o.searchUrls) {
    content.push({ type: 'server_tool_use', id: 's_1', name: 'web_search', input: { query: 'q' } });
    content.push({ type: 'web_search_tool_result', tool_use_id: 'x', content: o.searchUrls.map((u) => ({ type: 'web_search_result', url: u, title: 't', encrypted_content: 'xx' })) });
  }
  for (const e of o.errors ?? []) {
    content.push({ type: 'server_tool_use', id: `e_${content.length}`, name: e.tool, input: {} });
    content.push(e.tool === 'web_fetch'
      ? { type: 'web_fetch_tool_result', tool_use_id: 'x', content: { type: 'web_fetch_tool_result_error', error_code: e.code } }
      : { type: 'web_search_tool_result', tool_use_id: 'x', content: { type: 'web_search_tool_result_error', error_code: e.code } });
  }
  content.push({ type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) });
  const nf = (o.fetches?.length ?? 0) + (o.errors?.filter((e) => e.tool === 'web_fetch').length ?? 0);
  const ns = (o.searchUrls ? 1 : 0) + (o.errors?.filter((e) => e.tool === 'web_search').length ?? 0);
  return {
    content,
    stop_reason: o.stop ?? 'end_turn',
    usage: { input_tokens: o.inputTokens ?? 15000, output_tokens: o.outputTokens ?? 400, server_tool_use: { web_search_requests: ns, web_fetch_requests: nf } },
  };
}

export function result(over: Record<string, unknown> = {}) {
  return {
    status: 'confirmed_in_role', found_name: 'Jane Doe', found_title: 'Purchasing Agent', found_email: 'jane.doe@examplecounty.gov',
    found_email_is_generic: false, found_phone: '555-0100', source_url: 'https://www.examplecounty.gov/staff', evidence_date: '2026-03-04',
    confidence: 'High', unresolved_reason: null, notes: 'Named on the staff page and a March 2026 agenda.', ...over,
  };
}

/** A fake Anthropic client with a scriptable Batches API and Messages API. */
export function fakeClient(script: (customId: string, params: any) => ReturnType<typeof fakeMessage> | Error) {
  const sent: { custom_id: string; params: any }[] = [];
  const batches = new Map<string, string[]>();
  let n = 0;
  const client = {
    sent,
    messages: {
      create: async (params: any) => {
        const r = script('sync', params);
        if (r instanceof Error) throw r;
        return r;
      },
      batches: {
        create: async ({ requests }: { requests: { custom_id: string; params: any }[] }) => {
          const id = `batch_${++n}`;
          sent.push(...requests);
          batches.set(id, requests.map((r) => r.custom_id));
          return { id };
        },
        retrieve: async () => ({ processing_status: 'ended' }),
        results: async (id: string) => {
          const ids = batches.get(id)!;
          const entries = ids.map((cid) => {
            const params = sent.find((s) => s.custom_id === cid)!.params;
            const r = script(cid, params);
            return r instanceof Error
              ? { custom_id: cid, result: { type: 'errored', error: { error: { type: 'overloaded_error', message: r.message } } } }
              : { custom_id: cid, result: { type: 'succeeded', message: r } };
          });
          return (async function* () { for (const e of entries) yield e; })();
        },
        cancel: async () => ({}),
      },
    },
  };
  return client as unknown as import('@anthropic-ai/sdk').default & { sent: typeof sent };
}
