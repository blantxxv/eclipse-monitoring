#!/usr/bin/env bash
#
# Обновление панели Eclipse Monitoring. Запускается НА ХОСТЕ (не в контейнере):
# бэкенд лишь кладёт файл-заявку в .eclipse-update/, а systemd .path поднимает этот скрипт.
# Так GitHub-токен и docker.sock остаются вне контейнера панели.
#
#   eclipse-update check   — узнать, есть ли новые коммиты (пишет state.json)
#   eclipse-update apply   — обновиться и пересобрать
#   eclipse-update watch   — обработать заявки из .eclipse-update/ (вызывается systemd)

set -uo pipefail

DIR=/opt/34vpn-full
STATE_DIR="$DIR/.eclipse-update"
STATE="$STATE_DIR/state.json"
LOG="$STATE_DIR/update.log"
ENV_FILE="$DIR/deploy/.env"
COMPOSE=("docker" "compose" "--project-directory" "$DIR/deploy" "--env-file" "$ENV_FILE" "-f" "$DIR/deploy/docker-compose.yml")

mkdir -p "$STATE_DIR"
log() { printf '[%s] %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || printf '""'; }

write_state() {           # write_state <status> <message>
  local status="$1" message="$2"
  local local_sha remote_sha behind subject
  local_sha="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  remote_sha="$(git -C "$DIR" rev-parse "origin/$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)" 2>/dev/null || echo unknown)"
  behind="$(git -C "$DIR" rev-list --count HEAD..origin/HEAD 2>/dev/null || echo 0)"
  subject="$(git -C "$DIR" log -1 --pretty=%s "$remote_sha" 2>/dev/null || echo '')"
  cat > "$STATE.tmp" <<EOF
{
  "status": "$status",
  "message": $(printf '%s' "$message" | json_escape),
  "local": "$local_sha",
  "localShort": "${local_sha:0:7}",
  "remote": "$remote_sha",
  "remoteShort": "${remote_sha:0:7}",
  "behind": ${behind:-0},
  "updateAvailable": $([ "$local_sha" != "$remote_sha" ] && [ "$remote_sha" != "unknown" ] && echo true || echo false),
  "latestSubject": $(printf '%s' "$subject" | json_escape),
  "checkedAt": "$(date -Is)",
  "currentBranch": "$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
}
EOF
  mv "$STATE.tmp" "$STATE"
  chmod 666 "$STATE" 2>/dev/null || true
}

do_check() {
  log "проверка обновлений"
  if git -C "$DIR" fetch --quiet origin 2>>"$LOG"; then
    write_state idle "Проверка выполнена"
    log "проверка завершена"
  else
    write_state error "Не удалось связаться с GitHub (проверь токен в /root/.eclipse-git-credentials)"
    log "ошибка fetch"
    return 1
  fi
}

do_apply() {
  local branch; branch="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  write_state running "Загружаю изменения"
  log "обновление: старт"

  local before; before="$(git -C "$DIR" rev-parse HEAD)"

  if ! git -C "$DIR" fetch --quiet origin "$branch" 2>>"$LOG"; then
    write_state error "Не удалось получить изменения с GitHub"; return 1
  fi
  if ! git -C "$DIR" reset --hard "origin/$branch" >>"$LOG" 2>&1; then
    write_state error "Не удалось применить изменения"; return 1
  fi

  write_state running "Собираю образы"
  log "сборка"
  if ! "${COMPOSE[@]}" build >>"$LOG" 2>&1; then
    log "сборка упала — откат на $before"
    git -C "$DIR" reset --hard "$before" >>"$LOG" 2>&1
    "${COMPOSE[@]}" up -d >>"$LOG" 2>&1
    write_state error "Сборка не удалась, откатились на предыдущую версию"
    return 1
  fi

  write_state running "Перезапускаю контейнеры"
  log "перезапуск"
  if ! "${COMPOSE[@]}" up -d >>"$LOG" 2>&1; then
    write_state error "Не удалось перезапустить контейнеры"; return 1
  fi

  git -C "$DIR" fetch --quiet origin 2>>"$LOG" || true
  write_state idle "Обновление установлено"
  log "обновление: готово"
}

case "${1:-check}" in
  check) do_check ;;
  apply) do_apply ;;
  watch)
    # заявки от бэкенда
    if [[ -f "$STATE_DIR/apply.request" ]]; then
      rm -f "$STATE_DIR/apply.request" "$STATE_DIR/check.request"
      do_apply
    elif [[ -f "$STATE_DIR/check.request" ]]; then
      rm -f "$STATE_DIR/check.request"
      do_check
    fi
    ;;
  *) echo "использование: $0 {check|apply|watch}" >&2; exit 2 ;;
esac
