# Deploying Eclipse Monitoring

`upgrade-34vpn-production.sh` is deprecated (see its header) — it regenerated the whole
project from heredocs and is out of sync with the current code. Deploy from the real
source tree instead.

## New server: panel.example.com (<IP-сервера>)

1. **DNS**: point `panel.example.com` A record to `<IP-сервера>`.
2. **Copy the project** to the server:
   ```bash
   rsync -az --exclude node_modules --exclude .next opt/34vpn-full/ root@<IP-сервера>:/opt/34vpn-full/
   ```
3. **Nginx**: copy `etc/nginx/sites-available/panel.example.com` to the server's
   `/etc/nginx/sites-available/`, then:
   ```bash
   ln -sfn /etc/nginx/sites-available/panel.example.com /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   ```
4. **TLS**: `certbot --nginx -d panel.example.com` (issues the cert the site config
   references; run this *before* the `listen 443 ssl` block is active, or use
   `certbot certonly` first if nginx -t fails on the missing cert).
5. **Start the stack**:
   ```bash
   cd /opt/34vpn-full/deploy
   docker compose up -d --build
   ```
6. **First login**: credentials are in `ADMIN-CREDENTIALS.txt`. Change the admin
   password after logging in, then configure the Telegram bot token and admin chat
   IDs from the panel's **Settings** tab.
7. **Restore existing nodes** (if migrating from panelsm.cloud134.ru): the servers
   table (`opt/34vpn-users-servers.sql`) can be restored, but each node's
   `agent_secret_enc` was encrypted with the *old* `AGENT_SECRET_ENCRYPTION_KEY` —
   it won't decrypt under the new key in `deploy/docker-compose.yml`. Either reuse
   the old key value for `AGENT_SECRET_ENCRYPTION_KEY`, or re-enroll each node
   (regenerate its token from the panel and re-run `install.sh` — it's idempotent).

## Updating an existing deployment

```bash
rsync -az --exclude node_modules --exclude .next opt/34vpn-full/ root@<host>:/opt/34vpn-full/
ssh root@<host> 'cd /opt/34vpn-full/deploy && docker compose up -d --build'
```

No database migrations to run by hand — `DbService.onModuleInit` creates any new
tables/columns automatically on backend startup.

## Node-side agent management

Each node gets `/usr/local/bin/eclipse` from the install script:

```bash
eclipse start|stop|restart|status
eclipse delete   # stops, disables, and removes the agent entirely
```

The panel can also queue `start`/`stop`/`restart`/`delete` remotely (per-node menu
or the node detail view) — the agent picks the command up on its next check-in.
Remote `stop` pauses metrics reporting (agent stays registered, shows as
"Приостановлен") so it can be remotely resumed with `start`; remote `delete` is
best-effort (needs one more successful check-in to be delivered). For a guaranteed
teardown, use `eclipse delete` on the node itself over SSH.

## Telegram security notifications & IP blocking

Every login attempt on the panel (success or failure) is logged to `auth_attempts`
and, if a Telegram bot token + at least one admin chat ID are configured, sent to
all admins with an inline **"🚫 Заблокировать"** button. Tapping it blocks that IP
at the backend (rejected with 403 before auth is even checked) — manage the list
from the panel's **Settings → Безопасность** panel too (manual block/unblock).

This relies on a Telegram webhook, registered automatically against
`${PANEL_PUBLIC_URL}/api/telegram/webhook` whenever a bot token is saved (and again
on every backend restart). Two things that matter operationally:

- `PANEL_PUBLIC_URL` in `deploy/docker-compose.yml` must be the real public HTTPS
  URL — Telegram calls it directly, it doesn't go through the browser.
- If you move the panel to a new domain, just restart the backend (or re-save the
  same token in Settings) — `SettingsService.onModuleInit` re-registers the webhook
  against whatever `PANEL_PUBLIC_URL` is now.

The webhook endpoint validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header
against a random secret generated on first use (stored in the `settings` table) —
it isn't behind the panel's JWT auth since Telegram itself calls it, but requests
without the correct secret are rejected.
