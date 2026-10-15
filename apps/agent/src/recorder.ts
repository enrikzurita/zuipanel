import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaFileReport } from '@zuipanel/shared';
import { probeDuration, remuxToFaststart } from './media.js';

export interface RecorderOptions {
  dir: string;
  ffmpegPath: string;
  /** Grabaciones más cortas se descartan (pruebas de conexión, cortes) */
  minSeconds: number;
  /** Se llama con el fichero final para que el panel lo registre como VOD */
  onFinished: (streamId: number, report: MediaFileReport) => Promise<void>;
  log?: (msg: string) => void;
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

interface Active {
  proc: ChildProcess;
  part: string;
  startedAt: number;
  done: Promise<void>;
}

/**
 * Graba la emisión de un canal push copiando el vídeo tal cual llega (sin
 * recodificar). Mientras graba usa MP4 fragmentado, que sobrevive a cortes;
 * al terminar lo convierte en un MP4 normal y avisa al panel.
 */
export class Recorder {
  private active = new Map<number, Active>();

  constructor(private opts: RecorderOptions) {}

  isRecording(streamId: number) {
    return this.active.has(streamId);
  }

  async start(streamId: number, source: string) {
    if (this.active.has(streamId)) return;
    const dir = join(this.opts.dir, String(streamId));
    await mkdir(dir, { recursive: true });
    const startedAt = Date.now();
    const part = join(dir, `${stamp(new Date(startedAt))}.part.mp4`);
    const proc = spawn(
      this.opts.ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-rw_timeout', '15000000',
        '-i', source,
        '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4', part,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    proc.stderr!.on('data', (d) => (err = (err + d).slice(-2000)));
    this.opts.log?.(`[${streamId}] grabando en ${part}`);
    const done = new Promise<void>((resolve) => {
      proc.on('exit', () => {
        this.active.delete(streamId);
        this.finish(streamId, part, startedAt, err)
          .catch((e) => this.opts.log?.(`[${streamId}] error al cerrar la grabación: ${(e as Error).message}`))
          .finally(resolve);
      });
    });
    this.active.set(streamId, { proc, part, startedAt, done });
  }

  /** Para la grabación de forma ordenada y espera a que quede registrada. */
  async stop(streamId: number) {
    const a = this.active.get(streamId);
    if (!a) return;
    a.proc.kill('SIGINT'); // FFmpeg cierra el fichero limpiamente con SIGINT
    const t = setTimeout(() => a.proc.kill('SIGKILL'), 10_000);
    await a.done;
    clearTimeout(t);
  }

  async stopAll() {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
  }

  private async finish(streamId: number, part: string, startedAt: number, err: string) {
    const endedAt = Date.now();
    let size = 0;
    try {
      size = (await stat(part)).size;
    } catch {
      this.opts.log?.(`[${streamId}] la grabación no generó fichero ${err ? `(${err.trim().split('\n').pop()})` : ''}`);
      return;
    }
    const partDuration = await probeDuration(part);
    if (size === 0 || partDuration < this.opts.minSeconds) {
      this.opts.log?.(`[${streamId}] grabación descartada (${partDuration} s, mínimo ${this.opts.minSeconds} s)`);
      await rm(part, { force: true });
      return;
    }
    const final = part.replace(/\.part\.mp4$/, '.mp4');
    let path = final;
    if (await remuxToFaststart(part, final)) {
      await rm(part, { force: true });
      size = (await stat(final)).size;
    } else {
      // Si el reempaquetado falla, se conserva el fragmentado, que también se puede reproducir
      path = part;
    }
    const durationSec = (await probeDuration(path)) || partDuration;
    this.opts.log?.(`[${streamId}] grabación terminada: ${path} (${durationSec} s)`);
    await this.opts.onFinished(streamId, { path, ext: 'mp4', sizeBytes: size, durationSec, startedAt, endedAt });
  }
}
