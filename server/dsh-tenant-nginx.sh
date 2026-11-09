#!/usr/bin/env bash
# ============================================================
# dsh-tenant-nginx — 为多租户生成 nginx 反代配置（端口分离版）
#
# 关键设计：公网端口 ≠ 隧道端口
#
#   公网  https://<域名>:<PUBLIC_PORT>/   （nginx 监听，安全组需放行）
#         ▼
#   nginx 反代  ->  127.0.0.1:<TUNNEL_PORT>   （sshd 反向转发占用）
#         ▼
#   租户电脑上的网关 127.0.0.1:<本机端口>
#
# 如果让 nginx 和 sshd 抢同一个端口，nginx 先绑上后隧道就会
# "remote port forwarding failed"，两者永远只能活一个。
#
# 端口规划（每租户）：
#   TUNNEL_PORT = 19100 + n   （仅本机回环，不需要放行）
#   PUBLIC_PORT = 18100 + n   （nginx 监听，需要放行）
#
# 用法：
#   dsh-tenant-nginx <域名> [--dry-run]
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
DRY_RUN="${2:-}"

[ -n "$DOMAIN" ] || { echo "用法: dsh-tenant-nginx <域名> [--dry-run]" >&2; exit 1; }

STATE_DIR="/opt/dsh-tenant/state"
SITE="/etc/nginx/sites-available/dsh-tenants"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

need_root() { [ "$(id -u)" -eq 0 ] || { echo "需要 root：sudo 运行" >&2; exit 1; }; }
need_root

if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  echo "[错误] 没找到证书 $CERT_DIR/fullchain.pem" >&2
  echo "       先用 certbot 为 $DOMAIN 签发证书。" >&2
  exit 1
fi

# 读一个字段
field() { ( . "$1"; echo "${!2}" ); }

echo "=== 生成多租户 nginx 配置：$DOMAIN ==="
{
  echo "# 手机访问多租户入口（由 dsh-tenant-nginx 生成，勿手改）"
  echo "# 公网端口 PUBLIC_PORT -> 隧道端口 TUNNEL_PORT -> 租户电脑网关"
  echo ""

  count=0
  for f in "$STATE_DIR"/*.env; do
    [ -f "$f" ] || continue
    NAME="$(field "$f" NAME)"
    TUNNEL_PORT="$(field "$f" PORT)"
    # 公网端口 = 隧道端口 - 1000（19100 -> 18100）
    PUBLIC_PORT=$((TUNNEL_PORT - 1000))

    count=$((count + 1))
    cat <<EOF

# ---------------- 租户 $NAME : 公网 $PUBLIC_PORT -> 隧道 $TUNNEL_PORT ----------------
server {
    listen $PUBLIC_PORT ssl;
    listen [::]:$PUBLIC_PORT ssl ipv6only=on;
    server_name $DOMAIN;
    server_tokens off;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:DSHT$PUBLIC_PORT:1m;
    ssl_session_timeout 1h;

    client_max_body_size 256m;
    proxy_buffering off;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:$TUNNEL_PORT;
        proxy_http_version 1.1;

        proxy_set_header Upgrade DOLLARhttp_upgrade;
        proxy_set_header Connection DOLLARdsh_conn_upgrade;
        proxy_set_header Host DOLLARhost:DOLLARserver_port;
        proxy_set_header X-Real-IP DOLLARremote_addr;
        proxy_set_header X-Forwarded-For DOLLARproxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port DOLLARserver_port;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 10s;
    }

    access_log /var/log/nginx/dsh-tenant-$NAME.log;
    error_log  /var/log/nginx/dsh-tenant-$NAME.error.log warn;
}
EOF
  done

  [ "$count" -gt 0 ] || echo "# （暂无租户）"
} | sed 's/DOLLAR/\$/g' > "$SITE.tmp"

mv "$SITE.tmp" "$SITE"
chmod 644 "$SITE"
echo "  写入: $SITE"

MAPCONF="/etc/nginx/conf.d/dsh-tenants-map.conf"
cat > "$MAPCONF" <<'EOF'
# 由 dsh-tenant-nginx 生成：WebSocket/SSE 升级头映射（http 级）
map $http_upgrade $dsh_conn_upgrade {
    default upgrade;
    ''      close;
}
EOF
echo "  写入: $MAPCONF"

ln -sf "$SITE" /etc/nginx/sites-enabled/dsh-tenants
echo "  启用: /etc/nginx/sites-enabled/dsh-tenants"

if [ "${DRY_RUN}" = "--dry-run" ]; then
  echo "=== dry-run：不校验、不 reload ==="
  exit 0
fi

echo "=== 校验并 reload ==="
if nginx -t 2>&1; then
  systemctl reload nginx
  echo ""
  echo "  完成。租户访问地址："
  for f in "$STATE_DIR"/*.env; do
    [ -f "$f" ] || continue
    N="$(field "$f" NAME)"; T="$(field "$f" PORT)"; P=$((T - 1000))
    echo "    $N -> https://$DOMAIN:$P/"
  done
  echo ""
  echo "  记得在云服务器安全组放行这些公网端口。"
else
  echo "  [错误] nginx 配置有误，未 reload" >&2
  exit 1
fi
