#!/bin/bash
# A9 Marketing System Launcher (Linux/macOS)
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "===================================="
echo " A9 Marketing System"
echo "===================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found! Please install Node.js v18+ from https://nodejs.org"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "[INFO] First launch - installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] Dependency installation failed."
        exit 1
    fi
    echo "[INFO] Dependencies installed."
fi

echo "[INFO] Starting server..."
echo ""
echo "Open http://localhost:3000 in your browser."
echo "Press Ctrl+C to stop the server."
echo ""

node server.js
