import type { Recorder } from './recorder.js';
import type { Supervisor } from './supervisor.js';

/**
 * Lee la página de estadísticas de nginx-rtmp y devuelve las claves que
 * están publicando ahora mismo en la aplicación indicada.
 */
export function parseRtmpStat(xml: string, app = 'live'): Set<string> {
  const live = new Set<string>();
  const apps = xml.match(/<application>[\s\S]*?<\/application>/g) ?? [];
  for (const a of apps) {
    const name = /<name>([^<]*)<\/name>/.exec(a)?.[1];
    if (name !== app) continue;
    const streams = a.match(/<stream>[\s\S]*?<\/stream>/g) ?? [];
    for (const s of streams) {
      if (!/<publishing\s*\/>/.test(s)) continue;
      const key = /<name>([^<]*)<\/name>/.exec(s)?.[1];
      if (key) live.add(key);
    }
  }
  return live;
}

export interface IngestOptions {
  statUrl: string;
  rtmpBase: string;
  intervalMs?: number;
  log?: (msg: string) => void;
}

/**
 * Vigila qué canales push tienen señal y arranca o para su emisión y su
 * grabación en consecuencia. Así el canal "se enciende solo" cuando la cámara
 * u OBS empieza a emitir.
 */
export class IngestWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private supervisor: Supervisor,
    private recorder: Recorder,
    private opts: IngestOptions,
  ) {}

  sourceFor(key: string) {
    return `${this.opts.rtmpBase.replace(/\/$/, '')}/${key}`;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      let publishing: Set<string>;
      try {
        const res = await fetch(this.opts.statUrl, { signal: AbortSignal.timeout(3000) });
        publishing = parseRtmpStat(await res.text());
      } catch {
        return; // sin acceso a las estadísticas: no tocamos nada
      }
      for (const sp of this.supervisor.streams.values()) {
        if (sp.cfg.input !== 'push' || !sp.cfg.streamKey) continue;
        const live = publishing.has(sp.cfg.streamKey);
        if (live && !sp.signal) this.opts.log?.(`[${sp.cfg.id}] señal recibida`);
        if (!live && sp.signal) this.opts.log?.(`[${sp.cfg.id}] señal perdida`);
        sp.signal = live;
        if (live) {
          if (!sp.wanted) await sp.start();
          if (sp.cfg.record && !this.recorder.isRecording(sp.cfg.id)) {
            await this.recorder.start(sp.cfg.id, this.sourceFor(sp.cfg.streamKey));
          }
        } else {
          if (sp.wanted) await sp.stop();
          if (this.recorder.isRecording(sp.cfg.id)) void this.recorder.stop(sp.cfg.id);
        }
        sp.recording = this.recorder.isRecording(sp.cfg.id);
      }
    } finally {
      this.busy = false;
    }
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 3000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** ¿La clave pertenece a un canal push de este nodo? (para autorizar al publicador) */
  isValidKey(key: string): boolean {
    for (const sp of this.supervisor.streams.values()) {
      if (sp.cfg.input === 'push' && sp.cfg.streamKey && sp.cfg.streamKey === key) return true;
    }
    return false;
  }
}
