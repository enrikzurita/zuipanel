function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export interface PanelConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  /** Secreto HMAC compartido con los nodos para firmar tokens de stream */
  streamSecret: string;
  /** Token Bearer para la API de administración */
  adminToken: string;
  /** Clave que usan los agentes de nodo para hablar con el panel */
  agentKey: string;
  /** URL pública del panel (la que ven los clientes en server_info) */
  publicUrl: string;
  timezone: string;
  /** Validez de los tokens de stream en segundos */
  tokenTtl: number;
  /** Si es true, el token solo vale desde la IP que lo pidió */
  lockTokenToIp: boolean;
  /** Si un nodo no manda heartbeat en este tiempo se considera caído */
  serverTimeoutSec: number;
}

export function loadConfig(env = process.env): PanelConfig {
  const publicUrl = (env.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL ?? required('DATABASE_URL'),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    streamSecret: env.STREAM_SECRET ?? required('STREAM_SECRET'),
    adminToken: env.ADMIN_TOKEN ?? required('ADMIN_TOKEN'),
    agentKey: env.AGENT_KEY ?? required('AGENT_KEY'),
    publicUrl,
    timezone: env.TZ_NAME ?? 'Europe/Madrid',
    tokenTtl: Number(env.TOKEN_TTL ?? 6 * 3600),
    lockTokenToIp: (env.LOCK_TOKEN_TO_IP ?? 'true') === 'true',
    serverTimeoutSec: Number(env.SERVER_TIMEOUT ?? 90),
  };
}
