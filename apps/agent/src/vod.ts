import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/** Sirve un fichero con soporte de Range (necesario para avanzar/retroceder). */
export async function sendFileWithRange(
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  ext: string,
  onOpen?: () => () => void,
) {
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new Error('no es un fichero');
    size = st.size;
  } catch {
    return reply.code(404).send('File not found');
  }
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');

  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (!m) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    if (m[1] === '' && m[2] !== '') {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  reply.header('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return reply.send();

  const stream = createReadStream(path, { start, end });
  const done = onOpen?.();
  if (done) {
    stream.on('close', done);
    reply.raw.on('close', done);
  }
  return reply.send(stream);
}
