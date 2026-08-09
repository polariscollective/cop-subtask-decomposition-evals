FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib/ ./lib/
COPY scripts/ ./scripts/

CMD ["node", "scripts/cloud-run-entrypoint.js"]
