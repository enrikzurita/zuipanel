import { spawn } from 'node:child_process';

function run(cmd: string, args: string[], timeoutMs = 600_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: e.message });
    });
  });
}

/** Duración en segundos de un fichero de vídeo (0 si no se puede leer). */
export async function probeDuration(path: string, ffprobe = 'ffprobe'): Promise<number> {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], 60_000);
  const d = parseFloat(r.out.trim());
  return Number.isFinite(d) ? Math.round(d) : 0;
}

/**
 * Reempaqueta un MP4 fragmentado (el que se escribe mientras se graba) en un
 * MP4 normal con el índice al principio, para que se pueda avanzar y retroceder
 * en cualquier reproductor. No recodifica: tarda segundos.
 */
export async function remuxToFaststart(src: string, dst: string, ffmpeg = 'ffmpeg'): Promise<boolean> {
  const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-map', '0', '-c', 'copy', '-movflags', '+faststart', dst]);
  return r.code === 0;
}
