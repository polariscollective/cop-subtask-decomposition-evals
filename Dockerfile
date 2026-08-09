FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY scenarios/ ./scenarios/

CMD ["node", "scripts/cloud-run-entrypoint.js"]
