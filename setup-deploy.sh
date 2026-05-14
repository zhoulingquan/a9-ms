#!/bin/bash

# GitHub Actions 自动部署设置脚本
# 用于初始化 GitHub 到 Cloudflare 的自动化部署

echo "========================================"
echo "🚀 GitHub Actions 部署设置"
echo "========================================"
echo ""

# 检查 Git 状态
echo "📋 检查 Git 状态..."
git status

echo ""
echo "========================================"
echo "⚠️  需要完成的步骤"
echo "========================================"
echo ""
echo "1️⃣  创建 Cloudflare API Token"
echo "   访问: https://dash.cloudflare.com/profile/api-tokens"
echo "   创建自定义 Token，配置以下权限:"
echo "   - Account: Edit"
echo "   - Worker Scripts: Edit"
echo "   - Workers KV Storage: Edit"
echo "   ⚠️  复制并保存生成的 Token!"
echo ""
echo "2️⃣  在 GitHub 添加 Secrets"
echo "   访问: https://github.com/zhoulingquan/A9_MS/settings/secrets/actions"
echo "   添加两个 secrets:"
echo "   - CLOUDFLARE_API_TOKEN: <您的API Token>"
echo "   - CLOUDFLARE_ACCOUNT_ID: 035ed3a922810717e2265dcbc8fd321b"
echo ""
echo "3️⃣  提交并推送代码"
echo "   执行以下命令:"
echo ""
cat << 'EOF'
git add .github/workflows/deploy.yml
git add worker.js
git add wrangler.toml
git add GITHUB_CLOUDFLARE_DEPLOY.md
git commit -m "Setup GitHub Actions for Cloudflare deployment"
git push origin master
EOF
echo ""
echo "4️⃣  查看部署状态"
echo "   访问: https://github.com/zhoulingquan/A9_MS/actions"
echo ""
echo "========================================"
echo "📖 详细说明请查看: GITHUB_CLOUDFLARE_DEPLOY.md"
echo "========================================"
