# ============================================================
#  A9 Marketing System — 融合 Dockerfile（单容器双进程）
#  Stage 1: node 构建 Munchkin WebUI + A9 Node 依赖
#  Stage 2: 融合运行时（Node + Python + uv + supervisord）
# ============================================================

# ---------- Stage 1: 构建 WebUI + Node 依赖 ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
# better-sqlite3 需要 node-gyp（Python + make + g++）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# A9 Node 依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Munchkin WebUI 构建
COPY munchkin-src/webui/ /tmp/webui/
WORKDIR /tmp/webui
RUN npm install --no-audit --no-fund && npm run build -- --base /munchkin/

# ---------- Stage 2: 融合运行时 ----------
FROM node:20-bookworm-slim

# 安装系统依赖：Python 3 + uv + supervisord + curl
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      curl ca-certificates supervisor \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && pip3 install --break-system-packages --no-cache-dir supervisor \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# ---------- 安装 A9 Node 依赖 ----------
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# ---------- 安装 Munchkin（Python） ----------
# 先装依赖（缓存层）：hatch_build.py 在场，跳过 WebUI 构建
COPY munchkin-src/pyproject.toml munchkin-src/README.md munchkin-src/LICENSE munchkin-src/THIRD_PARTY_NOTICES.md munchkin-src/hatch_build.py /app/munchkin-src/
RUN cd /app/munchkin-src && \
    mkdir -p munchkin/web && touch munchkin/__init__.py munchkin/web/__init__.py && \
    MUNCHKIN_SKIP_WEBUI_BUILD=1 uv pip install --system --no-cache --break-system-packages . && \
    rm -rf munchkin
# 复制 Python 源码 + 预构建的 WebUI dist
COPY munchkin-src/munchkin/ /app/munchkin-src/munchkin/
COPY --from=builder /tmp/munchkin/web/dist /app/munchkin-src/munchkin/web/dist
RUN cd /app/munchkin-src && uv pip install --system --no-cache --break-system-packages .

# ---------- 创建数据目录 ----------
RUN mkdir -p /app/data/sessions /home/munchkin/.munchkin

# ---------- 复制 A9 源码 ----------
COPY app/ ./app/
COPY public/ ./public/

# ---------- 复制 MCP Server ----------
COPY mcp-grist/ ./mcp-grist/

# ---------- 复制 munchkin 配置 ----------
COPY munchkin/config.json /home/munchkin/.munchkin/config.json

# ---------- supervisord 配置 ----------
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 3000

# 健康检查：A9 门户探活
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD curl -sf http://127.0.0.1:3000/api/health || exit 1

CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
