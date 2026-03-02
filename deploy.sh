#!/usr/bin/env bash
# Deploy FBR middleware to VPS. Usage: ./deploy.sh root@155.133.27.123
# Ensure you can SSH to the host (e.g. ssh-copy-id root@155.133.27.123).

set -e
HOST="${1:?Usage: ./deploy.sh root@155.133.27.123}"
APP_DIR="/opt/fbr-middleware"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Deploying from $PROJECT_ROOT to $HOST:$APP_DIR"

# Copy middleware files (exclude node_modules, .env, .git)
rsync -avz --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude .git \
  --exclude "*.log" \
  "$PROJECT_ROOT/fbr-middleware/" \
  "$HOST:$APP_DIR/"

# Install on the server
ssh "$HOST" "cd $APP_DIR && npm install --production && ([ -f .env ] || cp .env.example .env)"

echo "Deploy complete. On the server:"
echo "  1. Edit env: ssh $HOST 'nano $APP_DIR/.env'"
echo "  2. Start:    ssh $HOST 'cd $APP_DIR && npm start'"
echo "  Or enable systemd: ssh $HOST 'sudo cp $APP_DIR/fbr-middleware.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now fbr-middleware'"
