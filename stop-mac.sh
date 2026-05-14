#!/bin/bash
# A9 Marketing System - Stop Server (macOS)
echo "===================================="
echo " Stopping A9 Marketing System..."
echo "===================================="

PID=$(pgrep -f "node server.js" 2>/dev/null)

if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null
    sleep 1

    # Force kill if still running
    if pgrep -f "node server.js" >/dev/null 2>&1; then
        kill -9 "$PID" 2>/dev/null
    fi

    echo "[OK] Server stopped."
else
    echo "[INFO] No running server found."
fi
