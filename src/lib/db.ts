import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { cfg } from './config';

export type Db = Database.Database;

interface RoleSeed {
  key: string;
  label: string;
  power_almanac_role: string | null;
  definition: string;
  title_hints: string[];
  multi?: boolean;
}

const SCHEMA_VERSION = 1;

/** Open (and if needed create) the database, apply db/schema.sql, seed roles from config/roles.json. */
export function openDb(file: string = cfg().databasePath): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === 0) {
    db.exec(fs.readFileSync(path.resolve(/* turbopackIgnore: true */ cfg().root, 'db/schema.sql'), 'utf8'));
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (version > SCHEMA_VERSION) {
    throw new Error(`Database schema v${version} is newer than this code (v${SCHEMA_VERSION}).`);
  }
  seedRoles(db);
  return db;
}

export function seedRoles(db: Db): void {
  const file = path.resolve(/* turbopackIgnore: true */ cfg().root, 'config/roles.json');
  const seeds = (JSON.parse(fs.readFileSync(file, 'utf8')) as { roles: RoleSeed[] }).roles;
  const up = db.prepare(
    `INSERT INTO roles (key, label, power_almanac_role, definition, title_hints, multi)
     VALUES (@key, @label, @pa, @definition, @hints, @multi)
     ON CONFLICT(key) DO NOTHING`,
  );
  db.transaction(() => {
    for (const r of seeds) {
      up.run({
        key: r.key,
        label: r.label,
        pa: r.power_almanac_role,
        definition: r.definition,
        hints: JSON.stringify(r.title_hints),
        multi: r.multi ? 1 : 0,
      });
    }
  })();
}

/** One shared connection per process (Next.js dev reloads modules, so park it on globalThis). */
const g = globalThis as unknown as { __yb_db?: Db };
export function getDb(): Db {
  if (!g.__yb_db) g.__yb_db = openDb();
  return g.__yb_db;
}
