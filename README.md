<!-- ─────────────────────────  ШАПКА  ───────────────────────── -->
<div align="center">

<table>
<tr>
<td align="center" width="290">
<a href="https://t.me/Light_Eclipse">
<img src=".github/assets/eclipse.jpg" width="104" height="104" alt="Eclipse"><br>
<b>Eclipse</b>
</a><br>
<sub>канал автора проекта</sub><br><br>
<a href="https://t.me/Light_Eclipse">
<img src="https://img.shields.io/badge/Telegram-Light__Eclipse-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram">
</a>
</td>
<td align="center" width="290">
<a href="https://t.me/Sity34_bot?start=par_692295675vtees">
<img src=".github/assets/34vpn.jpg" width="104" height="104" alt="34 VPN"><br>
<b>34 VPN</b>
</a><br>
<sub>спонсор проекта</sub><br><br>
<a href="https://t.me/Sity34_bot?start=par_692295675vtees">
<img src="https://img.shields.io/badge/%D0%A1%D0%BF%D0%BE%D0%BD%D1%81%D0%BE%D1%80-34%20VPN-8A2BE2?style=for-the-badge&logo=telegram&logoColor=white" alt="Спонсор">
</a>
</td>
</tr>
</table>

<a href="https://github.com/blantxxv/eclipse-monitoring"><img src="https://visitor-badge.laobi.icu/badge?page_id=blantxxv.eclipse-monitoring&left_text=%D0%BF%D1%80%D0%BE%D1%81%D0%BC%D0%BE%D1%82%D1%80%D1%8B&left_color=%230e1218&right_color=%233ddc97" alt="Просмотры"></a>

</div>

<!-- ──────────────────────────────────────────────────────────── -->

# Eclipse Monitoring

Панель мониторинга серверов: состояние нод, нагрузка, трафик, подключения, мосты HAProxy,
инциденты и алерты в Telegram. Ноды подключаются лёгким Python-агентом.

<!-- скриншот появится после первого деплоя -->

## Что внутри

| Компонент  | Стек                        |
|------------|-----------------------------|
| Панель     | Next.js 14, React 18        |
| API        | NestJS, PostgreSQL, Redis   |
| Агент      | Python 3, systemd           |
| Развёртка  | Docker Compose, nginx, certbot |

Возможности: карта флота по странам, health score нод, история метрик (час → 30 дней),
инциденты от сбоя до восстановления, пороги алертов, экстренное выключение по категориям,
журнал входов и блокировка IP, обновление агентов и самой панели из интерфейса.

## Установка с нуля

Нужен чистый сервер **Ubuntu 22.04+ / Debian 12+**, root-доступ и домен, A-запись которого
уже указывает на этот сервер.

```bash
curl -fsSL https://raw.githubusercontent.com/blantxxv/eclipse-monitoring/main/scripts/install.sh \
  | bash -s -- --domain panel.example.com
```

Установщик сам поставит Docker, nginx и certbot, склонирует репозиторий в `/opt/34vpn-full`,
сгенерирует все секреты, выпустит сертификат Let's Encrypt, соберёт образы и поднимет панель.
В конце он напечатает адрес, логин и сгенерированный пароль администратора.

Флаги:

| Флаг | Назначение |
|------|-----------|
| `--domain` | домен панели (обязательный) |
| `--email` | почта для Let's Encrypt (по умолчанию `admin@<домен>`) |
| `--no-ssl` | не выпускать сертификат — если панель за внешним прокси |
| `--branch` | ветка репозитория (по умолчанию `main`) |
| `--token` | GitHub-токен, если репозиторий сделали приватным |

Пароль администратора лежит в `/opt/34vpn-full/deploy/.env` — смените его после первого входа.

## Подключение ноды

В панели: **Ноды → Добавить сервер**, укажите имя, IP и страну. Панель выдаст одноразовую
команду установки — выполните её на ноде от root. Агент зарегистрируется и начнёт слать метрики
каждые 5 секунд.

## Обновление панели

На вкладке **Обновления** есть блок «Обновление панели»: показывает установленный и доступный
коммиты, кнопки «Проверить обновления» и «Обновить панель». Проверка также идёт автоматически
раз в 30 минут.

Как это устроено: панель работает в контейнерах, поэтому обновляет её **хостовый** скрипт
`scripts/self-update.sh`, запускаемый systemd. Бэкенд лишь кладёт файл-заявку в
`/opt/34vpn-full/.eclipse-update/`, а `eclipse-update.path` подхватывает её и запускает обновление.
Так `docker.sock` и git-креденшелы не пробрасываются внутрь контейнера панели.

Если сборка новой версии упадёт, скрипт откатится на предыдущий коммит и поднимет контейнеры обратно.

Вручную то же самое:

```bash
eclipse-update check   # посмотреть, есть ли обновления
eclipse-update apply   # обновиться
journalctl -u eclipse-update -f
```

## Обслуживание

```bash
cd /opt/34vpn-full/deploy
docker compose --env-file .env logs -f backend     # логи
docker compose --env-file .env restart backend     # перезапуск
docker compose --env-file .env ps                  # состояние
```

Резервная копия базы:

```bash
docker exec deploy-postgres-1 pg_dump -U eclipse eclipse | gzip > eclipse-$(date +%F).sql.gz
```

## Секреты

В репозитории секретов нет — они генерируются установщиком и лежат в `deploy/.env` (права 600):

| Переменная | Назначение |
|---|---|
| `POSTGRES_PASSWORD` | пароль базы |
| `JWT_SECRET` | подпись токенов сессий |
| `AGENT_SECRET_ENCRYPTION_KEY` | шифрование секретов агентов **— менять нельзя после установки, иначе отвалятся все ноды** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | учётка администратора |

Перед сменой `.env` делайте копию: часть значений невосстановима.
