/** Each parallel developer/agent can isolate tests with TEST_DB_NAME (default nexora_test). */
export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'nexora_test';
export const TEST_DB_URL = `postgres://localhost:5432/${TEST_DB_NAME}`;
