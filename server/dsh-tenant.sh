#!/usr/bin/env bash
# ============================================================
# dsh-tenant — 手机访问多租户管理（在服务器上运行）
#
# 每个租户 = 一个独立 Linux 账户 + 独立的 SSH 密钥 + 独立的隧道端口。
# 账户被 PermitListen 限定：只能绑定分配给他的端口，开不了别的，
# 也访问不到其他租户或系统文件。
#
# 用法：
#   dsh-tenant add <名字>          创建租户，输出私钥和连接信息
#   dsh-tenant remove <名字>       删除租户（撤销密钥、关闭隧道）
#   dsh-tenant list                列出所有租户及端口占用
#   dsh-tenant reset-key <名字>    轮换该租户的密钥
# ============================================================
set -euo pipefail

TENANT_PREFIX="dshu"
# 端口规划：隧道端口只绑本机回环（sshd 反向转发用），公网端口由 nginx 监听。
#   TUNNEL_PORT = PORT_BASE + n   （19100 起，不需放行）
#   PUBLIC_PORT = TUNNEL_PORT - 1000（18100 起，需在安全组放行）
PORT_BASE=19100
PORT_MAX=19199
PUBLIC_OFFSET=1000
STATE_DIR="/opt/dsh-tenant/state"
KEY_DIR="/opt/dsh-tenant/keys"
SSHD_CONF_DIR="/etc/ssh/sshd_config.d"

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "需要 root：请用 sudo 运行" >&2
    exit 1
  fi
}

ensure_dirs() {
  mkdir -p "$STATE_DIR" "$KEY_DIR" "$SSHD_CONF_DIR"
  chmod 755 /opt/dsh-tenant
  chmod 700 "$KEY_DIR"
}

valid_name() {
  local n="$1"
  [[ "$n" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || {
    echo "名字只能是小写字母开头、含小写字母/数字/连字符，2-31 字符" >&2
    exit 1
  }
}

state_file() { echo "$STATE_DIR/$1.env"; }

# 找到第一个未被占用的端口
next_port() {
  local p
  for p in $(seq "$PORT_BASE" "$PORT_MAX"); do
    if ! grep -qs "^PORT=\"\?$p\"\?\$" "$STATE_DIR"/*.env 2>/dev/null; then
      # 也避开当前真被 sshd 监听着的
      if ! ss -lnt 2>/dev/null | grep -q ":$p "; then
        echo "$p"
        return 0
      fi
    fi
  done
  echo "没有可用端口（$PORT_BASE-$PORT_MAX 用尽）" >&2
  return 1
}

cmd_add() {
  local name="${1:-}"
  [ -n "$name" ] || { echo "用法: dsh-tenant add <名字>" >&2; exit 1; }
  valid_name "$name"

  local user="${TENANT_PREFIX}-${name}"
  local sfile; sfile="$(state_file "$name")"
  if [ -f "$sfile" ]; then
    echo "租户 $name 已存在。用 reset-key 轮换密钥，或先 remove。" >&2
    exit 1
  fi
  if id "$user" &>/dev/null; then
    echo "系统用户 $user 已存在但其状态文件缺失，请先手工清理。" >&2
    exit 1
  fi

  local port; port="$(next_port)"

  # 1. 建账户：无 shell 需要、无 home 内容、不能登录终端
  useradd --create-home --shell /usr/sbin/nologin "$user"
  # 关键：useradd 默认把密码字段设为 '!'（锁定），而 sshd 会拒绝锁定账户的
  # 密钥登录（auth.log 表现为 "Connection reset ... [preauth]"）。
  # 这里把密码字段清空（空密码 = 可认证），配合系统 PermitEmptyPasswords no，
  # 结果就是：密码登录不可能，只有我们装进去的公钥能登录。
  usermod -p '' "$user"

  # 2. 生成密钥对，公钥装进该账户
  local keyfile="$KEY_DIR/$name"
  ssh-keygen -t ed25519 -N '' -C "dsh-tenant:$name" -f "$keyfile" -q < /dev/null
  install -d -m 700 -o "$user" -g "$user" "/home/$user/.ssh"
  install -m 600 -o "$user" -g "$user" "$keyfile.pub" "/home/$user/.ssh/authorized_keys"

  # 3. 用 PermitListen 把账户锁死在他自己的端口上。
  #    PermitListen 支持 "host:port" 形式；127.0.0.1 前缀就够用，
  #    因为 nginx 在本机反代。
  cat > "$SSHD_CONF_DIR/dsh-tenant-$name.conf" <<EOF
# 由 dsh-tenant 管理：租户 $name
Match User $user
    AllowTcpForwarding remote
    PermitOpen none
    PermitListen 127.0.0.1:$port
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PasswordAuthentication no
EOF

  # 4. 记录状态
  cat > "$sfile" <<EOF
NAME="$name"
USER="$user"
PORT="$port"
CREATED="$(date -Iseconds)"
EOF
  chmod 600 "$sfile"

  # 5. 让 sshd 重载（先校验）
  if sshd -t; then
    timeout 15 systemctl reload ssh 2>/dev/null || timeout 15 systemctl reload sshd 2>/dev/null || true
  else
    echo "sshd 配置校验失败，已删除该租户配置" >&2
    rm -f "$SSHD_CONF_DIR/dsh-tenant-$name.conf"
    userdel -r "$user" 2>/dev/null || true
    rm -f "$sfile"
    exit 1
  fi

  echo
  echo "===== 租户已创建：$name ====="
  echo "Linux 账户 : $user"
  echo "隧道端口   : 127.0.0.1:$port（仅本机，不需放行）"
  echo "公网端口   : $((port - PUBLIC_OFFSET))（nginx 监听，安全组需放行）"
  echo "私钥文件   : $keyfile"
  echo
  echo "--- 私钥内容（发给朋友，只发一次）---"
  cat "$keyfile"
  echo "--- 私钥结束 ---"
  echo
  echo "提示：还需要跑一次 dsh-tenant-nginx <你的域名> 让 nginx 生成对应站点。"
}

cmd_remove() {
  local name="${1:-}"
  [ -n "$name" ] || { echo "用法: dsh-tenant remove <名字>" >&2; exit 1; }
  local sfile; sfile="$(state_file "$name")"
  [ -f "$sfile" ] || { echo "租户 $name 不存在" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$sfile"

  rm -f "$SSHD_CONF_DIR/dsh-tenant-$name.conf"
  userdel -r "$USER" 2>/dev/null || true
  rm -f "$KEY_DIR/$name" "$KEY_DIR/$name.pub" "$sfile"
  sshd -t && { timeout 15 systemctl reload ssh 2>/dev/null || timeout 15 systemctl reload sshd 2>/dev/null || true; }

  # 清掉 nginx 里该租户的片段（如果有）
  local ng="/etc/nginx/snippets/dsh-tenant-$name.conf"
  if [ -f "$ng" ]; then
    rm -f "$ng"
    nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
  fi

  echo "租户 $name 已删除（端口 $PORT 已释放）"
}

cmd_reset_key() {
  local name="${1:-}"
  [ -n "$name" ] || { echo "用法: dsh-tenant reset-key <名字>" >&2; exit 1; }
  local sfile; sfile="$(state_file "$name")"
  [ -f "$sfile" ] || { echo "租户 $name 不存在" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$sfile"

  local keyfile="$KEY_DIR/$name"
  rm -f "$keyfile" "$keyfile.pub"
  ssh-keygen -t ed25519 -N '' -C "dsh-tenant:$name" -f "$keyfile" -q
  install -m 600 -o "$USER" -g "$USER" "$keyfile.pub" "/home/$USER/.ssh/authorized_keys"

  echo "===== 密钥已轮换：$name ====="
  echo "--- 新私钥（发给朋友，只发一次）---"
  cat "$keyfile"
  echo "--- 私钥结束 ---"
}

cmd_list() {
  ensure_dirs
  local found=0
  printf '%-14s %-18s %-9s %-9s %-22s %s\n' "租户" "Linux账户" "隧道端口" "公网端口" "创建时间" "隧道状态"
  for f in "$STATE_DIR"/*.env; do
    [ -f "$f" ] || continue
    found=1
    (
      # shellcheck disable=SC1090
      . "$f"
      local public=$((PORT - PUBLIC_OFFSET))
      local listening="未连接"
      if ss -lnt 2>/dev/null | grep -q "127.0.0.1:$PORT "; then
        listening="已连接"
      fi
      printf '%-14s %-18s %-9s %-9s %-22s %s\n' "$NAME" "$USER" "$PORT" "$public" "$CREATED" "$listening"
    )
  done
  [ "$found" -eq 1 ] || echo "（暂无租户）"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    add)       need_root; ensure_dirs; shift; cmd_add "$@" ;;
    remove)    need_root; shift; cmd_remove "$@" ;;
    reset-key) need_root; ensure_dirs; shift; cmd_reset_key "$@" ;;
    list)      cmd_list ;;
    *)
      cat <<'USAGE'
dsh-tenant — 手机访问多租户管理

  dsh-tenant add <名字>        创建租户（输出私钥与端口）
  dsh-tenant remove <名字>     删除租户
  dsh-tenant reset-key <名字>  轮换密钥
  dsh-tenant list              列出所有租户
USAGE
      exit 1 ;;
  esac
}

main "$@"
