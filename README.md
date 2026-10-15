# ZuiPanel

Panel IPTV propio, alternativa a XUI.one, **compatible con la API Xtream Codes**: TiviMate, IPTV Smarters, OTT Navigator, VLC, etc. funcionan sin cambios con la misma URL, usuario y contraseña.

## Arquitectura

```
                 ┌───────────────── Servidor principal ─────────────────┐
 Cliente ──1──▶  │ nginx ─▶ Panel (Node/Fastify) ─▶ MariaDB              │
   │             │                 │                                     │
   │             │                 └──────────▶ Redis (conexiones) ◀─────┼──┐
   │             └────────────────────────────────────────────────────────┘  │
   │  2. 302 a un nodo con token firmado                                     │
   ▼                                                                         │
 ┌──────────────── Nodo de streaming (1..N) ───────────────┐                │
 │ nginx ─▶ Agente (Node) ─▶ FFmpeg por canal ─▶ HLS en RAM │────────────────┘
 │   └── ficheros VOD (rclone) vía X-Accel-Redirect         │
 └──────────────────────────────────────────────────────────┘
```

1. El cliente pide `/live/usuario/contraseña/123.ts` al **panel**. El panel comprueba la línea (activa, no caducada, IP permitida, canal en sus paquetes, formato permitido), reserva la conexión en Redis y elige el **nodo** sano con menos clientes.
2. Le redirige al nodo con un **token HMAC** (línea, canal, IP, caducidad). El nodo lo valida sin tocar la base de datos.
3. El **agente** del nodo arranca FFmpeg si el canal es bajo demanda, sirve HLS (`.m3u8`) o `.ts` continuo, y refresca la sesión en Redis mientras el cliente ve.

**Control de conexiones:** una conexión = un dispositivo (IP + user-agent). Cambiar de canal no consume otra. Una sesión que deja de pedir datos se libera a los 30 s.

## Qué incluye (fase 1)

| Área | Estado |
|---|---|
| `player_api.php`: login, categorías, directos, VOD, series, `get_vod_info`, `get_series_info`, `get_short_epg`, `get_simple_data_table` | ✅ |
| `get.php` (m3u / m3u_plus, salida ts/m3u8) y `xmltv.php` | ✅ |
| URLs `/live`, `/movie`, `/series` y formato antiguo `/usuario/contraseña/id` | ✅ |
| Límite de conexiones, caducidad, IPs permitidas, formatos permitidos, expulsar sesiones | ✅ |
| Multiservidor con balanceo por carga y descarte de nodos caídos | ✅ |
| Agente: remux, transcodificación CPU (x264/x265) y GPU (NVENC), bajo demanda, rotación de fuentes, reinicio automático, detección de cuelgues | ✅ |
| VOD con soporte de Range (avanzar/retroceder), servido por nginx | ✅ |
| API REST de administración | ✅ |
| Panel web de gestión en `/admin/`: resumen con muro de canales, líneas, paquetes, canales, VOD, categorías, nodos, perfiles y conexiones | ✅ |
| Importador de EPG (XMLTV) y metadatos TMDB | ⏳ fase 3 |
| Revendedores, créditos | ⏳ fase 4 |
| Migración desde la base de datos de XUI | ⏳ fase 5 |

## Emitir tus partidos

**En directo desde la cámara u OBS.** Crea un canal con entrada "Emisión propia" y asígnalo a un servidor. En su ficha verás la dirección RTMP y la clave:

- OBS: Ajustes, Emisión, Servicio "Personalizado", y pega Servidor (`rtmp://SERVIDOR:1935/live`) y Clave.
- Apps de cámara que piden una sola dirección: usa la URL completa (`rtmp://SERVIDOR:1935/live/CLAVE`).

El canal se enciende solo al empezar a emitir y se apaga al parar. Con "Grabar cada emisión", al terminar aparece en Películas, en la categoría elegida y en los mismos paquetes que el canal. Las grabaciones de menos de 30 s se descartan.

**Vídeos ya grabados.** En Películas, "Subir vídeo"; en una serie, "Subir episodio". El fichero va directamente al servidor elegido, con barra de progreso, y queda publicado con su duración.

Cómo funciona: cada nodo tiene un contenedor `ingest` (nginx con el módulo RTMP). Al publicar, nginx pregunta al agente si la clave es válida. El agente detecta la señal, arranca el canal y graba copiando el vídeo sin recodificar (MP4 fragmentado mientras graba, MP4 normal al terminar).

## Estructura

```
packages/shared   tokens firmados, control de conexiones (Redis), tipos
apps/panel        API Xtream + API de administración + API interna para nodos
apps/agent        agente de nodo: FFmpeg, HLS, .ts continuo, VOD
db/migrations     esquema SQL (MariaDB)
deploy/           docker-compose del principal y de los nodos, nginx
```

## Puesta en marcha

### Servidor principal

```bash
git clone https://github.com/enrikzurita/zuipanel.git && cd zuipanel/deploy/main
cp main.env.example .env      # rellena los secretos: openssl rand -hex 32
docker compose up -d --build
```

Las migraciones se aplican solas al arrancar el panel. Abre el puerto 6379 de Redis en UFW **solo** para las IPs de tus nodos:

```bash
ufw allow from IP_DEL_NODO to any port 6379 proto tcp
```

### Nodos de streaming

1. Da de alta el nodo en el panel y apunta su `id`:
   ```bash
   curl -X POST http://panel/admin/api/servers -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" -d '{"name":"vps1","public_url":"http://vps1.tudominio.com:8081"}'
   ```
2. En el VPS:
   ```bash
   cd zuipanel/deploy/node && cp node.env.example .env   # SERVER_ID, secretos, REDIS_URL, MEDIA_DIR
   docker compose up -d --build
   ```
3. Para NVENC instala `nvidia-container-toolkit` y descomenta el bloque de GPU en `deploy/node/docker-compose.yml`.

## Panel web de gestión

Abre `http://tu-panel/admin/` y entra con el `ADMIN_TOKEN`. Desde ahí se gestiona todo lo que hace la API. En desarrollo:

```bash
npm run dev:panel              # panel en :8080
PANEL_URL=http://127.0.0.1:8080 npm run dev:web   # web con recarga en caliente
```

## API de administración (resumen)

Todas con `Authorization: Bearer $ADMIN_TOKEN`, bajo `/admin/api`.

| Método | Ruta | Uso |
|---|---|---|
| GET/POST | `/{recurso}` | listar (`?search=&limit=&offset=`) / crear |
| GET/PATCH/DELETE | `/{recurso}/{id}` | ver / editar / borrar |
| PUT | `/streams/{id}/servers` `/movies/{id}/servers` `/series/{id}/servers` | `{"ids":[1,2]}` en qué nodos está |
| PUT | `/lines/{id}/bouquets` | `{"ids":[1,3]}` paquetes de la línea (en orden) |
| PUT | `/bouquets/{id}/items` | `{"items":[{"type":"live","id":5}]}` contenido del paquete (en orden) |
| GET | `/connections` · DELETE `/connections/{lineId}[/{sid}]` | sesiones activas / expulsar |
| GET | `/stats` | totales y estado de los nodos |

Recursos: `lines`, `categories`, `bouquets`, `servers`, `transcode_profiles`, `streams`, `movies`, `series`, `episodes`.

Ejemplo de canal con perfil de transcodificación por GPU:

```bash
curl -X POST .../admin/api/transcode_profiles -d '{"name":"720p GPU","options":{"videoCodec":"h264_nvenc","height":720,"videoBitrate":"3000k","audioCodec":"aac"}}'
curl -X POST .../admin/api/streams -d '{"name":"Canal 1","category_id":1,"sources":["http://origen/a.ts","http://respaldo/a.ts"],"transcode_profile_id":1,"on_demand":true}'
curl -X PUT  .../admin/api/streams/1/servers -d '{"ids":[1]}'
```

Opciones de perfil: `videoCodec` (`copy`, `libx264`, `libx265`, `h264_nvenc`, `hevc_nvenc`), `preset`, `videoBitrate`, `height`, `fps`, `audioCodec` (`copy`, `aac`), `audioBitrate`, `hlsTime`, `extraArgs`. Sin perfil = remux (no recodifica, casi sin CPU).

## Desarrollo

```bash
npm install
npm run build
# Tests (necesitan MariaDB, Redis y ffmpeg locales)
TEST_DATABASE_URL=mysql://usuario:clave@127.0.0.1:3306/zuipanel_test npm test
```

Los tests del panel usan MariaDB y Redis reales; los del agente lanzan FFmpeg de verdad con una fuente en directo generada al vuelo. GitHub Actions los ejecuta en cada push.

## Variables de entorno

**Panel:** `DATABASE_URL`, `REDIS_URL`, `STREAM_SECRET`, `ADMIN_TOKEN`, `AGENT_KEY`, `PUBLIC_URL`, `TZ_NAME`, `TOKEN_TTL` (s, por defecto 6 h), `LOCK_TOKEN_TO_IP` (`true`), `SERVER_TIMEOUT` (s sin heartbeat para dar un nodo por caído, 90), `AUTO_MIGRATE` (`true`).

**Agente:** `SERVER_ID`, `PANEL_URL`, `AGENT_KEY`, `STREAM_SECRET`, `REDIS_URL`, `HLS_DIR`, `FFMPEG_PATH`, `IDLE_TIMEOUT` (60), `STALL_TIMEOUT` (30), `SYNC_INTERVAL` (30), `LOCK_TOKEN_TO_IP`, `X_ACCEL_PREFIX`.

## Notas

- `LOCK_TOKEN_TO_IP=true` ata el enlace del nodo a la IP del cliente. Si algún cliente llega al panel por IPv6 y al nodo por IPv4, ponlo a `false` en ambos.
- Dos dispositivos con la misma app detrás de la misma IP cuentan como una sola conexión.
- Con `X_ACCEL_PREFIX` nginx sirve el VOD y el agente no ve el progreso de la descarga; los reproductores piden rangos a menudo, lo que mantiene viva la sesión.
