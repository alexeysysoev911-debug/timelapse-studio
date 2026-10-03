#!/usr/bin/env bash
# Установка сайта и сервера Timelapse Studio на VPS (Ubuntu/Debian) одной командой:
#   sudo bash install.sh tls.shadowpathlink.org
# Повторный запуск безопасен: обновляет сайт, панель и сервер; данные, пароль и сертификат сохраняются.
set -euo pipefail

DOMAIN="${1:-tls.shadowpathlink.org}"
DIR=/opt/timelapse-server
SRC="$(cd "$(dirname "$0")" && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Запустите через sudo: sudo bash install.sh $DOMAIN"; exit 1; fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "Неверный домен: $DOMAIN"; exit 1; fi
echo "==> Timelapse Studio → https://$DOMAIN"

# 1. Пакеты (только недостающие)
need=()
command -v python3 >/dev/null || need+=(python3)
command -v nginx   >/dev/null || need+=(nginx)
command -v certbot >/dev/null || need+=(certbot python3-certbot-nginx)
command -v curl    >/dev/null || need+=(curl)
if ((${#need[@]})); then
  echo "==> Устанавливаю: ${need[*]}"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Нужен Python 3.9 или новее"; exit 1; }

# 2. Файлы. Программа сервера, панель и сайт принадлежат root (служба их только читает),
#    писать служба может лишь в data/ — от отдельного пользователя без права входа.
SITE_SRC="$SRC/site"; [[ -d "$SITE_SRC" ]] || SITE_SRC="$SRC/../site"
[[ -f "$SITE_SRC/index.html" ]] || { echo "Не найдена папка site рядом со скриптом"; exit 1; }
[[ -f "$SRC/admin/panel.html" ]] || { echo "Не найдена папка admin рядом со скриптом"; exit 1; }
id tls >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin tls
mkdir -p "$DIR/data" "$DIR/admin"
install -o root -g root -m 0644 "$SRC/server.py" "$DIR/server.py"
install -o root -g root -m 0644 "$SRC"/admin/* "$DIR/admin/"
rm -rf "$DIR/site.new"
cp -r "$SITE_SRC" "$DIR/site.new"
chown -R root:root "$DIR/site.new"
find "$DIR/site.new" -type d -exec chmod 0755 {} +
find "$DIR/site.new" -type f -exec chmod 0644 {} +
rm -rf "$DIR/site.old"; [[ -d "$DIR/site" ]] && mv "$DIR/site" "$DIR/site.old"
mv "$DIR/site.new" "$DIR/site"; rm -rf "$DIR/site.old"
chown root:root "$DIR"; chmod 0755 "$DIR"
chown -R tls:tls "$DIR/data"; chmod 0700 "$DIR/data"

# 3. Первая настройка: адрес, пароль панели, ключ для автозагрузки из GitHub
if [[ ! -f "$DIR/data/config.json" ]] || ! grep -q '"password"' "$DIR/data/config.json"; then
  echo "==> Придумайте пароль для панели управления (от 10 символов)"
fi
sudo -u tls env TLS_DATA="$DIR/data" python3 "$DIR/server.py" init "https://$DOMAIN"

# 4. Служба: автозапуск, перезапуск при сбое, жёсткая изоляция
cat >/etc/systemd/system/timelapse-server.service <<EOF
[Unit]
Description=Timelapse Studio (сайт, панель, обновления, реклама)
After=network.target

[Service]
User=tls
Group=tls
Environment=TLS_DATA=$DIR/data
Environment=TLS_SITE=$DIR/site
Environment=TLS_HOST=127.0.0.1
Environment=TLS_PORT=8787
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3 $DIR/server.py
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
ReadWritePaths=$DIR/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now timelapse-server >/dev/null
systemctl restart timelapse-server

# 5. nginx: отдельный сайт для домена (сайт PhotoMetaName не затрагивается)
cat >/etc/nginx/conf.d/timelapse-limits.conf <<'EOF'
# Timelapse Studio: ограничение частоты запросов (защита от перебора пароля и флуда)
limit_req_zone $binary_remote_addr zone=tls_login:10m rate=6r/m;
limit_req_zone $binary_remote_addr zone=tls_api:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=tls_all:10m rate=40r/s;
limit_conn_zone $binary_remote_addr zone=tls_conn:10m;
EOF
mkdir -p /etc/nginx/snippets
cat >/etc/nginx/snippets/timelapse-proxy.conf <<'EOF'
proxy_pass http://127.0.0.1:8787;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection "";
proxy_request_buffering off;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
EOF
cat >/etc/nginx/snippets/timelapse-site.conf <<'EOF'
server_tokens off;
client_max_body_size 700m;
client_body_timeout 120s;
client_header_timeout 15s;
send_timeout 120s;
limit_conn tls_conn 40;
limit_req_status 429;
gzip on;
gzip_proxied any;
gzip_vary on;
gzip_min_length 512;
gzip_types text/css text/javascript application/javascript application/json application/manifest+json application/xml text/plain image/svg+xml;

location = /api/login { limit_req zone=tls_login burst=5 nodelay; include snippets/timelapse-proxy.conf; }
location /api/        { limit_req zone=tls_api burst=40 nodelay; include snippets/timelapse-proxy.conf; }
location /            { limit_req zone=tls_all burst=80 nodelay; include snippets/timelapse-proxy.conf; }
EOF
if [[ -d /etc/nginx/sites-available ]]; then
  CONF=/etc/nginx/sites-available/timelapse-server
  LINK=/etc/nginx/sites-enabled/timelapse-server
else
  CONF=/etc/nginx/conf.d/timelapse-server.conf
  LINK=""
fi
if [[ -f "$CONF" ]] && ! grep -qE "server_name[[:space:]]+$DOMAIN;" "$CONF"; then
  echo "!!  В $CONF указан другой домен. Удалите этот файл и запустите скрипт снова, чтобы перейти на $DOMAIN."
  exit 1
fi
if [[ ! -f "$CONF" ]] || ! grep -q "timelapse-site.conf" "$CONF"; then
cat >"$CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    include snippets/timelapse-site.conf;
}
EOF
fi
[[ -n "$LINK" ]] && ln -sf "$CONF" "$LINK"
nginx -t
systemctl reload nginx

# 6. HTTPS-сертификат (бесплатный, продлевается сам) + переадресация с http
if ! grep -q "ssl_certificate" "$CONF"; then
  echo "==> Получаю сертификат HTTPS для $DOMAIN"
  if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
    echo "!!  Сертификат не получен. Проверьте, что DNS-запись $DOMAIN указывает на этот сервер, и запустите скрипт ещё раз."
  fi
fi

sleep 1
if curl -fsS "http://127.0.0.1:8787/health" >/dev/null; then
  echo
  echo "Готово!"
  echo "  Сайт:          https://$DOMAIN"
  echo "  Панель:        https://$DOMAIN/admin"
  echo "  Обновления:    https://$DOMAIN/updates/latest.json"
  echo "  Ключ для GitHub (секрет TLS_DEPLOY_KEY): $(sudo -u tls env TLS_DATA="$DIR/data" python3 "$DIR/server.py" deploy-key)"
  echo "  Журнал:        journalctl -u timelapse-server -f"
else
  echo "!!  Сервер не отвечает. Журнал: journalctl -u timelapse-server -n 50"
  exit 1
fi
