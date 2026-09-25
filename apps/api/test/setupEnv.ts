import { TEST_DB_URL } from './testDb';

process.env.DATABASE_URL = TEST_DB_URL;
process.env.WORKERS = '0';
process.env.NODE_ENV = 'test';
