#!/usr/bin/env bash
set -euo pipefail
PANEL_URL=""; SERVER_ID=""; TOKEN=""
while [[ $# -gt 0 ]]; do case "$1" in --panel-url) PANEL_URL="$2"; shift 2 ;; --server-id) SERVER_ID="$2"; shift 2 ;; --token) TOKEN="$2"; shift 2 ;; *) echo "Unknown argument: $1"; exit 1 ;; esac; done
if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root: sudo ./install-eclipse-agent.sh ..."; exit 1; fi
if [[ -z "$PANEL_URL" || -z "$SERVER_ID" || -z "$TOKEN" ]]; then echo "Usage: $0 --panel-url https://panel.domain --server-id UUID --token TOKEN"; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then apt-get update; apt-get install -y curl ca-certificates python3 python3-pip python3-venv iproute2 procps util-linux; elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates python3 python3-pip iproute procps-ng util-linux; else echo "Unsupported OS"; exit 1; fi
mkdir -p /opt/eclipse-agent /etc/eclipse-agent /var/log/eclipse-agent
python3 -m venv /opt/eclipse-agent/venv
/opt/eclipse-agent/venv/bin/pip install --upgrade pip >/dev/null
/opt/eclipse-agent/venv/bin/pip install requests psutil pyyaml >/dev/null
curl -fsSL "$PANEL_URL/agent.py" -o /opt/eclipse-agent/eclipse-agent.py
chmod +x /opt/eclipse-agent/eclipse-agent.py
REGISTER_RESPONSE="$(curl -fsSL -X POST "$PANEL_URL/api/agent/register" -H "Content-Type: application/json" -d "{\"server_id\":\"$SERVER_ID\",\"enrollment_token\":\"$TOKEN\",\"hostname\":\"$(hostname)\",\"public_ip\":\"$(curl -fsSL https://api.ipify.org || true)\"}")"
AGENT_SECRET="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_secret"])' <<< "$REGISTER_RESPONSE")"
INTERVAL="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("metrics_interval",5))' <<< "$REGISTER_RESPONSE")"
cat > /etc/eclipse-agent/config.yml <<EOF_CONFIG
panel_url: "$PANEL_URL"
server_id: "$SERVER_ID"
agent_secret: "$AGENT_SECRET"
interval_seconds: $INTERVAL
verify_tls: true
ports:
  from: 1441
  to: 9443
EOF_CONFIG
chmod 600 /etc/eclipse-agent/config.yml; chown root:root /etc/eclipse-agent/config.yml
cat > /etc/systemd/system/eclipse-agent.service <<'EOF_SERVICE'
[Unit]
Description=Eclipse Server Monitoring Agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/opt/eclipse-agent/venv/bin/python /opt/eclipse-agent/eclipse-agent.py --config /etc/eclipse-agent/config.yml
Restart=always
RestartSec=5
User=root
StandardOutput=append:/var/log/eclipse-agent/agent.log
StandardError=append:/var/log/eclipse-agent/agent.log
[Install]
WantedBy=multi-user.target
EOF_SERVICE
cat > /usr/local/bin/eclipse <<'EOF_CLI'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root: sudo eclipse ${1:-status}"; exit 1; fi
case "${1:-}" in
  start) systemctl start eclipse-agent ;;
  stop) systemctl stop eclipse-agent ;;
  restart) systemctl restart eclipse-agent ;;
  status) systemctl status eclipse-agent --no-pager ;;
  delete)
    systemctl stop eclipse-agent 2>/dev/null || true
    systemctl disable eclipse-agent 2>/dev/null || true
    rm -f /etc/systemd/system/eclipse-agent.service
    systemctl daemon-reload
    rm -rf /opt/eclipse-agent /etc/eclipse-agent /var/log/eclipse-agent
    rm -f /usr/local/bin/eclipse
    echo "Eclipse agent removed."
    ;;
  *) echo "Usage: eclipse {start|stop|restart|delete|status}"; exit 1 ;;
esac
EOF_CLI
chmod +x /usr/local/bin/eclipse
systemctl daemon-reload; systemctl enable eclipse-agent; systemctl restart eclipse-agent
sleep 2; systemctl --no-pager status eclipse-agent || true
echo "Eclipse agent installed. Logs: journalctl -u eclipse-agent -f"
echo "Manage locally with: eclipse {start|stop|restart|delete|status}"
