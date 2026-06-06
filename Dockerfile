# ============================================================
#  A9 Marketing System — Dockerfile
# ============================================================
FROM node:20-alpine

WORKDIR /app

# 安装 A9Bot Python 依赖（可选，仅在 A9BOT_ENABLED=true 时需要）
RUN apk add --no-cache python3 py3-pip

# 复制 Node 依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 复制应用代码
COPY app/ ./app/
COPY public/ ./public/

# 复制 A9Bot（可选）
COPY a9_bot/ ./a9_bot/

EXPOSE 3000

CMD ["node", "app/server.js"]
