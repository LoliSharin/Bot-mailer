import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required for migrations.');
  process.exit(1);
}

const migrationsDir = resolve(process.cwd(), 'db', 'migrations');
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const pool = new Pool({
  connectionString: databaseUrl,
});

const ensureMigrationsTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

async function run() {
  await pool.query(ensureMigrationsTableSql);

  /** @type {import('pg').QueryResult<{ filename: string }>} */
  const appliedRows = await pool.query(
    'SELECT filename FROM schema_migrations ORDER BY filename ASC',
  );
  const appliedSet = new Set(appliedRows.rows.map((row) => row.filename));

  for (const file of migrationFiles) {
    if (appliedSet.has(file)) {
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    console.log(`Applying migration: ${file}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  console.log('Migrations complete.');
}

run()
  .catch((error) => {
    const message =
      error instanceof Error ? error.message : 'Unknown migration error';
    console.error(`Migration failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
