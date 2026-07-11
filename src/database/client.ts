import pg from "pg";

const { Pool } = pg;

export type Database = pg.Pool;

export function createDatabase(connectionString: string): Database {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
}
