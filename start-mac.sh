#!/bin/bash
# A9 Marketing System Launcher (macOS)
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

node server.js &

SERVER_PID=$!
sleep 2

if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[OK] Server is running at http://localhost:3000"
    open http://localhost:3000
    echo ""
    echo "  Start : ./start-mac.sh"
    echo "  Stop  : ./stop-mac.sh"
else
    echo "[ERROR] Server failed to start."
    exit 1
fi
