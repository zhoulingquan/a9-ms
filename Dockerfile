# ============================================================
#  A9 Marketing System — Dockerfile (multi-stage)
# ============================================================
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY app/ ./app/
COPY public/ ./public/
EXPOSE 3000
CMD ["node", "app/server.js"]
