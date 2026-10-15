import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';

/**
 * Métricas del sistema calculadas por diferencia entre dos lecturas
 * (CPU y red). La primera llamada devuelve 0 en lo que necesita historia.
 */
export class SystemMetrics {
  private lastCpu = this.cpuTimes();
  private lastNet: { rx: number; tx: number; t: number } | null = null;

  private cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const c of cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  }

  cpuPercent(): number {
    const now = this.cpuTimes();
    const dIdle = now.idle - this.lastCpu.idle;
    const dTotal = now.total - this.lastCpu.total;
    this.lastCpu = now;
    if (dTotal <= 0) return 0;
    return Math.round((1 - dIdle / dTotal) * 1000) / 10;
  }

  async memPercent(): Promise<{ percent: number; totalMb: number }> {
    const total = totalmem();
    let available = freemem();
    try {
      // MemAvailable descuenta la caché de disco, que el sistema libera cuando hace falta
      const m = /MemAvailable:\s+(\d+) kB/.exec(await readFile('/proc/meminfo', 'utf8'));
      if (m) available = Number(m[1]) * 1024;
    } catch {
      // no es Linux: usamos freemem
    }
    return { percent: Math.round((1 - available / total) * 1000) / 10, totalMb: Math.round(total / 1048576) };
  }

  /** Tráfico de red en Mbps (todas las interfaces salvo loopback). */
  async netMbps(): Promise<{ inMbps: number; outMbps: number }> {
    let rx = 0;
    let tx = 0;
    try {
      // En Docker, /proc/net/dev solo ve la red del contenedor. Con pid: host y
      // NET_STATS_PATH=/proc/1/net/dev se lee la del servidor completo.
      const path = process.env.NET_STATS_PATH ?? '/proc/net/dev';
      const lines = (await readFile(path, 'utf8')).split('\n').slice(2);
      for (const l of lines) {
        const [name, rest] = l.split(':');
        const iface = name.trim();
        // Ignora loopback y las interfaces virtuales de Docker para no contar doble
        if (!rest || iface === 'lo' || iface.startsWith('veth') || iface.startsWith('docker') || iface.startsWith('br-')) continue;
        const f = rest.trim().split(/\s+/).map(Number);
        rx += f[0];
        tx += f[8];
      }
    } catch {
      return { inMbps: 0, outMbps: 0 };
    }
    const t = Date.now();
    const prev = this.lastNet;
    this.lastNet = { rx, tx, t };
    if (!prev || t <= prev.t) return { inMbps: 0, outMbps: 0 };
    const sec = (t - prev.t) / 1000;
    const mbps = (bytes: number) => Math.max(0, Math.round(((bytes * 8) / sec / 1e6) * 10) / 10);
    return { inMbps: mbps(rx - prev.rx), outMbps: mbps(tx - prev.tx) };
  }
}
