import pg from 'pg';
import { config } from '../config';
import { ALL_TABLES, createDatabase, migrate } from './migrate';
import { seedDemo } from './seed';

const url = process.env.DATABASE_URL ?? config.databaseUrl;
const cmd = process.argv[2];

async function withClient(fn: (c: pg.Client) => Promise<void>) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.end();
  }
}

async function seed() {
  await withClient(async (c) => {
    await c.query('BEGIN');
    await c.query(`TRUNCATE ${ALL_TABLES.join(', ')} CASCADE`);
    await seedDemo(c);
    await c.query('COMMIT');
  });
  console.log('[seed] demo data loaded. Staff logins: manager@nexora.dev / host@nexora.dev (password: nexora123)');
}

switch (cmd) {
  case 'create':
    await createDatabase(url);
    console.log('[db] ok');
    break;
  case 'migrate':
    await createDatabase(url);
    await migrate(url);
    break;
  case 'reset':
    await createDatabase(url, { drop: true });
    await migrate(url);
    await seed();
    break;
  case 'seed':
    await seed();
    break;
  default:
    console.error('usage: cli.ts create|migrate|reset|seed');
    process.exit(1);
}
