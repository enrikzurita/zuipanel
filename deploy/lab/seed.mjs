// Crea los datos de ejemplo del laboratorio usando la API de administración.
// Es idempotente: si la línea de prueba ya existe, no hace nada.
const { PANEL_URL, ADMIN_TOKEN, NODE_PUBLIC_URL, SRC_URL, LAB_USER, LAB_PASS } = process.env;

async function api(method, path, body) {
  const res = await fetch(`${PANEL_URL}/admin/api${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const existing = await api('GET', `/lines?search=${encodeURIComponent(LAB_USER)}`);
if (existing.items.some((l) => l.username === LAB_USER)) {
  console.log('Datos de ejemplo ya creados; no hago nada.');
  process.exit(0);
}

const server = await api('POST', '/servers', { name: 'lab-nodo-1', public_url: NODE_PUBLIC_URL, is_main: true });
if (server.id !== 1) console.warn(`Aviso: el nodo tiene id ${server.id}, el agente usa SERVER_ID=1`);

const cat = async (type, name, sort) => (await api('POST', '/categories', { type, name, sort })).id;
const catLive = await cat('live', 'Pruebas · Directo', 1);
const catGeneral = await cat('live', 'Pruebas · Siempre activos', 2);
const catMovies = await cat('movie', 'Pruebas · Películas', 1);
const catSeries = await cat('series', 'Pruebas · Series', 1);

const p480 = await api('POST', '/transcode_profiles', {
  name: '480p CPU',
  options: { videoCodec: 'libx264', preset: 'veryfast', height: 480, videoBitrate: '1200k', audioCodec: 'aac', audioBitrate: '96k' },
});

const stream = (name, category_id, sources, extra = {}) =>
  api('POST', '/streams', { name, category_id, sources, icon: '', epg_channel_id: '', on_demand: true, ...extra });

const streams = [
  await stream('01 · Remux (bajo demanda)', catLive, [`${SRC_URL}/canal1.ts`]),
  await stream('02 · Transcodificado 480p', catLive, [`${SRC_URL}/canal2.ts`], { transcode_profile_id: p480.id }),
  await stream('03 · Fuente caída → respaldo', catLive, [`${SRC_URL}/no-existe.ts`, `${SRC_URL}/canal3.ts`]),
  await stream('04 · Siempre activo', catGeneral, [`${SRC_URL}/canal1.ts`], { on_demand: false }),
];
for (const s of streams) await api('PUT', `/streams/${s.id}/servers`, { ids: [server.id] });

const m1 = await api('POST', '/movies', {
  name: 'Película de prueba', category_id: catMovies, source_path: '/media/peliculas/pelicula-prueba.mp4',
  container_extension: 'mp4', rating: 7.5,
  info: { plot: 'Carta de ajuste en movimiento durante 90 segundos.', genre: 'Pruebas', duration_secs: 90, releasedate: '2026-10-15' },
});
const m2 = await api('POST', '/movies', {
  name: 'Película de prueba 2 (MKV)', category_id: catMovies, source_path: '/media/peliculas/pelicula-prueba-2.mkv',
  container_extension: 'mkv', rating: 6.0, info: { plot: 'Barras de color.', genre: 'Pruebas', duration_secs: 90 },
});
for (const m of [m1, m2]) await api('PUT', `/movies/${m.id}/servers`, { ids: [server.id] });

const serie = await api('POST', '/series', {
  name: 'Serie de prueba', category_id: catSeries, rating: 8.0,
  info: { plot: 'Una serie de cartas de ajuste.', genre: 'Pruebas', releaseDate: '2026-10-15' },
});
await api('PUT', `/series/${serie.id}/servers`, { ids: [server.id] });
const eps = [
  [1, 1, 'El comienzo', 's01e01.mp4'],
  [1, 2, 'La continuación', 's01e02.mp4'],
  [2, 1, 'Nueva temporada', 's02e01.mp4'],
];
for (const [season, episode_num, title, file] of eps) {
  await api('POST', '/episodes', {
    series_id: serie.id, season, episode_num, title,
    source_path: `/media/series/prueba/${file}`, container_extension: 'mp4', info: { duration_secs: 90 },
  });
}

const bouquet = await api('POST', '/bouquets', { name: 'Laboratorio completo' });
await api('PUT', `/bouquets/${bouquet.id}/items`, {
  items: [
    ...streams.map((s) => ({ type: 'live', id: s.id })),
    { type: 'movie', id: m1.id }, { type: 'movie', id: m2.id },
    { type: 'series', id: serie.id },
  ],
});

const line = await api('POST', '/lines', { username: LAB_USER, password: LAB_PASS, max_connections: 2, notes: 'Línea del laboratorio' });
await api('PUT', `/lines/${line.id}/bouquets`, { ids: [bouquet.id] });

console.log('Datos de ejemplo creados: 4 canales, 2 películas, 1 serie y la línea de prueba.');
