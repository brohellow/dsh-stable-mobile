# dsh-stable-mobile · 手机访问（稳定版）

把本机 DSH Web GUI 通过**你自己的服务器**带到手机上，用一个**固定网址 + 固定访问密码**长期访问。

和扫码类方案的区别：**不用每次重新扫码**，网址和密码都不变；DSH 重启、插件升级都不会让手机掉线。

## 为什么需要这个

手机上常见的两个坑：

1. **扫码令牌会失效** —— 每次 DSH 启动都会重新生成一次性令牌，旧的二维码和书签立刻作废，只能重扫。
2. **实时流连不上，一直「重新连接中」** —— 小米浏览器（MiuiBrowser）、微信内置浏览器等，页面和接口都正常，但 **WebSocket 握手时不携带 Cookie**，导致 `/api/remote.mux` 恒为 401。

本插件两条都解决了：固定凭据，加上**会话 Cookie 由网关在服务端注入**到每一条 HTTP 请求和每一次 WebSocket 握手，浏览器带不带 Cookie 都能连。

## 安装

直接从 GitHub 安装（推荐）：

```bash
dsh plugin install github:brohellow/dsh-stable-mobile
```

或下载 zip 解压后双击 `install-windows.cmd`（Windows）。

装好后重启 DeepSeek Harness，在「设置 → 手机访问」里配置。

## 使用（3 步）

1. 打开 **设置 → 手机访问**，展开「高级设置」，填入：
   - **服务器地址**：你的 VPS 域名/IP
   - **公网地址**：手机实际打开的地址，例如 `https://example.com:7000`
   - **私钥路径**：能登录服务器的 SSH 私钥（默认 `~/.ssh/id_ed25519`）
   - 其余保持默认即可
2. 点右上角 **开启**。
3. 卡片上会显示**固定网址**和**访问密码**，手机打开网址、输一次密码即可，之后 30 天内免登录。

## 服务器准备

插件只负责把本机 127.0.0.1 上的网关通过 SSH 反向隧道接到服务器。服务器一侧需要：

1. **sshd 允许反向转发**（默认允许）。确保该 SSH 用户可用密钥登录。
2. **nginx TLS 站点**反代到隧道端口。示例：

```nginx
server {
    listen 7000 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # 手机上传附件 / 长连接
    client_max_body_size 256m;
    proxy_buffering off;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:18081;   # = 插件「远端端口」
        proxy_http_version 1.1;

        # WebSocket / SSE 升级（Real-time 必须）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 让 DSH 的 Host 白名单通过；端口要与桌面 DSH 实际端口一致
        proxy_set_header Host 127.0.0.1:<DSH 端口>;

        # 实时流是长连接，超时要放宽
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 10s;
    }
}
```

在 `http { ... }` 里加：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

3. 云服务器安全组放行你在 `listen` 上用的端口。

## 工作原理

```
手机浏览器  https://<公网地址>/
    │ nginx TLS（你的服务器）
    ▼
服务器 127.0.0.1:<远端端口>   ← sshd 反向端口转发
    │ ssh -R（插件守护，断线指数退避重连）
    ▼
本机 127.0.0.1:<本机端口>     ← 本插件网关
    ├─ 访问密码登录 → HMAC 签名的 HttpOnly Cookie（30 天）
    ├─ 持有 DSH 会话 Cookie，逐请求 + 逐 WebSocket 握手注入
    └─ DSH Web GUI 127.0.0.1:<DSH 端口>
```

- 浏览器只拿到 `dsh_stable_gate`（本插件自己签发的登录态），**永远拿不到 DSH 的会话 Cookie**。
- 网关遇到上游 401 会自动重新换取会话并重试一次，DSH 重启后自动恢复。
- 本机不监听任何非 loopback 地址，也不需要开放入站端口。

## 配置项（`$DSH_HOME/stable-mobile.json`）

| 字段 | 说明 | 默认 |
|---|---|---|
| `enabled` | 是否随 DSH 启动 | `false` |
| `serverHost` | 服务器域名/IP | 空 |
| `serverPort` | SSH 端口 | `22` |
| `serverUser` | SSH 用户 | `ubuntu` |
| `sshKeyPath` | 私钥路径，支持 `~` | `~/.ssh/id_ed25519` |
| `remotePort` | 隧道在服务器上绑定端口 | `18081` |
| `port` | 网关在本机绑定端口 | `18081` |
| `publicUrl` | 公网地址（含端口） | 空 |
| `sessionHours` | 手机登录态时长（小时，≤720） | `720` |
| `tunnel` | 是否启动 SSH 隧道 | `true` |

访问密码与签名密钥存在同一文件的 `password` / `gateSecret`，首次启动自动生成；点「重置密码」会同时轮换两者，所有已登录设备立即失效。

## 安全说明

- 只允许密码登录，并有失败节流（10 次失败封禁 10 分钟）。
- 管理接口（`/stable-mobile/*`）只接受 loopback 对端。
- 变更类操作要求自定义请求头，避免被任意网页跨站驱动。
- 会话 Cookie 不下发给浏览器，也不写入日志。

## 多租户：一台服务器供多人使用

如果你想让**多个朋友共用你的服务器**（每人用独立密码登录各自电脑），
用 `server/` 目录下的脚本，而不是把服务器密钥发给别人：

```bash
sudo dsh-tenant-setup.sh 你的域名     # 一次性初始化
sudo dsh-tenant add alice             # 加一个人（输出专属私钥）
sudo dsh-tenant-nginx 你的域名         # 刷新 nginx
sudo dsh-tenant list                  # 查看所有租户
```

每人获得：独立的 Linux 账户、独立 SSH 密钥、独立的隧道端口。
`PermitListen` 把他锁在自己的端口上——**开不了别人的端口，也碰不到系统**。
详见 [server/README.md](server/README.md)。

⚠️ **绝对不要**把你自己的服务器私钥发给别人：那等于把整台服务器交出去。

## 已知限制

- 需要一台能跑 nginx + sshd 的服务器；纯内网（同一 Wi-Fi）可直接把 `tunnel` 关掉，用 `http://<本机局域网 IP>:<本机端口>` 访问。
- 公网地址的 TLS 证书需要你自己签发（示例用 Let's Encrypt）。
- 多租户模式每人占用一个公网端口，需在云安全组放行端口段。

## License

MIT
