#!/usr/bin/env bash
# ============================================================
# dsh-tenant-setup — 一次性初始化多租户服务端环境
#
# 做的事：
#   1. 安装 dsh-tenant / dsh-tenant-nginx 到 /usr/local/bin
#   2. 确保 sshd_config 有 Include（Ubuntu 默认就有）
#   3. 在 UFW 里放行租户公网端口段（18100-18199）
#   4. 提示需要手动在云控制台放行同样的端口段
#
# 用法：
#   sudo dsh-tenant-setup <你的域名>
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "用法: sudo dsh-tenant-setup <你的域名>" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "需要 root：请用 sudo" >&2; exit 1; }

echo "=== 1/4 安装管理脚本 ==="
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in dsh-tenant.sh dsh-tenant-nginx.sh; do
  if [ -f "$HERE/$f" ]; then
    install -m 755 "$HERE/$f" "/usr/local/bin/${f%.sh}"
    echo "  安装 $(basename "${f%.sh}")"
  elif [ -f "/tmp/$f" ]; then
    install -m 755 "/tmp/$f" "/usr/local/bin/${f%.sh}"
    echo "  安装 $(basename "${f%.sh}") (from /tmp)"
  else
    echo "  [警告] 找不到 $f" >&2
  fi
done

echo "=== 2/4 检查 sshd 配置 ==="
if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
  echo "  [警告] sshd_config 里没有 Include 指令，租户限制不会生效！" >&2
  echo "        请手动在 /etc/ssh/sshd_config 顶部加：" >&2
  echo "        Include /etc/ssh/sshd_config.d/*.conf" >&2
else
  echo "  Include 已存在，OK"
fi
if sshd -t 2>/dev/null; then echo "  sshd 配置校验通过"; else echo "  [错误] sshd 配置有问题" >&2; sshd -t; fi

echo "=== 3/4 放行 UFW 端口段 ==="
if command -v ufw >/dev/null 2>&1; then
  ufw allow 18100:18199/tcp comment 'dsh mobile tenants' || true
  echo "  已放行 18100-18199/tcp"
else
  echo "  没有 ufw，跳过"
fi

echo "=== 4/4 确认证书 ==="
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  echo "  证书存在：/etc/letsencrypt/live/$DOMAIN/"
else
  echo "  [警告] 没找到 $DOMAIN 的证书。" >&2
  echo "        请先运行：sudo certbot certonly --nginx -d $DOMAIN" >&2
fi

cat <<EOF

===== 初始化完成 =====

【重要】还需要你在云服务器控制台里，
        于「安全组 / 防火墙」放行 TCP 18100-18199（或你打算用的端口段）。

之后每个朋友：
  1. sudo dsh-tenant add <名字>
     会输出私钥和分配到的端口
  2. sudo dsh-tenant-nginx $DOMAIN
     刷新 nginx 配置
  3. 把私钥和访问地址发给对方

查看所有租户：sudo dsh-tenant list
EOF
