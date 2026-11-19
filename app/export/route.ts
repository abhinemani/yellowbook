import { getDb } from '@/lib/db';
import { exportCsv } from '@/lib/export';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const u = new URL(req.url);
  const roles = u.searchParams.get('roles')?.split(',').filter(Boolean);
  const states = u.searchParams.get('states')?.split(',').filter(Boolean);
  const csv = exportCsv(getDb(), { roles, states });
  return new Response('﻿' + csv, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="yellowbook-export-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
