#!/bin/bash

APP_FILE="/data/ifc2frag/server.js"
PIDS=$(pgrep -f "node $APP_FILE")

if [ -z "$PIDS" ]; then
  echo "실행 중인 ifc2frag 서버가 없습니다."
  exit 0
fi

echo "$PIDS" | xargs kill
echo "ifc2frag 서버를 종료했습니다."
