import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL ?? 'postgres://itest:itest@localhost:5432/itest';
export const pool = new pg.Pool({ connectionString: url, max: 5 });
export const db = drizzle(pool, { schema });
