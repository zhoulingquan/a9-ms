# GitHub 自动部署到 Cloudflare Workers 设置指南

本指南将帮助您设置 GitHub Actions，实现当 GitHub 项目有更新时自动部署到 Cloudflare Workers。

## 📋 前置要求

1. ✅ 已有的 Cloudflare 账户
2. ✅ 已有的 GitHub 仓库
3. ✅ 已部署的 Cloudflare Workers 项目

---

## 步骤 1：生成 Cloudflare API Token

### 1.1 登录 Cloudflare Dashboard
访问 https://dash.cloudflare.com/profile/api-tokens

### 1.2 创建 API Token
1. 点击 "Create Token"
2. 选择 "Custom token" → "Get started"
3. 配置 Token 权限：

```
Token name: GitHub-Actions-Deploy
Account permissions:
  - Account: Edit
  - User: Read
  - Worker Scripts: Edit
  - Workers KV Storage: Edit
Zone permissions:
  - Zone: Read (如果使用自定义域名)
  - Workers Routes: Edit
```

4. 点击 "Continue to summary"
5. 点击 "Create Token"
6. **重要**：复制并保存生成的 Token（只显示一次！）

---

## 步骤 2：在 GitHub 仓库中设置 Secrets

### 2.1 打开 GitHub 仓库设置
1. 访问 https://github.com/zhoulingquan/A9_MS
2. 点击 "Settings"（设置）
3. 在左侧菜单中选择 "Secrets and variables" → "Actions"

### 2.2 添加 Secrets
点击 "New repository secret" 添加以下两个 secrets：

**Secret 1: CLOUDFLARE_API_TOKEN**
- Name: `CLOUDFLARE_API_TOKEN`
- Secret: 您在步骤 1 生成的 API Token

**Secret 2: CLOUDFLARE_ACCOUNT_ID**
- Name: `CLOUDFLARE_ACCOUNT_ID`
- Secret: `035ed3a922810717e2265dcbc8fd321b`

---

## 步骤 3：推送代码触发自动部署

### 3.1 提交并推送 Workflow 文件
```bash
# 添加文件到 Git
git add .github/workflows/deploy.yml
git add worker.js
git add wrangler.toml

# 提交更改
git commit -m "Add GitHub Actions for Cloudflare deployment"

# 推送到 GitHub
git push origin master
```

### 3.2 查看部署状态
1. 访问 https://github.com/zhoulingquan/A9_MS/actions
2. 您将看到 "Deploy to Cloudflare Workers" workflow 正在运行
3. 点击 workflow 查看实时日志

---

## 步骤 4：验证自动部署

### 4.1 检查 Workflow 运行日志
- 如果看到 ✅ 绿色勾号，表示部署成功
- 如果看到 ❌ 红色叉号，点击查看错误信息

### 4.2 访问您的网站
- https://a9-ms-worker.lingquan-zhou.workers.dev
- 确认网站内容已更新

---

## 🔧 自定义配置

### 修改触发分支
如果您想使用其他分支作为部署触发器，编辑 `.github/workflows/deploy.yml`：

```yaml
on:
  push:
    branches:
      - main  # 改为您的分支名
```

### 添加更多部署步骤
您可以在 workflow 中添加：
- 运行测试
- 代码检查
- 构建步骤
- 通知（如 Slack、邮件等）

---

## 📝 常用命令

### 手动触发部署
1. 在 GitHub 仓库页面，点击 "Actions" 标签
2. 选择 "Deploy to Cloudflare Workers"
3. 点击 "Run workflow" → 选择分支 → 点击 "Run workflow"

### 查看 Cloudflare 部署版本
```bash
npx wrangler deployments list
```

### 回滚到旧版本
```bash
npx wrangler rollback <version-id>
```

---

## ❓ 常见问题

### Q: 部署失败怎么办？
A: 查看 GitHub Actions 的日志输出，常见问题包括：
- API Token 过期或权限不足
- 依赖安装失败
- Cloudflare 配额限制

### Q: 如何禁用自动部署？
A: 删除或重命名 `.github/workflows/deploy.yml` 文件

### Q: 可以同时部署到多个环境吗？
A: 可以，在 workflow 中添加多个 job 或使用 matrix strategy

---

## 🎉 完成后

每次您推送代码到 master 分支时，GitHub Actions 将自动：
1. 拉取最新代码
2. 安装依赖
3. 部署 Worker 到 Cloudflare
4. 上传静态文件到 KV 存储
5. 验证部署成功

您的网站将始终保持最新状态！

---

## 📞 需要帮助？

如果遇到问题，请检查：
1. GitHub Actions 日志
2. Cloudflare Dashboard 的 Workers 日志
3. Wrangler 配置是否正确
