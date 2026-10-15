import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ContentType } from './types.js';

/**
 * Control de conexiones simultáneas por línea, compartido por panel y nodos.
 *
 * Cada línea tiene un sorted set `zp:conn:<lineId>` cuyos miembros son sesiones
 * (un dispositivo = IP + user-agent) y cuya puntuación es el último momento
 * en que esa sesión pidió datos. Una sesión que no pide nada en WINDOW_MS deja
 * de contar. Cambiar de canal no consume una conexión nueva.
 */
export const CONNECTION_WINDOW_MS = 30_000;

const ACQUIRE_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local max = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
if redis.call('ZSCORE', key, member) then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window * 2)
  return 1
end
if max > 0 and redis.call('ZCARD', key) >= max then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window * 2)
return 1
`;

export interface SessionInfo {
  lineId: number;
  username?: string;
  type: ContentType;
  itemId: number;
  ip: string;
  userAgent: string;
  serverId?: number;
}

export function sessionId(lineId: number, ip: string, userAgent: string): string {
  return createHash('sha1').update(`${lineId}|${ip}|${userAgent}`).digest('hex').slice(0, 16);
}

const connKey = (lineId: number) => `zp:conn:${lineId}`;
const sessKey = (sid: string) => `zp:sess:${sid}`;

export class ConnectionTracker {
  constructor(private redis: Redis, private windowMs = CONNECTION_WINDOW_MS) {}

  /**
   * Registra o refresca una sesión. Devuelve false si la línea ya tiene
   * todas sus conexiones ocupadas por otros dispositivos.
   */
  async acquire(sid: string, maxConnections: number, info: SessionInfo): Promise<boolean> {
    const now = Date.now();
    const res = await this.redis.eval(
      ACQUIRE_LUA, 1, connKey(info.lineId), sid, String(now), String(this.windowMs), String(maxConnections),
    );
    if (res !== 1) return false;
    await this.redis
      .multi()
      .hset(sessKey(sid), {
        lineId: info.lineId,
        username: info.username ?? '',
        type: info.type,
        itemId: info.itemId,
        ip: info.ip,
        userAgent: info.userAgent,
        serverId: info.serverId ?? 0,
        lastSeen: now,
      })
      .hsetnx(sessKey(sid), 'startedAt', String(now))
      .pexpire(sessKey(sid), this.windowMs * 2)
      .zadd('zp:sessions', now, `${info.lineId}:${sid}`)
      .exec();
    return true;
  }

  async activeCount(lineId: number): Promise<number> {
    return this.redis.zcount(connKey(lineId), Date.now() - this.windowMs, '+inf');
  }

  /** Expulsa una sesión (o todas las de la línea si no se indica sid). */
  async kick(lineId: number, sid?: string): Promise<void> {
    if (sid) {
      await this.redis.multi().zrem(connKey(lineId), sid).del(sessKey(sid)).exec();
      await this.redis.set(`zp:kicked:${sid}`, '1', 'PX', this.windowMs);
    } else {
      const members = await this.redis.zrange(connKey(lineId), 0, -1);
      for (const m of members) await this.kick(lineId, m);
    }
  }

  async isKicked(sid: string): Promise<boolean> {
    return (await this.redis.exists(`zp:kicked:${sid}`)) === 1;
  }

  /** Lista de sesiones activas en todo el sistema (para el panel de admin). */
  async listActive(): Promise<Array<Record<string, string> & { sid: string }>> {
    const cutoff = Date.now() - this.windowMs;
    await this.redis.zremrangebyscore('zp:sessions', '-inf', cutoff);
    const members = await this.redis.zrange('zp:sessions', 0, -1);
    const out: Array<Record<string, string> & { sid: string }> = [];
    for (const m of members) {
      const sid = m.split(':')[1];
      const data = await this.redis.hgetall(sessKey(sid));
      if (data && Object.keys(data).length) out.push({ ...data, sid });
    }
    return out;
  }
}
