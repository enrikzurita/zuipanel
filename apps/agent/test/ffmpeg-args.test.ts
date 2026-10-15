import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFfmpegArgs, parseStreamInfo } from '../src/ffmpeg-args.js';
import { parsePlaylist, rewritePlaylist } from '../src/hls.js';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('buildFfmpegArgs', () => {
  it('remux por defecto: copia vídeo y audio', () => {
    const a = buildFfmpegArgs({ source: 'http://origen/x.ts', outDir: '/hls/1', transcode: null });
    assert.equal(after(a, '-c:v'), 'copy');
    assert.equal(after(a, '-c:a'), 'copy');
    assert.ok(!a.includes('-hwaccel'));
    assert.equal(after(a, '-reconnect'), '1');
    assert.equal(a.at(-1), '/hls/1/index.m3u8');
    assert.equal(after(a, '-hls_segment_filename'), '/hls/1/seg_%06d.ts');
  });

  it('transcodifica por CPU con escalado y bitrate', () => {
    const a = buildFfmpegArgs({
      source: 'rtmp://origen/live',
      outDir: '/hls/2',
      transcode: { videoCodec: 'libx264', height: 720, videoBitrate: '3000k', audioCodec: 'aac' },
    });
    assert.equal(after(a, '-c:v'), 'libx264');
    assert.equal(after(a, '-preset'), 'veryfast');
    assert.equal(after(a, '-vf'), 'scale=-2:720');
    assert.equal(after(a, '-bufsize'), '6000k');
    assert.equal(after(a, '-c:a'), 'aac');
    assert.ok(a.includes('-rw_timeout'));
    assert.ok(!a.includes('-reconnect'));
  });

  it('usa la GPU NVIDIA de principio a fin con NVENC', () => {
    const a = buildFfmpegArgs({ source: 'http://o/x', outDir: '/h', transcode: { videoCodec: 'h264_nvenc', height: 1080 } });
    assert.equal(after(a, '-hwaccel'), 'cuda');
    assert.ok(a.indexOf('-hwaccel') < a.indexOf('-i'));
    assert.equal(after(a, '-preset'), 'p4');
    assert.equal(after(a, '-vf'), 'scale_cuda=-2:1080');
  });

  it('usa el user-agent del canal', () => {
    const a = buildFfmpegArgs({ source: 'https://o/x', outDir: '/h', transcode: null, userAgent: 'VLC/3.0' });
    assert.equal(after(a, '-user_agent'), 'VLC/3.0');
  });
});

describe('HLS', () => {
  const pl = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:12
#EXTINF:4.000000,
seg_000012.ts
#EXTINF:4.000000,
seg_000013.ts
`;
  it('lee la playlist con números de secuencia', () => {
    const p = parsePlaylist(pl);
    assert.deepEqual(p.segments.map((s) => s.seq), [12, 13]);
    assert.equal(p.segments[1].uri, 'seg_000013.ts');
  });
  it('reescribe las URIs de segmentos', () => {
    const out = rewritePlaylist(pl, (s) => `/hls/TOKEN/5/${s}`);
    assert.match(out, /^\/hls\/TOKEN\/5\/seg_000012\.ts$/m);
    assert.match(out, /#EXT-X-MEDIA-SEQUENCE:12/);
  });
  it('extrae códec y resolución del log de FFmpeg', () => {
    const info = parseStreamInfo(
      '  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p, 1920x1080, 25 fps\n  Stream #0:1[0x101]: Audio: aac (LC), 48000 Hz',
    );
    assert.deepEqual(info, { video: 'h264 1920x1080', audio: 'aac' });
  });
});
