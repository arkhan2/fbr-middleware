# Deploy FBR middleware to VPS (e.g. Contabo at root@155.133.27.123)

## One-time: allow SSH from your machine

```bash
# From your Mac/laptop (if you use a key):
ssh-copy-id root@155.133.27.123
# Or add your public key to the server's ~/.ssh/authorized_keys
```

## Option A: Deploy script (from repo root)

```bash
cd /Users/ar/development/invoicing-system/fbr-middleware
chmod +x deploy.sh
./deploy.sh root@155.133.27.123
```

Then on the server, set secrets and start:

```bash
ssh root@155.133.27.123
nano /opt/fbr-middleware/.env   # set FBR_BEARER_TOKEN, FBR_BASE_URL, MIDDLEWARE_API_KEY
cd /opt/fbr-middleware && npm start
# Or install systemd unit and enable:
sudo cp /opt/fbr-middleware/fbr-middleware.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fbr-middleware
```

## Option B: Manual deploy

```bash
# 1) Copy files
scp -r /Users/ar/development/invoicing-system/fbr-middleware root@155.133.27.123:/opt/

# 2) SSH and install
ssh root@155.133.27.123
cd /opt/fbr-middleware
cp .env.example .env
nano .env   # set FBR_BASE_URL, FBR_BEARER_TOKEN, MIDDLEWARE_API_KEY (min 32 chars)
npm install
npm start
# Ctrl+C then run under systemd:
sudo cp fbr-middleware.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fbr-middleware
```

## After deploy

- **Health check:** `curl http://155.133.27.123:3001/health` (or your HTTPS URL if you put Nginx in front).
- **App env:** Set `FBR_MIDDLEWARE_URL=http://155.133.27.123:3001` (or `https://...` if you use a reverse proxy) and `FBR_MIDDLEWARE_API_KEY=<same as MIDDLEWARE_API_KEY on server>`.

## HTTPS (recommended for production)

On the VPS, install Nginx and point a domain (e.g. `fbr-mw.yourdomain.com`) to the server, then proxy to `http://127.0.0.1:3001`. Use Let's Encrypt for the certificate so the app can call `https://fbr-mw.yourdomain.com`.
