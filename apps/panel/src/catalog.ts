import type { ContentType } from '@zuipanel/shared';
import { type Db, parseJson, query, queryOne } from './db.js';

export interface LineRow {
  id: number;
  username: string;
  password: string;
  max_connections: number;
  exp_date: Date | null;
  enabled: number;
  is_trial: number;
  allowed_outputs: string[] | null;
  allowed_ips: string[] | null;
  created_at: Date;
}

export type LineStatus = 'Active' | 'Expired' | 'Disabled' | 'Banned';

export interface AuthResult {
  line: LineRow;
  status: LineStatus;
}

/** Devuelve null si usuario/contraseña no son válidos. */
export async function authenticate(db: Db, username: string, password: string, ip?: string): Promise<AuthResult | null> {
  if (!username || !password) return null;
  const line = await queryOne<LineRow>(db, 'SELECT * FROM user_lines WHERE username = ?', [username]);
  if (!line || line.password !== password) return null;
  line.allowed_outputs = parseJson<string[] | null>(line.allowed_outputs, null);
  line.allowed_ips = parseJson<string[] | null>(line.allowed_ips, null);
  let status: LineStatus = 'Active';
  if (!line.enabled) status = 'Disabled';
  else if (line.exp_date && line.exp_date.getTime() < Date.now()) status = 'Expired';
  else if (ip && line.allowed_ips && line.allowed_ips.length && !line.allowed_ips.includes(ip)) status = 'Banned';
  return { line, status };
}

export function allowedOutputs(line: LineRow): string[] {
  return line.allowed_outputs?.length ? line.allowed_outputs : ['m3u8', 'ts', 'rtmp'];
}

/**
 * Subconsulta con los ids de un tipo de contenido accesibles para la línea
 * y su orden (primero el orden del paquete en la línea, después el del item).
 */
function allowedSubquery(type: ContentType): string {
  return `SELECT bi.item_id, MIN(lb.sort * 1000000 + bi.sort) AS ord
          FROM line_bouquets lb
          JOIN bouquet_items bi ON bi.bouquet_id = lb.bouquet_id
          WHERE lb.line_id = ? AND bi.item_type = '${type}'
          GROUP BY bi.item_id`;
}

const TABLE: Record<ContentType, string> = { live: 'streams', movie: 'movies', series: 'series' };

export interface CategoryRow {
  id: number;
  name: string;
  parent_id: number;
}

export async function categoriesForLine(db: Db, lineId: number, type: ContentType): Promise<CategoryRow[]> {
  return query<CategoryRow>(
    db,
    `SELECT DISTINCT c.id, c.name, c.parent_id, c.sort
       FROM categories c
       JOIN ${TABLE[type]} x ON x.category_id = c.id AND x.enabled = 1
       JOIN (${allowedSubquery(type)}) a ON a.item_id = x.id
      WHERE c.type = ?
      ORDER BY c.sort, c.id`,
    [lineId, type],
  );
}

export interface StreamRow {
  id: number;
  name: string;
  category_id: number | null;
  icon: string;
  epg_channel_id: string;
  custom_sid: string;
  added_at: Date;
}

export async function liveStreamsForLine(db: Db, lineId: number, categoryId?: number): Promise<StreamRow[]> {
  return query<StreamRow>(
    db,
    `SELECT s.id, s.name, s.category_id, s.icon, s.epg_channel_id, s.custom_sid, s.added_at
       FROM streams s JOIN (${allowedSubquery('live')}) a ON a.item_id = s.id
      WHERE s.enabled = 1 ${categoryId ? 'AND s.category_id = ?' : ''}
      ORDER BY a.ord, s.sort, s.id`,
    categoryId ? [lineId, categoryId] : [lineId],
  );
}

export interface MovieRow {
  id: number;
  name: string;
  category_id: number | null;
  icon: string;
  container_extension: string;
  tmdb_id: number | null;
  rating: string;
  info: Record<string, unknown> | null;
  added_at: Date;
}

export async function moviesForLine(db: Db, lineId: number, categoryId?: number): Promise<MovieRow[]> {
  const rows = await query<MovieRow>(
    db,
    `SELECT m.id, m.name, m.category_id, m.icon, m.container_extension, m.tmdb_id, m.rating, m.info, m.added_at
       FROM movies m JOIN (${allowedSubquery('movie')}) a ON a.item_id = m.id
      WHERE m.enabled = 1 ${categoryId ? 'AND m.category_id = ?' : ''}
      ORDER BY a.ord, m.sort, m.id`,
    categoryId ? [lineId, categoryId] : [lineId],
  );
  for (const r of rows) r.info = parseJson<Record<string, unknown> | null>(r.info, null);
  return rows;
}

export interface SeriesRow {
  id: number;
  name: string;
  category_id: number | null;
  cover: string;
  tmdb_id: number | null;
  rating: string;
  info: Record<string, unknown> | null;
  last_modified: Date;
}

export async function seriesForLine(db: Db, lineId: number, categoryId?: number): Promise<SeriesRow[]> {
  const rows = await query<SeriesRow>(
    db,
    `SELECT sr.id, sr.name, sr.category_id, sr.cover, sr.tmdb_id, sr.rating, sr.info, sr.last_modified
       FROM series sr JOIN (${allowedSubquery('series')}) a ON a.item_id = sr.id
      WHERE sr.enabled = 1 ${categoryId ? 'AND sr.category_id = ?' : ''}
      ORDER BY a.ord, sr.sort, sr.id`,
    categoryId ? [lineId, categoryId] : [lineId],
  );
  for (const r of rows) r.info = parseJson<Record<string, unknown> | null>(r.info, null);
  return rows;
}

export interface EpisodeRow {
  id: number;
  series_id: number;
  season: number;
  episode_num: number;
  title: string;
  container_extension: string;
  info: Record<string, unknown> | null;
  added_at: Date;
}

export async function episodesForSeries(db: Db, seriesId: number): Promise<EpisodeRow[]> {
  const rows = await query<EpisodeRow>(
    db,
    `SELECT id, series_id, season, episode_num, title, container_extension, info, added_at
       FROM episodes WHERE series_id = ? ORDER BY season, episode_num, id`,
    [seriesId],
  );
  for (const r of rows) r.info = parseJson<Record<string, unknown> | null>(r.info, null);
  return rows;
}

/** ¿Puede la línea ver este contenido? Para episodios se comprueba su serie. */
export async function lineCanAccess(
  db: Db,
  lineId: number,
  type: ContentType | 'episode',
  itemId: number,
): Promise<boolean> {
  let bouquetType: ContentType = type === 'episode' ? 'series' : type;
  let id = itemId;
  if (type === 'episode') {
    const ep = await queryOne<{ series_id: number }>(db, 'SELECT series_id FROM episodes WHERE id = ?', [itemId]);
    if (!ep) return false;
    id = ep.series_id;
    bouquetType = 'series';
  }
  const row = await queryOne(
    db,
    `SELECT 1 FROM line_bouquets lb
       JOIN bouquet_items bi ON bi.bouquet_id = lb.bouquet_id
      WHERE lb.line_id = ? AND bi.item_type = ? AND bi.item_id = ? LIMIT 1`,
    [lineId, bouquetType, id],
  );
  return !!row;
}
