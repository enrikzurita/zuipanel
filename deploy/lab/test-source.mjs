// Fuente de canales de prueba: cada petición recibe un MPEG-TS en directo
// generado por FFmpeg. Cualquier otra ruta devuelve 404 (sirve para probar
// la conmutación a la fuente de respaldo).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const CHANNELS = {
  '/canal1.ts': { video: 'testsrc2=size=1280x720:rate=25', freq: 440 },
  '/canal2.ts': { video: 'smptehdbars=size=1920x1080:rate=25', freq: 880 },
  '/canal3.ts': { video: 'testsrc=size=1280x720:rate=25', freq: 660 },
};

createServer((req, res) => {
  const ch = CHANNELS[req.url];
  if (!ch) {
    res.writeHead(404).end('no existe');
    return;
  }
  console.log(`[testsrc] ${req.url} solicitado por ${req.socket.remoteAddress}`);
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', ch.video,
    '-f', 'lavfi', '-i', `sine=frequency=${ch.freq}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '50', '-b:v', '2500k',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts', 'pipe:1',
  ]);
  ff.stdout.pipe(res);
  ff.stderr.on('data', (d) => process.stderr.write(d));
  const stop = () => ff.kill('SIGKILL');
  req.on('close', stop);
  res.on('close', stop);
}).listen(9000, '0.0.0.0', () => console.log('[testsrc] escuchando en :9000'));
