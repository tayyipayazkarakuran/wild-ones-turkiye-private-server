FROM node:24.18.0-bookworm-slim
WORKDIR /srv/webapp
COPY web/package*.json ./
RUN npm ci --omit=dev
COPY web ./
COPY shared /srv/shared
USER node
CMD ["node", "app.js"]
