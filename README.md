# FBR Digital Invoicing Middleware

Node.js middleware that receives invoice payloads from the invoicing app and forwards them to the FBR/PRAL Digital Invoicing API.

## How to view middleware logs

Logs are printed to **stdout** and **stderr** of the process that runs the middleware.

### Running in a terminal (easiest for debugging)

1. Open a terminal.
2. Go to the middleware folder:
   ```bash
   cd fbr-middleware
   ```
3. Create a `.env` file with `MIDDLEWARE_API_KEY` and optionally `PORT` (default 3001).
4. Start the server:
   ```bash
   npm start
   ```
   Or: `node server.js`

All logs appear **in that terminal**. You’ll see:

- `FBR middleware listening on port 3001` when the server starts
- `[FBR middleware] POST /api/submit received` when a post is attempted
- `[FBR middleware] Post response keys: [...]` — the top-level keys from the FBR post API response (useful when the invoice number is missing)
- `[FBR middleware] Success, invoiceNumber: <value>` on success
- `FBR post succeeded but no invoice number found. Response top-level keys: [...]` if the post succeeded but no known invoice-number field was found

Keep this terminal open while testing; logs stream in real time.

### Running in the background (e.g. PM2 or systemd)

- **PM2:** `pm2 start server.js --name fbr-middleware`  
  View logs: `pm2 logs fbr-middleware` or `pm2 logs fbr-middleware --lines 100`
- **systemd:** Logs go to journald. View with: `journalctl -u your-service-name -f`
- **Docker:** Use `docker logs -f <container>` to follow the container’s stdout

### Viewing logs on Contabo (or any VPS)

Your middleware runs on a remote server (e.g. Contabo VPS at `155.133.27.123`). To see its logs:

1. **SSH into the server**
   ```bash
   ssh your-user@155.133.27.123
   ```
   (Use your Contabo SSH user and key/password.)

2. **Find how the middleware is running**, then view logs:

   - **PM2 (recommended on VPS)**
     ```bash
     pm2 logs fbr-middleware
     ```
     Follow live: `pm2 logs fbr-middleware -f`  
     Last 200 lines: `pm2 logs fbr-middleware --lines 200`

   - **systemd service**
     ```bash
     journalctl -u fbr-middleware -f
     ```
     (Use your actual service name if different, e.g. `journalctl -u fbr-middleware.service -f`.)

   - **Running in a terminal (e.g. inside `screen` or `tmux`)**
     Reattach to that session to see the same terminal:
     - screen: `screen -r`
     - tmux: `tmux attach`

   - **Bare `node server.js` in background**
     Logs may be in nohup: `tail -f nohup.out` (if you started with `nohup node server.js &`).

3. **If you’re not sure how it’s running**
   ```bash
   ps aux | grep node
   ```
   or
   ```bash
   pm2 list
   ```
   If you see it under PM2, use `pm2 logs fbr-middleware`.

### Summary

| How you run it        | Where to see logs                          |
|-----------------------|--------------------------------------------|
| Terminal (`npm start`) | Same terminal window                       |
| PM2                   | `pm2 logs fbr-middleware`                  |
| systemd               | `journalctl -u <service> -f`               |
| Docker                | `docker logs -f <container>`               |
| Contabo / VPS         | SSH in, then use the command above that matches how you run it |
