#!/usr/bin/env bash
# Monta el laboratorio de ZuiPanel en un Ubuntu 24.04 limpio.
# Uso (desde la raíz del repo):  bash deploy/lab/bootstrap.sh
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$LAB_DIR"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---- Docker (repositorio oficial de Docker para Ubuntu) ----
if ! command -v docker >/dev/null 2>&1; then
  say "Instalando Docker"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
fi

# ---- .env con secretos aleatorios (solo la primera vez) ----
if [ ! -f .env ]; then
  say "Generando configuración (.env)"
  rnd() { openssl rand -hex "${1:-24}"; }
  LAB_IP="$(hostname -I | awk '{print $1}')"
  cat > .env <<EOF
LAB_IP=${LAB_IP}
PANEL_PORT=8080
NODE_PORT=8081
DB_PASSWORD=$(rnd)
DB_ROOT_PASSWORD=$(rnd)
REDIS_PASSWORD=$(rnd)
STREAM_SECRET=$(rnd 32)
ADMIN_TOKEN=$(rnd 32)
AGENT_KEY=$(rnd 32)
LAB_USER=prueba
LAB_PASS=$(rnd 5)
EOF
  chmod 600 .env
fi
set -a; . ./.env; set +a

# ---- Construir y arrancar ----
say "Construyendo imágenes (la primera vez tarda unos minutos)"
sudo docker compose build

say "Arrancando servicios"
sudo docker compose up -d

say "Esperando a los datos de ejemplo"
for _ in $(seq 1 120); do
  state="$(sudo docker compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' | awk '$1=="seed"{print $2" "$3}')"
  case "$state" in
    "exited 0") break ;;
    exited*) sudo docker compose logs seed; echo "El seed falló"; exit 1 ;;
  esac
  sleep 3
done
sudo docker compose logs --no-log-prefix seed | tail -2

PANEL="http://${LAB_IP}:${PANEL_PORT}"
say "Comprobación rápida"
curl -fsS "${PANEL}/health" && echo
curl -fsS "${PANEL}/player_api.php?username=${LAB_USER}&password=${LAB_PASS}" | head -c 160; echo

cat <<EOF

────────────────────────────────────────────────────────────
 ZuiPanel laboratorio listo

 Reproductor (Xtream Codes):
   Servidor:   ${PANEL}
   Usuario:    ${LAB_USER}
   Contraseña: ${LAB_PASS}

 Lista M3U:
   ${PANEL}/get.php?username=${LAB_USER}&password=${LAB_PASS}&type=m3u_plus&output=m3u8

 Panel de gestión:  ${PANEL}/admin/
   Token de entrada:  ${ADMIN_TOKEN}
 Logs:                    cd ${LAB_DIR} && sudo docker compose logs -f agent
────────────────────────────────────────────────────────────
EOF
