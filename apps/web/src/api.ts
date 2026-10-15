const BASE = '/admin/api';
const TOKEN_KEY = 'zuipanel.token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(t: string) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // almacenamiento no disponible: el token vive solo en esta pestaña
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T = unknown>(method: string, path: string, body?: unknown, token = getToken()): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'La sesión ha caducado. Vuelve a entrar con tu token.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Error ${res.status}`);
  return data as T;
}

export interface ListResult<T> {
  total: number;
  items: T[];
}

/** Descarga todos los registros de un recurso (para selectores). */
export async function listAll<T>(resource: string, query = ''): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await api<ListResult<T>>('GET', `/${resource}?limit=1000&offset=${offset}${query ? '&' + query : ''}`);
    out.push(...r.items);
    if (out.length >= r.total || r.items.length === 0) return out;
  }
}

// ---- Tipos de los recursos ----
export interface Line {
  id: number;
  username: string;
  password: string;
  max_connections: number;
  exp_date: string | null;
  enabled: number;
  is_trial: number;
  allowed_outputs: string[] | null;
  allowed_ips: string[] | null;
  notes: string | null;
  created_at: string;
}
export interface Category { id: number; type: 'live' | 'movie' | 'series'; name: string; parent_id: number; sort: number }
export interface Bouquet { id: number; name: string; sort: number }
export interface Server {
  id: number;
  name: string;
  public_url: string;
  is_main: number;
  enabled: number;
  max_clients: number;
  last_heartbeat: string | null;
  status: { load?: number[]; clients?: number; streams?: StreamStatus[] } | null;
}
export interface StreamStatus {
  id: number;
  running: boolean;
  sourceIndex: number;
  uptimeSec: number;
  restarts: number;
  lastError: string | null;
  video?: string;
  audio?: string;
}
export interface TranscodeProfile { id: number; name: string; options: Record<string, unknown> }
export interface Stream {
  id: number;
  name: string;
  category_id: number | null;
  sources: string[];
  icon: string;
  epg_channel_id: string;
  on_demand: number;
  transcode_profile_id: number | null;
  user_agent: string | null;
  enabled: number;
  sort: number;
}
export interface Movie {
  id: number;
  name: string;
  category_id: number | null;
  source_path: string;
  container_extension: string;
  icon: string;
  rating: string;
  info: Record<string, unknown> | null;
  enabled: number;
}
export interface Series {
  id: number;
  name: string;
  category_id: number | null;
  cover: string;
  rating: string;
  info: Record<string, unknown> | null;
  enabled: number;
}
export interface Episode {
  id: number;
  series_id: number;
  season: number;
  episode_num: number;
  title: string;
  source_path: string;
  container_extension: string;
}
export interface Session {
  sid: string;
  lineId: string;
  username: string;
  type: string;
  itemId: string;
  ip: string;
  userAgent: string;
  serverId: string;
  startedAt: string;
  lastSeen: string;
}
export interface Stats {
  lines_total: number;
  lines_active: number;
  streams: number;
  movies: number;
  series: number;
  episodes: number;
  connections: number;
  servers: Array<Server & { online: boolean }>;
}
