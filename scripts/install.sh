#!/usr/bin/env bash
#
# Установка панели Eclipse Monitoring на чистый сервер (Ubuntu/Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/scripts/install.sh \
#     | bash -s -- --domain panel.example.com
#
# Обязательный флаг:
#   --domain   домен панели (A-запись должна уже указывать на этот сервер)
# Необязательные:
#   --token    GitHub-токен — нужен, только если репозиторий приватный
#   --email    почта для Let's Encrypt (по умолчанию admin@<домен>)
#   --repo     owner/repo (по умолчанию зашит ниже)
#   --branch   ветка (по умолчанию main)
#   --no-ssl   пропустить выпуск сертификата (например, панель за внешним прокси)

set -euo pipefail

REPO="${ECLIPSE_REPO:-blantxxv/eclipse-monitoring}"
BRANCH="main"
DOMAIN=""
TOKEN=""
EMAIL=""
WITH_SSL=1
DIR=/opt/34vpn-full

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --token)  TOKEN="${2:-}";  shift 2 ;;
    --email)  EMAIL="${2:-}";  shift 2 ;;
    --repo)   REPO="${2:-}";   shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --no-ssl) WITH_SSL=0; shift ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "запускать от root"
[[ -n "$DOMAIN" ]] || die "нужен --domain, например: --domain panel.example.com"
[[ -n "$EMAIL"  ]] || EMAIL="admin@${DOMAIN}"

log "Домен: $DOMAIN | репозиторий: $REPO@$BRANCH"

# --- пакеты ---------------------------------------------------------------
log "Ставлю зависимости"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git nginx openssl >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  log "Ставлю Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version >/dev/null 2>&1 || die "нужен docker compose v2"

# --- исходники ------------------------------------------------------------
PUBLIC_URL="https://github.com/${REPO}.git"
if [[ -n "$TOKEN" ]]; then
  CLONE_URL="https://x-access-token:${TOKEN}@github.com/${REPO}.git"
else
  CLONE_URL="$PUBLIC_URL"
fi

if [[ -d "$DIR/.git" ]]; then
  log "Репозиторий уже есть — обновляю"
  git -C "$DIR" remote set-url origin "$CLONE_URL"
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" reset --hard "origin/$BRANCH"
else
  log "Клонирую в $DIR"
  rm -rf "$DIR"
  git clone --branch "$BRANCH" "$CLONE_URL" "$DIR"
fi

# Токен в конфиге git не оставляем: если он был — переносим в отдельный файл под 600.
git -C "$DIR" remote set-url origin "$PUBLIC_URL"
if [[ -n "$TOKEN" ]]; then
  git -C "$DIR" config credential.helper "store --file=/root/.eclipse-git-credentials"
  printf 'https://x-access-token:%s@github.com\n' "$TOKEN" > /root/.eclipse-git-credentials
  chmod 600 /root/.eclipse-git-credentials
fi

# --- конфигурация ---------------------------------------------------------
ENV_FILE="$DIR/deploy/.env"
if [[ -f "$ENV_FILE" ]]; then
  log ".env уже есть — секреты сохраняю как есть"
else
  log "Генерирую секреты"
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  cat > "$ENV_FILE" <<EOF
PANEL_PUBLIC_URL=https://${DOMAIN}
ADMIN_EMAIL=admin@${DOMAIN}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
AGENT_SECRET_ENCRYPTION_KEY=$(openssl rand -hex 32)
EOF
  chmod 600 "$ENV_FILE"
fi

# --- nginx ----------------------------------------------------------------
log "Настраиваю nginx"
cat > "/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 50m;

    location /api/       { proxy_pass http://127.0.0.1:3406; include /etc/nginx/eclipse-proxy.conf; }
    location = /install.sh { proxy_pass http://127.0.0.1:3406/install.sh; include /etc/nginx/eclipse-proxy.conf; }
    location = /agent.py   { proxy_pass http://127.0.0.1:3406/agent.py;   include /etc/nginx/eclipse-proxy.conf; }
    location /           { proxy_pass http://127.0.0.1:3000; include /etc/nginx/eclipse-proxy.conf; }
}
EOF
cat > /etc/nginx/eclipse-proxy.conf <<'EOF'
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 120s;
EOF
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

if [[ $WITH_SSL -eq 1 ]]; then
  log "Выпускаю сертификат Let's Encrypt"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
    || warn "certbot не смог выпустить сертификат — панель останется на http. Проверь A-запись домена."
fi

# --- запуск ---------------------------------------------------------------
mkdir -p "$DIR/.eclipse-update"
log "Собираю образы (несколько минут)"
docker compose --project-directory "$DIR/deploy" --env-file "$ENV_FILE" -f "$DIR/deploy/docker-compose.yml" build
log "Запускаю"
docker compose --project-directory "$DIR/deploy" --env-file "$ENV_FILE" -f "$DIR/deploy/docker-compose.yml" up -d

# --- автообновление -------------------------------------------------------
log "Ставлю службу обновления"
install -m 755 "$DIR/scripts/self-update.sh" /usr/local/bin/eclipse-update
cp "$DIR/deploy/systemd/"*.service "$DIR/deploy/systemd/"*.path "$DIR/deploy/systemd/"*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now eclipse-update.path eclipse-update-check.timer
/usr/local/bin/eclipse-update check || true

echo
log "Готово"
echo "  Панель:  https://${DOMAIN}"
echo "  Логин:   $(grep '^ADMIN_EMAIL=' "$ENV_FILE" | cut -d= -f2-)"
echo "  Пароль:  $(grep '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
echo
echo "  Пароль лежит в $ENV_FILE — смените его после первого входа."
