#!/usr/bin/env bash
# Actualiza el laboratorio a la última versión del repo sin perder datos.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
git pull --ff-only
sudo docker compose build
sudo docker compose run --rm media-init
sudo docker compose up -d
# Añade los datos de ejemplo nuevos (no toca lo que ya existe)
sudo docker compose run --rm seed
. ./.env
echo
echo "Actualizado."
echo "  Panel de gestión:   http://${LAB_IP}:${PANEL_PORT:-8080}/admin/"
echo "  Emisión desde OBS:  rtmp://${LAB_IP}:${RTMP_PORT:-1935}/live  (la clave está en Canales > Emisión propia)"
