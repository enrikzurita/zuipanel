import { join } from 'node:path';
import type { TranscodeOptions } from '@zuipanel/shared';

export const DEFAULT_HLS_TIME = 4;
export const PLAYLIST_NAME = 'index.m3u8';
export const SEGMENT_PATTERN = /^seg_\d{6}\.ts$/;

const isNvenc = (codec?: string) => !!codec && codec.endsWith('_nvenc');

export interface BuildArgsInput {
  source: string;
  outDir: string;
  transcode: TranscodeOptions | null;
  userAgent?: string | null;
}

/**
 * Construye los argumentos de FFmpeg para un canal.
 * - transcode null o videoCodec "copy" => remux: no recodifica vídeo (casi sin CPU).
 * - libx264/libx265 => transcodifica por CPU.
 * - h264_nvenc/hevc_nvenc => decodifica y codifica en la GPU NVIDIA.
 * La salida es siempre HLS en outDir (index.m3u8 + seg_000001.ts…).
 */
export function buildFfmpegArgs({ source, outDir, transcode, userAgent }: BuildArgsInput): string[] {
  const t = transcode ?? {};
  const vcodec = t.videoCodec ?? 'copy';
  const acodec = t.audioCodec ?? 'copy';
  const hlsTime = t.hlsTime ?? DEFAULT_HLS_TIME;
  const nvenc = isNvenc(vcodec);
  const args: string[] = ['-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-y'];

  // ---- Entrada ----
  if (nvenc) args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  if (/^https?:\/\//i.test(source)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
    args.push('-user_agent', userAgent || 'ZuiPanel/1.0');
  } else if (/^rtmp/i.test(source)) {
    args.push('-rw_timeout', '15000000');
  }
  args.push('-fflags', '+genpts+discardcorrupt', '-analyzeduration', '5000000', '-probesize', '5000000');
  args.push('-i', source);

  // ---- Mapeo: primer vídeo y todas las pistas de audio, si existen ----
  args.push('-map', '0:v:0?', '-map', '0:a?', '-ignore_unknown', '-sn', '-dn');

  // ---- Vídeo ----
  if (vcodec === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', vcodec);
    if (t.preset) args.push('-preset', t.preset);
    else args.push('-preset', nvenc ? 'p4' : 'veryfast');
    if (t.videoBitrate) {
      const kbps = parseInt(t.videoBitrate, 10);
      const unit = t.videoBitrate.replace(/^\d+/, '') || 'k';
      args.push('-b:v', t.videoBitrate, '-maxrate', t.videoBitrate, '-bufsize', `${kbps * 2}${unit}`);
    }
    const filters: string[] = [];
    if (t.height) filters.push(nvenc ? `scale_cuda=-2:${t.height}` : `scale=-2:${t.height}`);
    if (filters.length) args.push('-vf', filters.join(','));
    if (t.fps) args.push('-r', String(t.fps));
    // Un keyframe al inicio de cada segmento: necesario para que HLS corte bien
    args.push('-force_key_frames', `expr:gte(t,n_forced*${hlsTime})`);
    if (!nvenc && vcodec === 'libx264') args.push('-pix_fmt', 'yuv420p');
  }

  // ---- Audio ----
  if (acodec === 'copy') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', t.audioBitrate ?? '128k', '-ac', '2');

  if (t.extraArgs?.length) args.push(...t.extraArgs);

  // ---- Salida HLS ----
  args.push(
    '-f', 'hls',
    '-hls_time', String(hlsTime),
    '-hls_list_size', '6',
    '-hls_delete_threshold', '6',
    '-hls_flags', 'delete_segments+temp_file+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', join(outDir, 'seg_%06d.ts'),
    join(outDir, PLAYLIST_NAME),
  );
  return args;
}

/** Saca códec/resolución del stderr de FFmpeg (líneas "Stream #0:0: Video: h264 …"). */
export function parseStreamInfo(stderr: string): { video?: string; audio?: string } {
  const out: { video?: string; audio?: string } = {};
  const v = /Stream #0:\d+.*?: Video: ([^,\s]+).*?(\d{2,5}x\d{2,5})/.exec(stderr);
  if (v) out.video = `${v[1]} ${v[2]}`;
  const a = /Stream #0:\d+.*?: Audio: ([^,\s]+)/.exec(stderr);
  if (a) out.audio = a[1];
  return out;
}
