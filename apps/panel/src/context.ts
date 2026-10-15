import type { Redis } from 'ioredis';
import type { ConnectionTracker } from '@zuipanel/shared';
import type { PanelConfig } from './config.js';
import type { Db } from './db.js';

export interface AppContext {
  config: PanelConfig;
  db: Db;
  redis: Redis;
  tracker: ConnectionTracker;
}

/** Fecha a epoch en segundos como string, como hace Xtream. */
export const ts = (d: Date | null | undefined): string => (d ? String(Math.floor(d.getTime() / 1000)) : '');

/** IP real del cliente detrás de un proxy (nginx / Cloudflare). */
export function clientIp(req: { ip: string; headers: Record<string, string | string[] | undefined> }): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  return req.ip;
}
