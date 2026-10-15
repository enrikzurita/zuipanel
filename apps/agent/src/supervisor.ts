import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentStreamConfig, AgentStreamStatus } from '@zuipanel/shared';
import { buildFfmpegArgs, parseStreamInfo, PLAYLIST_NAME } from './ffmpeg-args.js';
import { parsePlaylist } from './hls.js';

export interface SupervisorOptions {
  hlsDir: string;
  ffmpegPath: string;
  /** Segundos sin espectadores antes de parar un canal bajo demanda */
  idleTimeoutSec: number;
  /** Segundos sin nuevos segmentos antes de considerar un proceso colgado */
  stallTimeoutSec: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const configKey = (c: AgentStreamConfig) => JSON.stringify([c.sources, c.transcode, c.userAgent]);

/** Un canal: un proceso FFmpeg con reinicio automático y rotación de fuentes. */
export class StreamProcess {
  readonly dir: string;
  private proc: ChildProcess | null = null;
  private desired = false;
  private startedAt = 0;
  private stderrTail = '';
  private restartTimer: NodeJS.Timeout | null = null;
  private quickFailures = 0;
  sourceIndex = 0;
  restarts = 0;
  lastError: string | null = null;
  lastAccess = Date.now();
  info: { video?: string; audio?: string } = {};

  constructor(public cfg: AgentStreamConfig, private opts: SupervisorOptions) {
    this.dir = join(opts.hlsDir, String(cfg.id));
  }

  get running() {
    return this.proc !== null;
  }

  get wanted() {
    return this.desired;
  }

  get playlistPath() {
    return join(this.dir, PLAYLIST_NAME);
  }

  touch() {
    this.lastAccess = Date.now();
  }

  async start() {
    if (this.desired && this.proc) return;
    this.desired = true;
    this.quickFailures = 0;
    await this.spawn();
  }

  private async spawn() {
    if (!this.desired) return;
    if (!this.cfg.sources.length) {
      this.lastError = 'El canal no tiene fuentes';
      return;
    }
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    const source = this.cfg.sources[this.sourceIndex % this.cfg.sources.length];
    const args = buildFfmpegArgs({ source, outDir: this.dir, transcode: this.cfg.transcode, userAgent: this.cfg.userAgent });
    this.opts.log?.(`[${this.cfg.id}] iniciando FFmpeg (fuente ${this.sourceIndex % this.cfg.sources.length + 1}/${this.cfg.sources.length})`);
    const proc = spawn(this.opts.ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.proc = proc;
    this.startedAt = Date.now();
    this.stderrTail = '';
    proc.stderr!.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
      if (!this.info.video) this.info = { ...this.info, ...parseStreamInfo(this.stderrTail) };
    });
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal));
    proc.on('error', (err) => {
      this.lastError = err.message;
    });
  }

  private onExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
    if (this.proc !== proc) return;
    this.proc = null;
    if (!this.desired) return;
    const ranMs = Date.now() - this.startedAt;
    const lastLine = this.stderrTail.trim().split('\n').filter(Boolean).pop() ?? '';
    this.lastError = `FFmpeg salió (code=${code}, signal=${signal}) ${lastLine}`.trim();
    this.opts.log?.(`[${this.cfg.id}] ${this.lastError}`);
    this.restarts++;
    if (ranMs < 15_000) {
      // Falló enseguida: probamos la siguiente fuente
      this.quickFailures++;
      this.sourceIndex = (this.sourceIndex + 1) % Math.max(1, this.cfg.sources.length);
    } else {
      this.quickFailures = 0;
    }
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.quickFailures, 5));
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  async stop() {
    this.desired = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const proc = this.proc;
    if (proc) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        proc.kill('SIGTERM');
      });
      this.proc = null;
    }
    await rm(this.dir, { recursive: true, force: true });
  }

  /** Reinicia si cambió la configuración (fuentes, perfil o user-agent). */
  async update(cfg: AgentStreamConfig) {
    const changed = configKey(cfg) !== configKey(this.cfg);
    this.cfg = cfg;
    if (changed && this.desired) {
      this.opts.log?.(`[${cfg.id}] configuración cambiada, reiniciando`);
      this.sourceIndex = 0;
      await this.stop();
      await this.start();
    }
  }

  /** Mata el proceso si lleva un rato sin generar segmentos (fuente colgada). */
  async checkStall() {
    if (!this.proc || Date.now() - this.startedAt < this.opts.stallTimeoutSec * 1000) return;
    try {
      const st = await stat(this.playlistPath);
      if (Date.now() - st.mtimeMs < this.opts.stallTimeoutSec * 1000) return;
    } catch {
      // aún no hay playlist
    }
    this.opts.log?.(`[${this.cfg.id}] sin segmentos nuevos en ${this.opts.stallTimeoutSec}s, reiniciando`);
    this.proc.kill('SIGKILL');
  }

  /** Espera a que exista la playlist con al menos un segmento. */
  async waitReady(timeoutMs = 20_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const pl = parsePlaylist(await readFile(this.playlistPath, 'utf8'));
        if (pl.segments.length >= 1) return true;
      } catch {
        // todavía no existe
      }
      if (!this.desired) return false;
      await sleep(300);
    }
    return false;
  }

  status(): AgentStreamStatus {
    return {
      id: this.cfg.id,
      running: this.running,
      sourceIndex: this.sourceIndex,
      uptimeSec: this.running ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      lastError: this.lastError,
      ...this.info,
    };
  }
}

/** Gestiona todos los canales de este nodo según la configuración del panel. */
export class Supervisor {
  readonly streams = new Map<number, StreamProcess>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: SupervisorOptions) {}

  async reconcile(configs: AgentStreamConfig[]) {
    const ids = new Set(configs.map((c) => c.id));
    for (const [id, sp] of this.streams) {
      if (!ids.has(id)) {
        await sp.stop();
        this.streams.delete(id);
      }
    }
    for (const cfg of configs) {
      let sp = this.streams.get(cfg.id);
      if (!sp) {
        sp = new StreamProcess(cfg, this.opts);
        this.streams.set(cfg.id, sp);
      } else {
        await sp.update(cfg);
      }
      if (!cfg.onDemand && !sp.wanted) await sp.start();
    }
  }

  /** Arranca el canal si es bajo demanda y espera a que tenga segmentos. */
  async ensure(id: number): Promise<StreamProcess | null> {
    const sp = this.streams.get(id);
    if (!sp) return null;
    sp.touch();
    if (!sp.wanted) await sp.start();
    return (await sp.waitReady()) ? sp : null;
  }

  startTimers() {
    this.timer = setInterval(async () => {
      for (const sp of this.streams.values()) {
        await sp.checkStall();
        if (sp.cfg.onDemand && sp.wanted && Date.now() - sp.lastAccess > this.opts.idleTimeoutSec * 1000) {
          this.opts.log?.(`[${sp.cfg.id}] sin espectadores, parando (bajo demanda)`);
          await sp.stop();
        }
      }
    }, 5000);
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.streams.values()].map((s) => s.stop()));
  }
}
