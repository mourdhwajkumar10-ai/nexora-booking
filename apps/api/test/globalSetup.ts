import { createDatabase, migrate } from '../src/db/migrate';
import { TEST_DB_URL } from './testDb';

export default async function setup() {
  await createDatabase(TEST_DB_URL, { drop: true });
  await migrate(TEST_DB_URL, () => {});
}
