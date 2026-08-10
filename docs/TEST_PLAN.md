# Manual Test Plan
1. **Auth**
   - POST `/api/auth/login` with demo creds → 200 + token.
   - Invalid creds → 401.
2. **Add server**
   - POST `/api/servers` → returns `waiting` server.
3. **Agent register**
   - POST `/api/agent/register` → returns secret, interval.
4. **Metrics ingest**
   - Agent script sends metrics every 5 s → server status `online`.
5. **HMAC fail**
   - Change signature → 400 Bad Request.
6. **Offline metrics hidden**
   - Stop an agent, wait >120s → status `offline`, `latestMetrics` becomes `null` (not stale numbers).
7. **Retention**
   - Insert a `server_metrics` row with `timestamp` >2h old → gone within 5 min (cleanup interval).
8. **Commands**
   - POST `/api/servers/:id/command` `{command:"stop"}` → next agent metrics response includes `command:"stop"`; agent switches to heartbeat-only, status becomes `paused`.
   - `{command:"start"}` → agent resumes full metrics, status back to `online`.
   - `{command:"delete"}` → delivered once, server flips to `revoked`, agent uninstalls itself (verify via `eclipse status` on the node → unit gone).
9. **Settings**
   - POST `/api/settings/telegram/token` then GET `/api/settings` → `telegramConfigured:true`, token itself never returned.
   - POST/DELETE `/api/settings/telegram/chat-ids/:id` → id appears/disappears from `telegramChatIds`.
10. **Alerts**
    - Push metrics with `cpu.usage_percent` ≥ threshold for the full `sustainedMinutes` window → row appears in `/api/alerts` and (if Telegram configured) a message arrives in the configured chat.
    - Bring CPU back down → a "resolved" alert row follows.
    - Combined inbound+outbound bps ≥ 700 Mbit/s (default) on a node → `traffic` alert fires; below → no alert.
11. **Alerts pagination**
    - GET `/api/alerts?limit=10` with >10 rows in `alert_log` → `hasMore:true`; `limit=<total>` → `hasMore:false`. Frontend "Показать ещё" grows the visible window by 10 each click.
12. **Auth logging + Telegram notification**
    - Any POST to `/api/auth/login` (success or failure) → new row in `auth_attempts` with the caller's real IP (not `127.0.0.1` — confirms `trust proxy` + nginx `X-Forwarded-For` are wired correctly).
    - With a bot token + chat ID configured → a Telegram message arrives for every attempt, with a "🚫 Заблокировать" button.
13. **IP blocking via Telegram**
    - Tap the block button → `blocked_ips` gets a row, the Telegram message is edited to show "заблокирован" with the button removed, and any subsequent request from that IP to `/api/*` gets `403 {error:"blocked"}` — including a legitimate login attempt with correct credentials.
    - Unblock from Settings → Безопасность → requests succeed again.
    - Tapping the button from a chat ID *not* in the configured admin list → callback is rejected (no block happens).
14. **Fleet aggregates**
    - `/api/dashboard/summary` includes `total_inbound_bps`, `total_outbound_bps`, `total_ram_bytes`, `total_transferred_bytes`, `average_load` — spot-check `average_load` ≈ average of `(cpu+ram)/2` across online/warning nodes.
