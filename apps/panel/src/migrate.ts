import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** Aplica en orden los .sql de db/migrations que aún no se hayan aplicado. */
export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR, log = console.log): Promise<string[]> {
  const conn = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const [rows] = await conn.query('SELECT name FROM schema_migrations');
    const done = new Set((rows as Array<{ name: string }>).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      log(`Aplicando ${f}…`);
      await conn.query(await readFile(join(dir, f), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
      applied.push(f);
    }
    log(applied.length ? `${applied.length} migración(es) aplicada(s).` : 'La base de datos ya está al día.');
    return applied;
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta DATABASE_URL');
    process.exit(1);
  }
  migrate(url).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
