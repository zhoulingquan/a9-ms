# A9 Marketing System 部署指南

> 本文档供 AI Agent 或开发者参考，描述如何在新电脑或服务器上启动本项目。

## 项目简介

A9 Marketing System 是基于 **Grist 多维表格 + Express 门户 + Caddy 鉴权代理** 的客户台账系统。

- **技术栈**：Node.js 20 + Express + Grist-EE + Caddy 2 + Docker Compose
- **架构**：三个容器协同工作
  - `grist`：多维表格引擎（仅内部网络可见）
  - `app`：Express 门户 + 鉴权 API（对外暴露 3000 端口）
  - `caddy`：鉴权代理（对外暴露 8484 端口，保护 Grist 访问）

## 前置要求

### 本地电脑

1. **Docker Desktop**（含 Docker Engine + Docker Compose）
   - macOS / Windows：https://www.docker.com/products/docker-desktop/

### 服务器（Linux）

```bash
# 安装 Docker + Docker Compose
curl -fsSL https://get.docker.com | sh

# 启动 Docker 并设置开机自启
sudo systemctl enable --now docker

# 验证
docker --version
docker compose version
```

> 无需安装 Node.js、Python 或任何其他运行时——所有依赖都在 Docker 容器内。

---

## 一、本地部署

适用于个人电脑开发、测试或演示。

### 1. 复制项目文件夹

将整个项目文件夹复制到电脑任意路径，例如 `~/A9_Customer_Ledger_System`。

### 2. 创建 .env 配置文件

```bash
cd A9_Customer_Ledger_System
cp .env.example .env
```

编辑 `.env`，**必须修改**以下两项：

```bash
# 生成强随机密钥（终端执行，复制输出填入 .env）
openssl rand -hex 32
SESSION_SECRET=<上面命令的输出>

# 设置管理员密码（至少 12 位强密码）
ADMIN_PASSWORD=<你的强密码>
```

其他变量保持默认值即可（适用于本地部署）。

### 3. 构建并启动容器

```bash
docker compose up -d --build
```

首次启动会拉取镜像并构建，约需 3-5 分钟。后续启动只需数秒。

### 4. 等待健康检查通过

```bash
docker compose ps
```

当 `app` 和 `grist` 显示 `Up (healthy)` 时即就绪：

```
NAME                                STATUS                    PORTS
a9_customer_ledger_system-app-1     Up (healthy)              0.0.0.0:3000->3000/tcp
a9_customer_ledger_system-caddy-1   Up                        0.0.0.0:8484->8484/tcp
a9_customer_ledger_system-grist-1   Up (healthy)              8484/tcp
```

> `caddy` 无健康检查配置，只要 `app` 和 `grist` healthy 即可。

### 5. 验证服务

```bash
curl http://localhost:3000/api/health
# 期望返回：{"status":"ok","time":"...","grist":"ok"}
```

浏览器访问：

- **A9 门户**：http://localhost:3000
- **Grist 多维表格**（经鉴权代理）：http://localhost:8484

### 6. 首次登录

使用 `.env` 中配置的账号登录 A9 门户：

- 邮箱：`admin@a9.com`（或 `ADMIN_EMAILS` 中配置的邮箱）
- 密码：`.env` 中设置的 `ADMIN_PASSWORD`

---

## 二、服务器部署

适用于公网或内网服务器对外提供服务。在本地部署基础上，需额外配置 HTTPS、域名和防火墙。

### 1. 上传项目到服务器

```bash
# 方式 A：scp 上传
scp -r A9_Customer_Ledger_System user@server:/opt/

# 方式 B：git clone（若托管在 Git 仓库）
git clone <repo-url> /opt/A9_Customer_Ledger_System
```

### 2. 安装 Docker（若未安装）

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
```

### 3. 配置 .env（服务器专属项）

```bash
cd /opt/A9_Customer_Ledger_System
cp .env.example .env
```

编辑 `.env`，**服务器必须修改**以下项：

```bash
# 生成新的强随机密钥
openssl rand -hex 32
SESSION_SECRET=<新生成的密钥>

# 强密码（至少 12 位）
ADMIN_PASSWORD=<强密码>

# ⚠️ 生产环境必须为 true（HTTPS 下 cookie 才安全）
SESSION_COOKIE_SECURE=true

# ⚠️ 改为实际域名（影响 Grist 生成的链接）
GRIST_EXTERNAL_URL=https://your-domain.com
APP_HOME_URL=https://your-domain.com
```

其他变量保持默认。

### 4. 配置防火墙

```bash
# 开放 A9 门户端口（对外）
sudo ufw allow 3000/tcp

# 开放 Grist 端口（仅当需要直接访问时；建议仅开放给反代）
sudo ufw allow 8484/tcp

# 或仅开放 80/443（若使用外层 HTTPS 反代）
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

> **安全建议**：生产环境建议只对外暴露 80/443，3000 和 8484 端口仅本地可达，由外层反代转发。

### 5. 配置 HTTPS 反向代理

项目内的 Caddy 仅做鉴权代理（forward_auth），**不提供对外 HTTPS**。服务器对外需要额外加一层反向代理处理 HTTPS 证书。

#### 方案 A：宿主机安装 Caddy 做 HTTPS 反代（推荐）

```bash
# 在服务器宿主机安装 Caddy（非容器）
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

创建宿主机 Caddyfile `/etc/caddy/Caddyfile`：

```caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl restart caddy
# Caddy 会自动申请 Let's Encrypt 证书并启用 HTTPS
```

#### 方案 B：使用 Nginx + Certbot

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

创建 `/etc/nginx/sites-available/a9ms.conf`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket 支持（Grist 需要）
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/a9ms.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# 申请 HTTPS 证书
sudo certbot --nginx -d your-domain.com
```

#### 方案 C：云厂商负载均衡 / CDN

把 HTTPS 证书放在云厂商 LB 上，转发到服务器的 3000 端口。无需在服务器上配置证书。

### 6. 配置 DNS 解析

在域名服务商处添加 A 记录：

```
your-domain.com  A  <服务器公网 IP>
```

等待 DNS 生效（通常几分钟到几小时）。

### 7. 启动容器

```bash
cd /opt/A9_Customer_Ledger_System
docker compose up -d --build
```

### 8. 验证服务器部署

```bash
# 容器状态
docker compose ps

# 本地健康检查
curl http://localhost:3000/api/health

# 公网 HTTPS 验证（DNS 生效后）
curl https://your-domain.com/api/health
```

浏览器访问 `https://your-domain.com` 登录验证。

### 9. 配置定时备份（推荐）

创建 `/etc/cron.daily/backup-a9`：

```bash
#!/bin/bash
cd /opt/A9_Customer_Ledger_System
mkdir -p backups

# 备份 Grist 数据
docker run --rm \
  -v a9_customer_ledger_system_grist_data:/data \
  -v "$PWD/backups":/backup \
  alpine tar czf /backup/grist-$(date +%F).tar.gz -C /data .

# 备份 App 数据
docker run --rm \
  -v a9_customer_ledger_system_app_data:/data \
  -v "$PWD/backups":/backup \
  alpine tar czf /backup/app-$(date +%F).tar.gz -C /data .

# 保留最近 7 天
find backups/ -name "*.tar.gz" -mtime +7 -delete
```

```bash
sudo chmod +x /etc/cron.daily/backup-a9
```

### ⚠️ 服务器部署安全红线

| 项目 | 要求 | 原因 |
|---|---|---|
| `SESSION_COOKIE_SECURE` | 必须为 `true` | HTTPS 下 cookie 才安全，否则会话可被劫持 |
| `ADMIN_PASSWORD` | 必须强密码（≥12 位） | 公网环境暴力破解风险 |
| `SESSION_SECRET` | 必须重新生成 | 复用密钥会导致会话伪造 |
| Grist 8484 端口 | **不要**直接对外暴露 | 必须经 Caddy forward_auth 鉴权 |
| Grist 子域名 | **不要**单独开子域名指向 Grist | 会绕过 forward_auth 鉴权，导致未授权访问 |
| 防火墙 | 建议只对外暴露 80/443 | 3000/8484 仅由外层反代访问 |
| HTTPS 证书 | 必须配置 | 生产环境强制 HTTPS |

---

## 常用命令

```bash
# 查看实时日志
docker compose logs -f

# 仅查看 app 日志
docker compose logs -f app

# 重启服务
docker compose restart app

# 停止所有服务
docker compose down

# 停止并删除数据（⚠️ 谨慎：会丢失所有 Grist 文档和用户数据）
docker compose down -v
```

## 数据备份与迁移

### 导出数据

```bash
# 打包 Grist 数据
docker run --rm \
  -v a9_customer_ledger_system_grist_data:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/grist-data-backup.tar.gz -C /data .

# 打包 App 数据（用户账户、会话、widget 配置）
docker run --rm \
  -v a9_customer_ledger_system_app_data:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/app-data-backup.tar.gz -C /data .
```

### 还原数据（新电脑/新服务器）

```bash
# 先启动容器让 volume 创建
docker compose up -d

# 还原 Grist 数据
docker run --rm \
  -v a9_customer_ledger_system_grist_data:/data \
  -v "$PWD":/backup \
  alpine tar xzf /backup/grist-data-backup.tar.gz -C /data

# 还原 App 数据
docker run --rm \
  -v a9_customer_ledger_system_app_data:/data \
  -v "$PWD":/backup \
  alpine tar xzf /backup/app-data-backup.tar.gz -C /data

# 重启使数据生效
docker compose restart
```

## 常见问题

### Q: 启动失败，提示 "SESSION_SECRET is required"

A: `.env` 文件未创建或 `SESSION_SECRET` 为空。按"创建 .env 配置文件"步骤操作。

### Q: 启动失败，提示 "ADMIN_PASSWORD is required"

A: 同上，`ADMIN_PASSWORD` 未设置。

### Q: 访问 http://localhost:3000 无响应

A: 检查容器状态 `docker compose ps`，确认 `app` 服务 healthy。查看日志 `docker compose logs app`。

### Q: 访问 http://localhost:8484 跳转到登录页

A: 这是正常行为。Grist 受 Caddy forward_auth 保护，必须先在 http://localhost:3000 登录 A9 门户，通过鉴权后才能访问 Grist。

### Q: better-sqlite3 报错"native module not found"

A: 不要在宿主机直接运行 `npm install`。本项目通过 Docker 构建，容器内会自动编译原生模块。确保使用 `docker compose up -d --build` 启动。

### Q: 端口被占用

A: 修改 `.env` 中的 `APP_PORT` 或 `GRIST_PORT`，或停止占用端口的其他程序。

### Q: 服务器访问 HTTPS 报证书错误

A: 检查 DNS 是否已指向服务器 IP，Caddy/Nginx 是否已重启。Caddy 会自动申请 Let's Encrypt 证书，首次申请需等待 1-2 分钟。

### Q: 服务器访问 Grist 返回 401/403

A: 这是 forward_auth 鉴权生效的正常表现。必须先登录 `https://your-domain.com`（A9 门户），会话建立后才能访问 Grist。

### Q: SESSION_COOKIE_SECURE=true 后无法登录

A: 此配置要求必须通过 HTTPS 访问。本地 HTTP 部署请保持 `false`；服务器部署请先配好 HTTPS 反代再改为 `true`。

## 项目结构

```
A9_Customer_Ledger_System/
├── app/                    # 后端源码（Express + Grist API 封装）
│   ├── server.js           # 入口：加载路由、启动服务
│   ├── auth.js             # 鉴权：登录/注册/会话/forward_auth
│   ├── grist-api.js        # Grist REST API 封装
│   ├── grist-db.js         # Grist SQLite 直读（用户/权限同步）
│   ├── proxy.js            # 反向代理（/grist/* → Grist）
│   ├── middlewares.js      # CSP、安全头、CORS
│   ├── stats.js            # /api/stats 统计聚合
│   ├── chart-data.js       # /api/chart-data 图表数据
│   ├── dashboard-widgets.js# 用户 widget 配置持久化
│   ├── admin.js            # 用户管理后台 API
│   ├── local-user-store.js # 本地用户存储（bcrypt 哈希）
│   ├── map-tiles.js        # 地图瓦片代理
│   └── config.js           # 环境变量读取
├── public/                 # 前端（单文件 HTML）
│   └── dashboard.html      # 看板主页（gridstack + ECharts + Leaflet）
├── scripts/
│   └── seed-test-data.js   # 测试数据种子脚本
├── test/                   # 单元测试（125 个）
├── .github/workflows/ci.yml# GitHub Actions CI
├── Caddyfile               # Caddy 鉴权代理配置
├── Dockerfile              # 多阶段构建（non-root 用户）
├── docker-compose.yml      # 三服务编排 + 网络隔离
├── .env.example            # 环境变量模板
├── .dockerignore
├── .gitignore
├── package.json
└── package-lock.json
```

---

## Agent 快速启动检查清单

### 本地部署清单

1. [ ] 确认 Docker 已安装：`docker --version` && `docker compose version`
2. [ ] 进入项目目录：`cd <项目路径>`
3. [ ] 创建 .env：`cp .env.example .env`
4. [ ] 生成 SESSION_SECRET：`openssl rand -hex 32`
5. [ ] 将密钥写入 .env 的 `SESSION_SECRET=`
6. [ ] 设置 .env 的 `ADMIN_PASSWORD=`（强密码）
7. [ ] 启动：`docker compose up -d --build`
8. [ ] 等待 healthy：`docker compose ps`（app + grist 显示 healthy）
9. [ ] 验证：`curl http://localhost:3000/api/health` 返回 `{"status":"ok",...}`
10. [ ] 浏览器访问 http://localhost:3000 登录验证

### 服务器部署清单

1. [ ] 安装 Docker：`curl -fsSL https://get.docker.com | sh && sudo systemctl enable --now docker`
2. [ ] 上传项目到服务器：`scp -r A9_Customer_Ledger_System user@server:/opt/`
3. [ ] 进入项目目录：`cd /opt/A9_Customer_Ledger_System`
4. [ ] 创建 .env：`cp .env.example .env`
5. [ ] 生成 SESSION_SECRET：`openssl rand -hex 32`，写入 .env
6. [ ] 设置 .env 的 `ADMIN_PASSWORD=`（强密码）
7. [ ] 设置 .env 的 `SESSION_COOKIE_SECURE=true`
8. [ ] 设置 .env 的 `GRIST_EXTERNAL_URL=https://your-domain.com`
9. [ ] 设置 .env 的 `APP_HOME_URL=https://your-domain.com`
10. [ ] 配置 DNS：A 记录 `your-domain.com` → 服务器 IP
11. [ ] 配置防火墙：`sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`
12. [ ] 安装并配置宿主机 Caddy/Nginx 反代（指向 localhost:3000）
13. [ ] 启动容器：`docker compose up -d --build`
14. [ ] 等待 healthy：`docker compose ps`
15. [ ] 本地验证：`curl http://localhost:3000/api/health`
16. [ ] 公网验证：`curl https://your-domain.com/api/health`
17. [ ] 浏览器访问 `https://your-domain.com` 登录验证
18. [ ] （可选）配置定时备份：创建 `/etc/cron.daily/backup-a9`
