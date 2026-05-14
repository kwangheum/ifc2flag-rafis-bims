#!/bin/bash

APP_DIR="/data/ifc2frag"
APP_FILE="$APP_DIR/server.js"
LOG_FILE="$APP_DIR/app.log"

cd "$APP_DIR" || exit 1

nohup node "$APP_FILE" > "$LOG_FILE" 2>&1 &

echo "ifc2frag 서버 시작 완료"
echo "PID: $!"
