import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ContentType } from './types.js';

/**
 * Token que el panel entrega al cliente al redirigirle a un nodo.
 * Va firmado con HMAC-SHA256 con un secreto compartido entre panel y nodos,
 * así el nodo puede validar la petición sin consultar la base de datos.
 */
export interface StreamTokenPayload {
  /** id de la línea */
  l: number;
  /** tipo de contenido */
  t: ContentType;
  /** id del stream, película o episodio */
  s: number;
  /** IP del cliente al pedirlo (para no compartir el enlace) */
  ip: string;
  /** máximo de conexiones de la línea */
  m: number;
  /** id de sesión (dispositivo) para el control de conexiones */
  k: string;
  /** caducidad (epoch en segundos) */
  e: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function signToken(payload: StreamTokenPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: StreamTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'ip_mismatch' };

export function verifyToken(
  token: string,
  secret: string,
  opts: { ip?: string; checkIp?: boolean; now?: number } = {},
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, sig] = parts;
  const expected = createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload: StreamTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.e < now) return { ok: false, reason: 'expired' };
  if (opts.checkIp && opts.ip && payload.ip !== opts.ip) return { ok: false, reason: 'ip_mismatch' };
  return { ok: true, payload };
}
