#!/bin/bash

# Configuration
APP_DIR="/root/quiclink"
BINARY="quiclink-server"
LOG_FILE="server.log"

cd $APP_DIR

echo "🛑 Stopping existing server..."
pkill -f $BINARY || echo "⚠️ No running process found."

echo "🚀 Starting server..."
# export QUIC_GO_LOG_LEVEL=DEBUG
nohup ./$BINARY > $LOG_FILE 2>&1 &

echo "✅ Server started! Logs are being written to $APP_DIR/$LOG_FILE"
echo "📜 Tailing logs (Ctrl+C to exit)..."
sleep 1
tail -f $LOG_FILE
