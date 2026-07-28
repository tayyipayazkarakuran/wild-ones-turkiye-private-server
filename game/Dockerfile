FROM node:24.18.0-bookworm-slim
WORKDIR /srv/game
COPY game/package*.json ./
RUN npm ci --omit=dev
COPY game ./
COPY shared /srv/shared
COPY web/assets /srv/web/assets
COPY web/images /srv/web/images
USER node
CMD ["node", "app.js"]
