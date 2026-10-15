function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export interface AgentConfig {
  port: number;
  host: string;
  serverId: number;
  panelUrl: string;
  agentKey: string;
  streamSecret: string;
  redisUrl: string;
  hlsDir: string;
  ffmpegPath: string;
  idleTimeoutSec: number;
  stallTimeoutSec: number;
  syncIntervalSec: number;
  lockTokenToIp: boolean;
  /**
   * Si se define (p. ej. "/_vod"), los ficheros VOD los sirve nginx mediante
   * X-Accel-Redirect en vez de Node. Mucho más eficiente en producción.
   */
  xAccelPrefix: string;
}

export function loadAgentConfig(env = process.env): AgentConfig {
  return {
    port: Number(env.PORT ?? 8081),
    host: env.HOST ?? '0.0.0.0',
    serverId: Number(required(env, 'SERVER_ID')),
    panelUrl: required(env, 'PANEL_URL').replace(/\/$/, ''),
    agentKey: required(env, 'AGENT_KEY'),
    streamSecret: required(env, 'STREAM_SECRET'),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    hlsDir: env.HLS_DIR ?? '/var/lib/zuipanel/hls',
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    idleTimeoutSec: Number(env.IDLE_TIMEOUT ?? 60),
    stallTimeoutSec: Number(env.STALL_TIMEOUT ?? 30),
    syncIntervalSec: Number(env.SYNC_INTERVAL ?? 30),
    lockTokenToIp: (env.LOCK_TOKEN_TO_IP ?? 'true') === 'true',
    xAccelPrefix: env.X_ACCEL_PREFIX ?? '',
  };
}
