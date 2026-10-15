import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { verifyPayload, type MediaFileReport } from '@zuipanel/shared';
import { probeDuration } from './media.js';

/** Permiso de subida firmado por el panel. */
export interface UploadGrant {
  /** id de la subida (el panel guarda qué crear con ella) */
  u: string;
  /** extensión del fichero */
  x: string;
  /** caducidad (epoch s) */
  e: number;
}

export interface UploadOptions {
  secret: string;
  dir: string;
  complete: (uploadId: string, report: MediaFileReport) => Promise<unknown>;
  log?: (msg: string) => void;
}

const SAFE_EXT = /^[a-z0-9]{2,5}$/;

/**
 * Subida de vídeos directamente al nodo desde el navegador. El panel entrega
 * una URL con un permiso firmado; el fichero no pasa por el servidor principal.
 */
export function registerUploadRoutes(app: FastifyInstance, opts: UploadOptions) {
  app.register(async (r) => {
    // El cuerpo se recibe como flujo, sin cargarlo en memoria ni límite de tamaño
    r.removeAllContentTypeParsers();
    r.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    r.addHook('onRequest', async (_req, reply) => {
      // El navegador sube desde la web del panel (otro origen): el permiso va en la URL
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'PUT, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'content-type');
      reply.header('Access-Control-Max-Age', '600');
    });

    r.options('/upload/:token', async (_req, reply) => reply.code(204).send());

    r.put('/upload/:token', async (req, reply) => {
      const grant = verifyPayload<UploadGrant>((req.params as { token: string }).token, opts.secret);
      if (!grant || !SAFE_EXT.test(grant.x) || !/^[a-zA-Z0-9_-]{6,64}$/.test(grant.u)) {
        return reply.code(403).send({ error: 'Permiso de subida no válido o caducado' });
      }
      await mkdir(opts.dir, { recursive: true });
      const final = join(opts.dir, `${grant.u}.${grant.x}`);
      const part = `${final}.part`;
      try {
        await access(final);
        return reply.code(409).send({ error: 'Esta subida ya se completó' });
      } catch {
        // no existe: seguimos
      }
      try {
        await pipeline(req.body as Readable, createWriteStream(part));
      } catch (e) {
        await rm(part, { force: true });
        return reply.code(400).send({ error: `La subida se interrumpió: ${(e as Error).message}` });
      }
      await rename(part, final);
      const { size } = await stat(final);
      if (size === 0) {
        await rm(final, { force: true });
        return reply.code(400).send({ error: 'El fichero está vacío' });
      }
      const durationSec = await probeDuration(final);
      opts.log?.(`subida ${grant.u} recibida: ${final} (${Math.round(size / 1048576)} MB, ${durationSec} s)`);
      try {
        const created = await opts.complete(grant.u, { path: final, ext: grant.x, sizeBytes: size, durationSec });
        return reply.code(201).send(created);
      } catch (e) {
        return reply.code(502).send({ error: `El vídeo se subió pero el panel no pudo registrarlo: ${(e as Error).message}` });
      }
    });
  });
}
