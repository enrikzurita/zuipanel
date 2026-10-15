#!/bin/sh
# Genera vídeos de prueba para VOD si no existen todavía.
set -e
mkdir -p /media/peliculas /media/series/prueba
gen() {
  out="$1"; pattern="$2"; freq="$3"
  [ -f "$out" ] && return 0
  echo "Generando $out"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "$pattern" -f lavfi -i "sine=frequency=$freq" -t 90 \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 128k \
    -movflags +faststart "$out"
}
gen /media/peliculas/pelicula-prueba.mp4 "testsrc2=size=1280x720:rate=25" 500
gen /media/peliculas/pelicula-prueba-2.mkv "smptehdbars=size=1280x720:rate=25" 700
gen /media/series/prueba/s01e01.mp4 "testsrc=size=1280x720:rate=25" 300
gen /media/series/prueba/s01e02.mp4 "rgbtestsrc=size=1280x720:rate=25" 350
gen /media/series/prueba/s02e01.mp4 "testsrc2=size=1280x720:rate=25" 400
chmod -R a+rX /media
# El agente (usuario node, uid 1000) guarda aquí las grabaciones y las subidas
mkdir -p /media/grabaciones /media/subidas
chown -R 1000:1000 /media/grabaciones /media/subidas
echo "Vídeos de prueba listos."
