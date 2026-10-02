import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(connectionString: string, log: (m: string) => void = console.log): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

/** Parse db name out of a connection string and return [adminUrl, dbName]. */
export function splitDbUrl(url: string): [string, string] {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, '');
  u.pathname = '/postgres';
  return [u.toString(), name];
}

export async function createDatabase(url: string, { drop = false } = {}): Promise<void> {
  const [adminUrl, name] = splitDbUrl(url);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Refusing unsafe database name "${name}"`);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    if (drop) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

/** Every application table, for fast test resets. */
export const ALL_TABLES = [
  'crm_campaign_deliveries',
  'crm_campaigns',
  'crm_segments',
  'booster_rules',
  'vouchers',
  'suppressions',
  'consent_state',
  'consent_events',
  'wifi_devices',
  'table_combinations',
  'pos_adjustments',
  'reservation_tables',
  'turn_time_rules',
  'waitlist_entries',
  'webhook_events', 'notifications_outbox', 'alerts', 'wifi_sessions', 'wifi_otps',
  'gift_card_ledger', 'gift_card_holds', 'gift_cards', 'loyalty_holds', 'loyalty_ledger', 'loyalty_accounts',
  'pos_void_logs', 'pos_order_items', 'pos_orders', 'reservation_events', 'reservations',
  'guest_devices', 'guest_tags', 'guest_profiles', 'guests', 'audit_logs', 'staff_users', 'menu_items',
  'dining_tables', 'operating_shifts', 'venues', 'localities',
];
