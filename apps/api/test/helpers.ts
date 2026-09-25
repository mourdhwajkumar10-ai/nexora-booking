/**
 * Test helpers. Typical file:
 *
 *   let ctx: TestContext;
 *   beforeAll(async () => { ctx = await createTestContext(); });
 *   beforeEach(async () => { await ctx.reset(); });   // truncates + reseeds fixture, freezes clock
 *   afterAll(async () => { await ctx.close(); });
 *
 * Clock is frozen at FIXTURE_NOW (Fri 2026-10-02 18:00 IST) after every reset.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { closePool, getPool } from '../src/db/pool';
import { ALL_TABLES } from '../src/db/migrate';
import { seedTestFixture, type TestFixture } from '../src/db/seed';
import { clock } from '../src/lib/clock';

export const FIXTURE_DATE = '2026-10-02'; // Friday
export const FIXTURE_NOW = '2026-10-02T12:30:00.000Z'; // 18:00 IST

export interface TestContext {
  app: FastifyInstance;
  fx: TestFixture;
  reset(): Promise<void>;
  close(): Promise<void>;
  /** Log in and return a Cookie header value. role: 'manager' (org-wide) | 'host' (venue) | 'other' (other venue host) */
  login(role?: 'manager' | 'host' | 'other'): Promise<string>;
}

export async function resetDatabase(): Promise<TestFixture> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${ALL_TABLES.join(', ')} CASCADE`);
    const fx = await seedTestFixture(client);
    await client.query('COMMIT');
    return fx;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function createTestContext(): Promise<TestContext> {
  const app = await buildApp();
  await app.ready();
  const ctx: TestContext = {
    app,
    fx: undefined as unknown as TestFixture,
    async reset() {
      clock.set(FIXTURE_NOW);
      ctx.fx = await resetDatabase();
    },
    async close() {
      clock.reset();
      await app.close();
      await closePool();
    },
    async login(role = 'manager') {
      const email = role === 'manager' ? ctx.fx.managerEmail : role === 'host' ? ctx.fx.hostEmail : ctx.fx.otherVenueHostEmail;
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: ctx.fx.password } });
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
      const cookie = res.cookies.find((c) => c.name === 'nexora_session');
      return `nexora_session=${cookie!.value}`;
    },
  };
  await ctx.reset();
  return ctx;
}
