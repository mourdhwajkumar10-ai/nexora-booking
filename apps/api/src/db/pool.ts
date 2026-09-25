import pg from 'pg';
import { config } from '../config';
import { publish, type DomainEvent } from '../lib/bus';

// Return BIGINT/NUMERIC as JS numbers (all our values fit in 2^53) and DATE as plain strings.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? config.databaseUrl, max: 30 });
    pool.on('error', (err) => console.error('[pg] idle client error', err));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<R extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = getPool()): Promise<R[]> {
  const res = await db.query<R>(text, params as any[]);
  return res.rows;
}

export async function queryOne<R extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = getPool()): Promise<R | null> {
  const rows = await query<R>(text, params, db);
  return rows[0] ?? null;
}

/** Transaction handle. Domain events emitted via `emit` are published only AFTER a successful COMMIT. */
export interface Tx {
  client: pg.PoolClient;
  query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<R[]>;
  one<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<R | null>;
  emit(event: DomainEvent): void;
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Run `fn` inside a transaction. Default isolation is READ COMMITTED on purpose: with
 * `SELECT ... FOR UPDATE` each subsequent statement takes a fresh snapshot, so a blocked
 * booking transaction sees the winner's committed reservation (CRITIQUE #2).
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, isolation: IsolationLevel = 'READ COMMITTED'): Promise<T> {
  const client = await getPool().connect();
  const events: DomainEvent[] = [];
  const tx: Tx = {
    client,
    query: (text, params = []) => query(text, params, client),
    one: (text, params = []) => queryOne(text, params, client),
    emit: (e) => {
      events.push(e);
    },
  };
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(tx);
    await client.query('COMMIT');
    client.release();
    await publish(events);
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may be broken */
    }
    client.release();
    throw err;
  }
}
