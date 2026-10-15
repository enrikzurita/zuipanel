# Imagen única con dos destinos:
#   docker build --target panel -t zuipanel-panel .
#   docker build --target agent -t zuipanel-agent .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/panel/package.json apps/panel/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages packages
COPY apps apps
COPY db db
RUN npm run build && npm run build -w @zuipanel/web && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist

FROM runtime-base AS panel
COPY --from=build /app/apps/panel/package.json apps/panel/
COPY --from=build /app/apps/panel/dist apps/panel/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/db db
ENV MIGRATIONS_DIR=/app/db/migrations PORT=8080
EXPOSE 8080
USER node
CMD ["node", "apps/panel/dist/server.js"]

FROM runtime-base AS agent
# El FFmpeg de Debian incluye soporte NVENC (necesita el runtime de NVIDIA en el host)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/agent/package.json apps/agent/
COPY --from=build /app/apps/agent/dist apps/agent/dist
ENV PORT=8081 HLS_DIR=/var/lib/zuipanel/hls
RUN mkdir -p /var/lib/zuipanel/hls && chown -R node:node /var/lib/zuipanel
EXPOSE 8081
USER node
CMD ["node", "apps/agent/dist/server.js"]
