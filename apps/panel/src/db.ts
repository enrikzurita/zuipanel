import mysql, { type Pool, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';

export type Db = Pool;

export function createDb(url: string): Db {
  return mysql.createPool({
    uri: url,
    connectionLimit: 20,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    // Devuelve las columnas JSON ya parseadas
    typeCast(field, next) {
      if (field.type === 'JSON') {
        const v = field.string('utf8');
        return v == null ? null : JSON.parse(v);
      }
      return next();
    },
  });
}

export async function query<T = RowDataPacket>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await db.query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

export async function queryOne<T = RowDataPacket>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(db, sql, params);
  return rows[0] ?? null;
}

export async function execute(db: Db, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [res] = await db.query<ResultSetHeader>(sql, params);
  return res;
}

/** MariaDB guarda JSON como LONGTEXT; el typeCast anterior no siempre lo detecta. */
export function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}
