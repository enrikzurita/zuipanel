#!/usr/bin/env bash
# Actualiza el laboratorio a la última versión del repo sin perder datos.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
git pull --ff-only
sudo docker compose build
sudo docker compose up -d
. ./.env
echo
echo "Actualizado. Panel de gestión: http://${LAB_IP}:${PANEL_PORT:-8080}/admin/"
