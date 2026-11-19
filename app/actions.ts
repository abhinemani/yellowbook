'use server';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getClient } from '@/lib/client';
import { getDb } from '@/lib/db';
import { addAgency, addSeat } from '@/lib/findAgency';
import { importPowerAlmanac } from '@/lib/importer';
import { addRole } from '@/lib/queries';
import { acceptCheck, acceptConfirmations, rejectCheck } from '@/lib/review';
import { cancelRun, collectRun, createRun, runSync, submitWave, verifySeatNow } from '@/lib/runs';
import type { Scope } from '@/lib/seats';
import type { Confidence, RunKind, Tier } from '@/lib/types';

const msg = (e: unknown) => encodeURIComponent((e as Error).message ?? String(e));
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function scopeFromForm(f: FormData): Promise<Scope & { maxTier?: Tier; sync?: boolean; cap?: number }> {
  const list = (k: string) => f.getAll(k).map(String).filter(Boolean);
  const states = str(f, 'states').split(/[,\s]+/).filter(Boolean);
  return {
    roles: list('roles'),
    states: states.length ? states : undefined,
    minPop: str(f, 'minPop') ? Number(str(f, 'minPop')) : undefined,
    limit: str(f, 'limit') ? Number(str(f, 'limit')) : undefined,
    kind: (str(f, 'kind') || 'verify') as RunKind,
    maxTier: str(f, 'maxTier') ? (Number(str(f, 'maxTier')) as Tier) : undefined,
    sync: f.get('sync') === 'on',
    cap: str(f, 'cap') ? Number(str(f, 'cap')) : undefined,
  };
}

export async function startRun(f: FormData) {
  const { maxTier, sync, cap, ...scope } = await scopeFromForm(f);
  let target: string;
  try {
    const db = getDb();
    const client = getClient();
    const { runId, seats } = createRun(db, scope, { kind: scope.kind, maxTier, batch: sync ? false : undefined, capUsd: cap });
    if (seats === 0) throw new Error('Nothing is due for that scope.');
    if (sync) await runSync(db, client, runId);
    else await submitWave(db, client, runId);
    target = `/runs/${runId}`;
  } catch (e) {
    target = `/runs/new?error=${msg(e)}`;
  }
  revalidatePath('/', 'layout');
  redirect(target);
}

export async function advanceRun(runId: number) {
  let err = '';
  try {
    const db = getDb();
    const client = getClient();
    await collectRun(db, client, runId);
    await submitWave(db, client, runId);
    await collectRun(db, client, runId);
  } catch (e) {
    err = `?error=${msg(e)}`;
  }
  revalidatePath('/', 'layout');
  redirect(`/runs/${runId}${err}`);
}

export async function cancelRunAction(runId: number) {
  let client = null;
  try { client = getClient(); } catch { /* cancel locally */ }
  await cancelRun(getDb(), client, runId);
  revalidatePath('/', 'layout');
  redirect(`/runs/${runId}`);
}

export async function checkSeatNow(seatId: number, agencyId: number) {
  let q = '';
  try {
    const r = await verifySeatNow(getDb(), getClient(), seatId);
    q = `?checked=${r.checkId ?? ''}`;
  } catch (e) {
    q = `?error=${msg(e)}`;
  }
  revalidatePath('/', 'layout');
  redirect(`/agencies/${agencyId}${q}`);
}

export async function checkAgencyNow(agencyId: number) {
  let q = '';
  try {
    const db = getDb();
    const client = getClient();
    let total = 0;
    for (const kind of ['verify', 'discover'] as RunKind[]) {
      const { runId, seats } = createRun(db, { agencyIds: [agencyId], kind, includeFresh: true, ignoreCooldown: true }, { kind, batch: false, capUsd: 2 });
      if (seats) { await runSync(db, client, runId); total += seats; }
    }
    q = total ? `?checked=${total}` : '?error=' + encodeURIComponent('Every seat is already queued or waiting in the review queue.');
  } catch (e) {
    q = `?error=${msg(e)}`;
  }
  revalidatePath('/', 'layout');
  redirect(`/agencies/${agencyId}${q}`);
}

export async function addAgencyAction(f: FormData) {
  const n = (k: string) => str(f, k) || null;
  const name = str(f, 'name');
  const state = str(f, 'state').toUpperCase();
  let target: string;
  try {
    if (!name || state.length !== 2) throw new Error('A name and a two-letter state are required.');
    const category = (['county', 'municipality', 'township', 'other'].includes(str(f, 'category')) ? str(f, 'category') : 'other') as 'county';
    const id = addAgency(
      getDb(),
      { name, state, category, county: n('county'), population: n('population') ? Number(str(f, 'population').replace(/,/g, '')) : null, website: n('website'), main_phone: n('main_phone'), street_address: n('street_address'), city: n('city'), zip: n('zip'), source_url: n('source_url') },
      str(f, 'source') === 'manual' ? 'manual' : 'web_lookup',
      f.getAll('roles').map(String),
    );
    target = `/agencies/${id}`;
  } catch (e) {
    target = `/agencies/new?error=${msg(e)}`;
  }
  revalidatePath('/', 'layout');
  redirect(target);
}

export async function addSeatAction(agencyId: number, f: FormData) {
  let q = '';
  try { addSeat(getDb(), agencyId, str(f, 'role')); } catch (e) { q = `?error=${msg(e)}`; }
  revalidatePath(`/agencies/${agencyId}`);
  redirect(`/agencies/${agencyId}${q}`);
}

export async function acceptAction(checkId: number) {
  try { acceptCheck(getDb(), checkId); } catch { /* already handled */ }
  revalidatePath('/', 'layout');
}
export async function rejectAction(checkId: number) {
  try { rejectCheck(getDb(), checkId); } catch { /* already handled */ }
  revalidatePath('/', 'layout');
}
export async function acceptConfirmationsAction(f: FormData) {
  const n = acceptConfirmations(getDb(), (str(f, 'level') || 'Medium') as Confidence);
  revalidatePath('/', 'layout');
  redirect(`/review?accepted=${n}`);
}

export async function addRoleAction(f: FormData) {
  let q = '';
  try {
    addRole(getDb(), str(f, 'label'), str(f, 'definition'), str(f, 'hints').split(',').map((s) => s.trim()).filter(Boolean), f.get('multi') === 'on');
  } catch (e) {
    q = `?error=${msg(e)}`;
  }
  revalidatePath('/roles');
  redirect(`/roles${q}`);
}

export async function importAction(f: FormData) {
  let q = '';
  try {
    const files = f.getAll('files').filter((x): x is File => x instanceof File && x.size > 0);
    if (!files.length) throw new Error('Choose at least one CSV file.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-import-'));
    const out: string[] = [];
    for (const file of files) {
      const p = path.join(dir, path.basename(file.name));
      fs.writeFileSync(p, Buffer.from(await file.arrayBuffer()));
      const r = importPowerAlmanac(getDb(), p);
      out.push(`${file.name}: ${r.rows} rows, +${r.agenciesNew} agencies, +${r.contactsNew} contacts, +${r.seatsNew} seats${r.skipped ? `, ${r.skipped} skipped` : ''}`);
    }
    q = `?imported=${encodeURIComponent(out.join(' | '))}`;
  } catch (e) {
    q = `?error=${msg(e)}`;
  }
  revalidatePath('/', 'layout');
  redirect(`/data${q}`);
}
