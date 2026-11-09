/**
 * dsh-stable-mobile — client half.
 *
 * Renders 设置 → 手机访问. Everything it shows and every action it takes goes
 * through the plugin's own loopback routes (`/stable-mobile/*`), which stay
 * reachable from a phone because the gateway proxies them from loopback.
 *
 * The card leads with the two things a user actually needs on the phone: the
 * fixed URL and the access password. Server/port fields live under 高级设置.
 */

window.__ModuleLoader__.load({
  id: 'dsh-stable-mobile',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = '/stable-mobile'
    const isZh = () => {
      const lang = (document.documentElement.lang || navigator.language || '').toLowerCase()
      return lang.startsWith('zh')
    }
    const L = (zhText, enText) => (isZh() ? zhText : enText)

    const T = {
      bg: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const card = {
      background: T.bg,
      border: `1px solid ${T.border}`,
      borderRadius: 14,
      padding: '18px 20px',
      marginBottom: 14,
      color: T.text,
      font: '13px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    }
    const row = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
    const label = { color: T.dim, fontSize: 12, minWidth: 84 }
    const value = { fontSize: 13, wordBreak: 'break-all' }
    const button = (primary) => ({
      appearance: 'none',
      border: `1px solid ${primary ? 'transparent' : T.border2}`,
      background: primary ? T.brand : 'transparent',
      color: primary ? '#fff' : T.text,
      borderRadius: 9,
      padding: '7px 13px',
      fontSize: 13,
      fontWeight: primary ? 600 : 500,
      cursor: 'pointer',
      fontFamily: 'inherit',
    })
    const badge = (color) => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '2px 9px',
      borderRadius: 999,
      fontSize: 12,
      color,
      background: `color-mix(in srgb, ${color} 14%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 36%, transparent)`,
    })
    const dot = (color) => ({ width: 7, height: 7, borderRadius: '50%', background: color })
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      borderRadius: 8,
      border: `1px solid ${T.border2}`,
      background: T.bg2,
      color: T.text,
      fontSize: 13,
      fontFamily: 'inherit',
    }
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }
    const bigCode = {
      ...mono,
      fontSize: 20,
      letterSpacing: '0.14em',
      fontWeight: 600,
      color: T.text,
      background: T.bg2,
      border: `1px solid ${T.border2}`,
      borderRadius: 10,
      padding: '10px 14px',
      display: 'inline-block',
    }

    const PHASE = {
      stopped: [T.idle, L('已关闭', 'Off')],
      starting: [T.warn, L('启动中…', 'Starting…')],
      running: [T.ok, L('运行中', 'Running')],
      error: [T.err, L('出错', 'Error')],
    }

    const TUNNEL_STATE = {
      stopped: L('未运行', 'Stopped'),
      starting: L('连接中…', 'Connecting…'),
      running: L('已连接', 'Connected'),
      exited: L('已断开', 'Disconnected'),
    }

    const FIELD_DEFAULTS = {
      serverHost: '',
      serverPort: '22',
      serverUser: 'ubuntu',
      sshKeyPath: '~/.ssh/id_ed25519',
      remotePort: '18081',
      port: '18081',
      publicUrl: '',
      sessionHours: '720',
    }

    function Section() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState(null)
      const mounted = useRef(true)

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(`${NS}/status.json`, { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const next = await response.json()
          if (!mounted.current) return
          setStatus(next)
          setError(null)
          setDraft((previous) => previous ?? {
            serverHost: next.config.serverHost ?? FIELD_DEFAULTS.serverHost,
            serverPort: String(next.config.serverPort ?? FIELD_DEFAULTS.serverPort),
            serverUser: next.config.serverUser ?? FIELD_DEFAULTS.serverUser,
            sshKeyPath: next.config.sshKeyPath ?? FIELD_DEFAULTS.sshKeyPath,
            remotePort: String(next.config.remotePort ?? FIELD_DEFAULTS.remotePort),
            port: String(next.config.port ?? FIELD_DEFAULTS.port),
            publicUrl: next.config.publicUrl ?? FIELD_DEFAULTS.publicUrl,
            sessionHours: String(next.config.sessionHours ?? FIELD_DEFAULTS.sessionHours),
          })
        } catch (failure) {
          if (mounted.current) setError(String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        void refresh()
        const timer = setInterval(() => { void refresh() }, 2000)
        return () => {
          mounted.current = false
          clearInterval(timer)
        }
      }, [refresh])

      const act = useCallback(async (action, extra) => {
        setBusy(action)
        setNotice(null)
        try {
          const response = await fetch(`${NS}/action`, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-stable-mobile-action': '1' },
            body: JSON.stringify({ action, ...(extra ?? {}) }),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`)
          if (action === 'rotate-password') {
            setNotice(L('已生成新密码，之前的密码和已登录设备立即失效。', 'New password generated; old passwords and sessions are void.'))
          }
          await refresh()
          return body
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return undefined
        } finally {
          setBusy(null)
        }
      }, [refresh])

      const copyText = useCallback(async (text, okMessage) => {
        if (typeof text !== 'string' || text.length === 0) return
        try {
          await navigator.clipboard.writeText(text)
          setNotice(okMessage)
        } catch {
          setError(L('复制失败，请长按手动复制', 'Copy failed; long-press to copy'))
        }
      }, [])

      const saveAdvanced = useCallback(async () => {
        if (!draft) return
        const patch = {
          serverHost: draft.serverHost,
          serverPort: Number(draft.serverPort),
          serverUser: draft.serverUser,
          sshKeyPath: draft.sshKeyPath,
          remotePort: Number(draft.remotePort),
          port: Number(draft.port),
          publicUrl: draft.publicUrl,
          sessionHours: Number(draft.sessionHours),
        }
        const result = await act('set', { patch })
        if (result !== undefined) setNotice(L('已保存，正在按新配置重启…', 'Saved; restarting with the new configuration…'))
      }, [draft, act])

      if (status === null) {
        return h('div', { style: card },
          h('div', { style: { fontWeight: 600, fontSize: 15 } }, L('手机访问', 'Phone Access')),
          error
            ? h('div', { style: { color: T.err, marginTop: 8 } }, L('无法读取状态：', 'Cannot read status: ') + error)
            : h('div', { style: { color: T.dim, marginTop: 8 } }, L('正在读取…', 'Loading…')))
      }

      const phaseInfo = PHASE[status.phase] ?? [T.idle, status.phase]
      const tunnelState = status.tunnel?.state ?? 'stopped'
      const lastError = status.lastError
      const tunnelError = status.tunnel?.lastError
      const configured = typeof status.publicUrl === 'string' && status.publicUrl.length > 0

      const renderConfigHint = () => {
        if (configured) return null
        return h('div', {
          style: {
            marginTop: 14,
            padding: '12px 14px',
            borderRadius: 10,
            background: `color-mix(in srgb, ${T.warn} 10%, transparent)`,
            border: `1px solid color-mix(in srgb, ${T.warn} 30%, transparent)`,
            color: T.text,
            fontSize: 12,
            lineHeight: 1.75,
          },
        },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } },
            L('还没有配置公网地址', 'No public URL configured')),
          h('div', { style: { color: T.dim } },
            L('展开下方「高级设置」，填入你的服务器地址和公网地址；服务器一侧需要已配好 nginx TLS 反代到 127.0.0.1:<远端端口>，并用 SSH 密钥登录。',
              'Open 高级设置 and fill in your server host and public URL. The server must already proxy its TLS site to 127.0.0.1:<remotePort> over SSH key auth.')))
      }

      return h('div', null,
        // ------------------------------------------------------------ header
        h('div', { style: { ...row, justifyContent: 'space-between', margin: '2px 2px 14px' } },
          h('div', null,
            h('div', { style: { fontSize: 16, fontWeight: 600 } }, L('手机访问', 'Phone Access')),
            h('div', { style: { color: T.dim, fontSize: 12, marginTop: 2 } },
              L('固定网址 + 固定密码：手机打开就能看到这台电脑上的实时进度，不用每次重新扫码。',
                'A fixed URL and a fixed password: open it on your phone to watch this machine live, no re-scanning.'))),
          h('div', { style: row },
            h('span', { style: badge(phaseInfo[0]) }, h('span', { style: dot(phaseInfo[0]) }), phaseInfo[1]),
            h('button', {
              style: button(false),
              disabled: busy !== null,
              onClick: () => { void act(status.enabled ? 'stop' : 'start') },
            }, status.enabled ? L('关闭', 'Turn off') : L('开启', 'Turn on')))),

        // --------------------------------------------------------- credentials
        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 12 } }, L('手机怎么用', 'How to connect on your phone')),
          h('div', { style: { ...row, marginBottom: 12 } },
            h('span', { style: label }, L('固定网址', 'URL')),
            status.publicUrl
              ? h('span', { style: { ...value, ...mono } }, status.publicUrl)
              : h('span', { style: { ...value, color: T.dim } }, L('（未配置）', '(not set)')),
            status.publicUrl
              ? h('button', { style: button(false), disabled: busy !== null, onClick: () => { void copyText(status.publicUrl, L('网址已复制', 'URL copied')) } }, L('复制', 'Copy'))
              : null),
          h('div', { style: { ...row, marginBottom: 12 } },
            h('span', { style: label }, L('访问密码', 'Password')),
            h('span', { style: bigCode }, status.password || '—'),
            h('button', {
              style: button(false),
              disabled: busy !== null || !status.password,
              onClick: () => { void copyText(status.password, L('密码已复制', 'Password copied')) },
            }, L('复制', 'Copy')),
            h('button', {
              style: button(false),
              disabled: busy !== null,
              onClick: () => { void act('rotate-password') },
            }, L('重置密码', 'New password'))),
          h('div', { style: { color: T.dim, fontSize: 12, lineHeight: 1.7 } },
            L('手机浏览器打开上面的网址，输入一次访问密码即可；之后 30 天内打开都不用再输。换密码会让所有已登录设备立即失效。',
              'Open the URL on your phone and enter the password once; it stays valid for 30 days. Rotating it signs every phone out.')),
          renderConfigHint()),

        // ------------------------------------------------------------ status
        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, L('连接状态', 'Connection')),
          h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '7px 12px' } },
            h('span', { style: label }, L('本机网关', 'Local gateway')),
            h('span', { style: value },
              `${status.localUrl}  →  127.0.0.1:${String(status.config.webPort ?? '')}`.replace(':undefined', '')),
            h('span', { style: label }, L('SSH 隧道', 'SSH tunnel')),
            h('span', { style: value },
              status.tunnelEnabled
                ? `${TUNNEL_STATE[tunnelState] ?? tunnelState}${status.tunnel?.pid ? ` · pid ${status.tunnel.pid}` : ''}`
                : L('已关闭（仅本机）', 'Disabled (loopback only)')),
            h('span', { style: label }, L('网关监听', 'Gateway listening')),
            h('span', { style: value }, status.gateway?.listening ? L('是', 'Yes') : L('否', 'No')),
            tunnelError
              ? h(React.Fragment, null,
                  h('span', { style: label }, L('隧道错误', 'Tunnel error')),
                  h('span', { style: { ...value, color: T.err } }, tunnelError.message))
              : null,
            lastError
              ? h(React.Fragment, null,
                  h('span', { style: label }, L('最近错误', 'Last error')),
                  h('span', { style: { ...value, color: T.err } }, `${lastError.code}: ${lastError.message}`),
                  lastError.hint
                    ? h(React.Fragment, null,
                        h('span', { style: label }, ''),
                        h('span', { style: { ...value, color: T.warn, fontSize: 12 } }, lastError.hint))
                    : null)
              : null,
            status.tunnel?.stderrTail?.length
              ? h(React.Fragment, null,
                  h('span', { style: label }, 'ssh'),
                  h('span', { style: { ...value, ...mono, color: T.dim, maxHeight: 96, overflow: 'auto', whiteSpace: 'pre-wrap' } },
                    status.tunnel.stderrTail.slice(-6).join('\n')))
              : null)),
          h('div', { style: { ...row, marginTop: 14 } },
            h('button', {
              style: button(true),
              disabled: busy !== null,
              onClick: () => { void act('restart') },
            }, L('重启网关', 'Restart'))),
          notice ? h('div', { style: { color: T.ok, fontSize: 12, marginTop: 10 } }, notice) : null,
          error ? h('div', { style: { color: T.err, fontSize: 12, marginTop: 10 } }, error) : null),

        // ---------------------------------------------------------- advanced
        h('details', { style: card },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, L('高级设置（服务器与端口）', 'Advanced (server and ports)')),
          h('div', { style: { color: T.dim, fontSize: 12, margin: '8px 0 12px' } },
            L('修改后点保存，插件会自动重建隧道与网关。服务器一侧需要已经配好 nginx TLS 反代到 127.0.0.1:<远端端口>。',
              'Saving rebuilds the tunnel and gateway. The server must already proxy its TLS site to 127.0.0.1:<remotePort>.')),
          draft
            ? h('div', { style: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: '8px 12px', alignItems: 'center' } },
                h('span', { style: label }, L('服务器地址', 'Server host')),
                h('input', { style: input, value: draft.serverHost, placeholder: 'example.com', onChange: (event) => setDraft({ ...draft, serverHost: event.target.value }) }),
                h('span', { style: label }, L('SSH 端口', 'SSH port')),
                h('input', { style: input, value: draft.serverPort, inputMode: 'numeric', onChange: (event) => setDraft({ ...draft, serverPort: event.target.value }) }),
                h('span', { style: label }, L('SSH 用户', 'SSH user')),
                h('input', { style: input, value: draft.serverUser, onChange: (event) => setDraft({ ...draft, serverUser: event.target.value }) }),
                h('span', { style: label }, L('私钥路径', 'Private key')),
                h('input', { style: input, value: draft.sshKeyPath, onChange: (event) => setDraft({ ...draft, sshKeyPath: event.target.value }) }),
                h('span', { style: label }, L('远端端口', 'Remote port')),
                h('input', { style: input, value: draft.remotePort, inputMode: 'numeric', onChange: (event) => setDraft({ ...draft, remotePort: event.target.value }) }),
                h('span', { style: label }, L('本机端口', 'Local port')),
                h('input', { style: input, value: draft.port, inputMode: 'numeric', onChange: (event) => setDraft({ ...draft, port: event.target.value }) }),
                h('span', { style: label }, L('公网地址', 'Public URL')),
                h('input', { style: input, value: draft.publicUrl, placeholder: 'https://example.com:7000', onChange: (event) => setDraft({ ...draft, publicUrl: event.target.value }) }),
                h('span', { style: label }, L('会话时长(h)', 'Session (h)')),
                h('input', { style: input, value: draft.sessionHours, inputMode: 'numeric', onChange: (event) => setDraft({ ...draft, sessionHours: event.target.value }) }))
            : null,
          h('div', { style: { ...row, marginTop: 14 } },
            h('button', { style: button(true), disabled: busy !== null || draft === null, onClick: () => { void saveAdvanced() } }, L('保存', 'Save')),
            h('button', {
              style: button(false),
              disabled: busy !== null,
              onClick: () => { void act('reset').then(() => setDraft(null)) },
            }, L('恢复默认', 'Reset defaults')))
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'stable-mobile',
          order: 30,
          label: isZh() ? '手机访问' : 'Phone Access',
        }, Section))
      },
    }
  },
})
