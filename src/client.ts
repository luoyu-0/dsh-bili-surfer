/**
 * dsh-bili-surfer —— 设置页（客户端半端）
 * ============================================================================
 * ⚠️ 这个文件编译出来**不是 ESM**，不能有 import/export，也不能写 JSX：
 *   它是被 `<script>` 直接加载的经典脚本，自己向 window.__ModuleLoader__ 注册工厂。
 *    - `id` 必须**等于 package.json 的 name**，否则加载器报
 *      `loaded without registering "<id>" via __ModuleLoader__.load`。
 *    - 只 require('react')（基线 external）；require 别的运行时包会被 `client bundle purity` 拦下来。
 *    - factory 返回一个 cordis 插件对象（inject + apply(ctx)），不是 React 组件。
 *
 * 源码是 `src/client.ts`（`tsconfig.client.json`，module:none 出 `client.js`）。
 * 别手改 client.js —— 改了下次 build 就没了。
 * ============================================================================
 */

/** 我们从 React 上真正用到的那几个口子（经典脚本不能 import 类型，只能手写）。 */
interface ReactLike {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
  useState: <T>(init: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void]
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void
  useRef: <T>(init: T) => { current: T }
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps?: readonly unknown[]) => T
}

/**
 * 设置项的形状。⚠️ 手抄自 `src/lib/types.ts` 的 `FieldMeta` —— 经典脚本 import 不了它。
 * 真正渲染时用的是 /status 现给的 fields，所以就算两边漂了也不会静默出错（多一个字段少一个字段立刻看得见）。
 */
interface FieldMeta {
  key: string
  type: 'bool' | 'num' | 'list' | 'enum' | 'string'
  label: string
  note?: string
  min?: number
  max?: number
  values?: readonly string[]
}

/** /status 与各路由的返回（都可能是 `{ok:false,error}`）。 */
interface Status {
  ok?: boolean
  error?: string
  version?: string
  build?: string
  home?: string
  enabled?: boolean
  loggedIn?: boolean
  uname?: string
  mid?: string | number
  hasCredential?: boolean
  config?: Record<string, unknown>
  fields?: FieldMeta[]
  running?: boolean
  seconds?: number
  lastRunAt?: string
  lastCount?: number
  runsToday?: number
  seenRows?: number
  lastReport?: string
  logTail?: string
}

type Json = Record<string, unknown>

interface Window {
  __ModuleLoader__: {
    load: (spec: { id: string; factory: (require: (name: string) => ReactLike) => unknown }) => void
  }
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
const json = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

window.__ModuleLoader__.load({
  id: 'dsh-bili-surfer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/api/bili-surfer'
    const CSS = `
      .bsf-wrap { display:flex; flex-direction:column; gap:14px; padding:2px 2px 18px; font-size:13px; }
      .bsf-card { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); border-radius:10px; padding:12px 14px; }
      .bsf-h { font-weight:600; font-size:13px; margin:0 0 10px; display:flex; align-items:center; gap:8px; }
      .bsf-h small { font-weight:400; opacity:.62; }
      .bsf-row { display:flex; align-items:center; gap:8px; margin:7px 0; flex-wrap:wrap; }
      .bsf-row > label.bsf-k { flex:0 0 132px; opacity:.8; }
      .bsf-row .bsf-note { flex:1 1 220px; opacity:.55; font-size:12px; line-height:1.35; }
      .bsf-input, .bsf-select { background:var(--dsw-alias-bg-base, transparent); color:inherit;
        border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius:7px; padding:4px 8px; font:inherit; }
      .bsf-input { min-width:120px; }
      .bsf-input.bsf-wide { flex:1 1 260px; min-width:200px; }
      .bsf-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius:7px;
        padding:5px 12px; font:inherit; cursor:pointer; background:var(--dsw-alias-bg-layer-1, transparent); color:inherit; }
      .bsf-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l3, rgba(128,128,128,.55)); }
      /* 主按钮必须成对取色：fill 与「fill 上的文字」是两个 token。
         ⚠️ 以前写死 color:#fff + 品牌色底 —— 暗色主题下 --dsw-alias-brand-primary 是近白色，
         白字白底，按钮就变成一个空白的方块（2026-10 用户截图就是这个）。 */
      .bsf-btn.bsf-primary { background:var(--dsw-alias-button-primary-fill, #2f6feb);
        border-color:transparent; color:var(--dsw-alias-label-primary-foreground, #fff); }
      .bsf-btn.bsf-primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover, #2563d6); }
      .bsf-btn:disabled { opacity:.45; cursor:not-allowed; }
      .bsf-tag { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid currentColor; opacity:.75; }
      .bsf-ok { color:var(--dsw-alias-state-success-primary, #2f9e5f); }
      .bsf-warn { color:var(--dsw-alias-state-warn-label, #c98a1a); }
      .bsf-bad { color:var(--dsw-alias-state-error-primary, #d05555); }
      .bsf-pre { white-space:pre-wrap; word-break:break-all; font-family:ui-monospace,Consolas,monospace;
        font-size:11.5px; line-height:1.5; max-height:280px; overflow:auto; margin:0;
        background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); border-radius:8px; padding:9px 11px; }
      .bsf-tabs { display:flex; gap:6px; margin-bottom:9px; }
      .bsf-tab { padding:4px 11px; border-radius:7px; cursor:pointer; opacity:.62; border:1px solid transparent; }
      .bsf-tab.bsf-on { opacity:1; background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14));
        border-color:var(--dsw-alias-border-l2, rgba(128,128,128,.28)); }
      .bsf-qr { display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap; }
      .bsf-qr canvas { image-rendering:pixelated; border-radius:8px; background:#fff; padding:6px; }
      .bsf-kv { display:grid; grid-template-columns:auto 1fr; gap:3px 12px; opacity:.85; }
      .bsf-kv b { font-weight:500; opacity:.6; }
      .bsf-mono { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; }
      .bsf-warnbox { border-color:var(--dsw-alias-state-warn-secondary, rgba(201,138,26,.55)); }
    `

    /* ── 极薄的 fetch 封装：所有错误都变成 {ok:false,error}，绝不 throw 到 React ── */
    async function api(path: string, body?: unknown): Promise<Json> {
      try {
        const r = await fetch(API + path, {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'same-origin',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return json(await r.json())
      } catch (e) {
        return { ok: false, error: String((e as Error | undefined)?.message || e) }
      }
    }

    const asText = (v: unknown): string => (Array.isArray(v) ? v.join('、') : v === undefined || v === null ? '' : String(v))
    const asList = (v: unknown): string[] => String(v || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)

    /** 二维码：服务端给的是 '0'/'1' 行矩阵，这儿画到 canvas 上（不用任何 QR 库）。 */
    function QrCode(props: { rows?: unknown }): unknown {
      const ref = useRef<HTMLCanvasElement | null>(null)
      const rows: string[] = Array.isArray(props.rows) ? (props.rows as string[]) : []
      useEffect(() => {
        const cv = ref.current
        if (!cv || !rows.length) return
        const n = rows.length
        const scale = Math.max(2, Math.floor(232 / n))
        cv.width = n * scale
        cv.height = n * scale
        const g = cv.getContext('2d')
        if (!g) return
        g.fillStyle = '#fff'
        g.fillRect(0, 0, cv.width, cv.height)
        g.fillStyle = '#000'
        for (let y = 0; y < n; y++) {
          const row = rows[y]
          for (let x = 0; x < row.length; x++) if (row[x] === '1') g.fillRect(x * scale, y * scale, scale, scale)
        }
      }, [props.rows])
      return h('canvas', { ref, width: 232, height: 232 })
    }

    /**
     * 列表/数字这种「边打边改」的输入框：**框里显示什么由本地 state 决定**，只把规范化后的结果交给上层。
     * ⚠️ 以前直接把 props.value 喂回 input —— keywords 每次渲染都过 `asList().join('、')`，
     * 于是空格和「、」当场被吃掉：按提示想打第二个词永远打不进去；数字框清空立刻变 0，
     * 再点保存就被 clamp 抬到下限（用户以为自己只是清了个框，条数却被改了）。
     */
    function RawField(props: {
      f: FieldMeta
      value: unknown
      onChange: (v: unknown) => void
      [k: string]: unknown
    }): unknown {
      const { f, value, onChange, ...rest } = props
      const [text, setText] = useState<string>(() => asText(value))
      const focused = useRef(false)
      // 上一次「外部值」长什么样。effect 只认外部真的变了才回填：
      // 用户刚打的「A、」/ 刚清空的数字框，外部值其实没动（数字框清空时我们不上报），不该被覆盖。
      const lastOuter = useRef(asText(value))
      useEffect(() => {
        const now = asText(value)
        if (focused.current || now === lastOuter.current) return
        lastOuter.current = now
        const mine = f.type === 'list' ? asText(asList(text)) : text
        if (now !== mine) setText(now)
      }, [value])
      return h('input', {
        ...rest,
        value: text,
        placeholder: f.type === 'list' ? '用、或空格分隔' : '',
        onFocus: () => { focused.current = true },
        onBlur: () => {
          focused.current = false
          // 离焦时把框里的字规范化一遍：列表 →「A、B」；数字清空 → 回到原值（不是 0，也不是下限）
          setText((cur) => (f.type === 'list' ? asText(asList(cur)) : (String(cur).trim() === '' ? asText(value) : cur)))
        },
        onChange: (e: { target: { value: string } }) => {
          const raw = e.target.value
          setText(raw)
          if (f.type === 'num') {
            // 空框只是「还没打完」，别把 0 写进草稿（0 会被 clamp 成下限）
            if (String(raw).trim() !== '') onChange(Number(raw))
          } else onChange(f.type === 'list' ? asList(raw) : raw)
        },
      })
    }

    function Field(props: { f: FieldMeta; value: unknown; onChange: (v: unknown) => void }): unknown {
      const { f, value, onChange } = props
      const common = { key: f.key, className: 'bsf-row' }
      let control: unknown
      if (f.type === 'bool') {
        control = h('input', { type: 'checkbox', checked: Boolean(value), onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked) })
      } else if (f.type === 'enum') {
        control = h('select', {
          className: 'bsf-select',
          value: asText(value),
          onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        }, (f.values || []).map((v) => h('option', { key: v, value: v }, v)))
      } else if (f.type === 'num') {
        control = h(RawField, { f, value, onChange, className: 'bsf-input', type: 'number', min: f.min, max: f.max, style: { width: '96px' } })
      } else if (f.type === 'list') {
        control = h(RawField, { f, value, onChange, className: 'bsf-input bsf-wide' })
      } else {
        control = h('input', {
          className: 'bsf-input', value: asText(value), placeholder: f.key === 'mentionName' ? '不带 @，例如：小明' : '',
          onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        })
      }
      return h('div', common,
        h('label', { className: 'bsf-k' }, f.label),
        control,
        f.note ? h('span', { className: 'bsf-note' }, f.note) : null,
      )
    }

    function Panel(): unknown {
      const [st, setSt] = useState<Status | null>(null)
      const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
      const [dirty, setDirty] = useState(false)
      const [tab, setTab] = useState('config')
      const [report, setReport] = useState<Json | null>(null)
      const [seen, setSeen] = useState<Json | null>(null)
      const [qr, setQr] = useState<Json | null>(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState('')
      const dirtyRef = useRef(false)
      const qrPolling = useRef(false)
      const qrTimer = useRef<ReturnType<typeof setInterval> | null>(null)

      /** 停掉扫码轮询。⚠️ 必须能被卸载/退出/重开时调到：以前 setInterval 的 id 没存，
       *  点过一次「扫码登录」之后不论成功失败，页面都会每 3 秒打一次 /login/poll 直到刷新。 */
      const stopQrPolling = useCallback(() => {
        if (qrTimer.current) clearInterval(qrTimer.current)
        qrTimer.current = null
        qrPolling.current = false
      }, [])

      const load = useCallback(async () => {
        const s = (await api('/status')) as Status
        setSt(s)
        if (!dirtyRef.current) setDraft(s.config || {})
        return s
      }, [])

      useEffect(() => {
        let alive = true
        const tick = async () => {
          if (!alive) return
          const s = (await api('/status')) as Status
          if (!alive) return
          setSt(s)
          if (!dirtyRef.current) setDraft(s.config || {})
        }
        tick()
        const t = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      // 卸载时把扫码轮询也停掉（这条以前漏了：定时器会活到页面刷新为止）
      useEffect(() => () => stopQrPolling(), [stopQrPolling])

      const setField = (key: string, v: unknown): void => {
        dirtyRef.current = true
        setDirty(true)
        setDraft((d) => ({ ...(d || {}), [key]: v }))
      }

      const save = async (): Promise<void> => {
        setBusy('save')
        const r = await api('/config', { patch: draft })
        setBusy('')
        if (r.ok) {
          dirtyRef.current = false
          setDirty(false)
          setDraft(json(r.config))
          // 说清楚「改了什么 / 有没有白改」：空保存、以及被白名单丢掉的键，都要看得见。
          const ch = Array.isArray(r.changed) ? (r.changed as string[]) : []
          const ig = Array.isArray(r.ignored) ? (r.ignored as string[]) : []
          const what = ch.length ? `（${ch.join('、')}）` : '（没有改动）'
          setMsg(ig.length ? `已保存${what}；${ig.join('、')} 不在白名单里，没生效` : `已保存${what}，立刻生效，不用重启`)
        } else setMsg(`保存失败：${str(r.error)}`)
      }

      const run = async (): Promise<void> => {
        setBusy('run')
        const r = await api('/run', {})
        setBusy('')
        setMsg(r.ok ? '已经开始了，进度看下面的日志（完成后这里会出现报告）' : r.busy ? '上一轮还在跑' : `没跑起来：${str(r.error)}`)
      }

      const startLogin = async (): Promise<void> => {
        setBusy('login')
        stopQrPolling()
        const r = await api('/login/start', {})
        setBusy('')
        if (r.ok) {
          setQr(r)
          setMsg('用手机 B 站 App 扫码')
          if (!qrPolling.current) {
            qrPolling.current = true
            qrTimer.current = setInterval(async () => {
              const p = await api('/login/poll', {})
              if (p.ok && p.status === 'ok') {
                stopQrPolling()
                setQr(null); setMsg('登录成功 ✅ 凭证只存在本机插件目录')
                load()
              } else if (!p.ok || p.status === 'expired' || p.status === 'unknown' || p.status === 'error') {
                stopQrPolling()
                setMsg(str(p.text) || '二维码过期了，重新点一次「生成二维码」')
              } else if (p.status === 'scanned') setMsg('扫到了，等你在手机上点确认')
            }, 3000)
          }
        } else setMsg(`生成二维码失败：${str(r.error)}`)
      }

      const logout = async (): Promise<void> => {
        setBusy('logout')
        await api('/logout', {})
        setBusy('')
        stopQrPolling()
        setQr(null)
        setMsg('已退出登录')
        load()
      }

      const openReport = async (day?: string): Promise<void> => {
        setBusy('report')
        const r = await api(`/report${day ? `?day=${day}` : ''}`)
        setBusy('')
        setReport(r)
        setTab('report')
      }
      const openSeen = async (): Promise<void> => {
        const r = await api('/seen')
        setSeen(r)
        setTab('seen')
      }

      if (!st) return h('div', { className: 'bsf-wrap' }, h('div', { className: 'bsf-card' }, '正在连插件…'))
      if (st.ok === false) {
        return h('div', { className: 'bsf-wrap' }, h('div', { className: 'bsf-card bsf-warnbox' },
          h('p', null, '插件后端没应答。看下 dsh 的启动日志里有没有 ',
            h('span', { className: 'bsf-mono' }, '[bili-surfer]'), ' 这一段。'),
          h('p', { className: 'bsf-mono' }, str(st.error)),
        ))
      }

      const fields = st.fields || []
      const d = draft || st.config || {}
      const running = Boolean(st.running)

      return h('div', { className: 'bsf-wrap' },
        /* ── 状态 + 操作 ── */
        h('div', { className: 'bsf-card' },
          h('p', { className: 'bsf-h' }, '刷 B 站（手动跑，无定时器）',
            h('span', { className: 'bsf-tag' }, `v${st.version || '?'}`),
            h('span', { className: `bsf-tag ${st.enabled ? 'bsf-ok' : 'bsf-warn'}` }, st.enabled ? '已启用' : '已停用'),
            h('span', { className: `bsf-tag ${st.loggedIn ? 'bsf-ok' : 'bsf-warn'}` }, st.loggedIn ? `已登录：${st.uname || st.mid || '?'}` : '未登录（只能读简介/弹幕）'),
          ),
          h('div', { className: 'bsf-kv' },
            h('b', null, '状态'), h('span', null, running ? `正在跑（${st.seconds}s）` : (st.lastRunAt ? `上一轮 ${new Date(st.lastRunAt).toLocaleString()}，入选 ${st.lastCount} 条` : '还没跑过')),
            h('b', null, '今天'), h('span', null, `${st.runsToday || 0} 轮 · 台账共 ${st.seenRows || 0} 条`),
            h('b', null, '家目录'), h('span', { className: 'bsf-mono' }, st.home || ''),
            h('b', null, '最近报告'), h('span', { className: 'bsf-mono' }, st.lastReport || '（还没有）'),
            h('b', null, '构建'), h('span', { className: 'bsf-mono' }, st.build || '旧构建（没有 build 字段，重启 dsh）'),
          ),
          h('div', { className: 'bsf-row', style: { marginTop: '12px' } },
            h('button', { className: 'bsf-btn bsf-primary', disabled: running || busy === 'run', onClick: run }, running ? '正在跑…' : '▶ 刷一轮'),
            h('button', { className: 'bsf-btn', disabled: busy === 'report', onClick: () => openReport() }, '看今天的报告'),
            h('button', { className: 'bsf-btn', onClick: openSeen }, '看台账'),
            h('button', { className: 'bsf-btn', disabled: busy === 'save' || !dirty, onClick: save }, dirty ? '保存设置 *' : '保存设置'),
          ),
          msg ? h('p', { style: { marginBottom: 0, opacity: .8 } }, msg) : null,
        ),

        /* ── 登录 ── */
        h('div', { className: `bsf-card ${st.loggedIn ? '' : 'bsf-warnbox'}` },
          h('p', { className: 'bsf-h' }, '账号',
            h('small', null, '不登录也能刷（只有简介+弹幕）；登录后才能读字幕/AI 摘要、发评论'),
          ),
          h('div', { className: 'bsf-row' },
            h('button', { className: 'bsf-btn bsf-primary', disabled: busy === 'login', onClick: startLogin }, qr ? '换一张二维码' : '扫码登录'),
            st.hasCredential ? h('button', { className: 'bsf-btn', disabled: busy === 'logout', onClick: logout }, '退出登录') : null,
            h('span', { className: 'bsf-note' }, st.hasCredential ? '凭证已保存（仅本机插件目录 credential.json）' : '没有凭证'),
          ),
          qr ? h('div', { className: 'bsf-qr' },
            h(QrCode, { rows: qr.rows }),
            h('div', { style: { flex: '1 1 200px' } },
              h('p', null, '手机 B 站 → 我的 → 扫一扫'),
              h('p', { className: 'bsf-note' }, '二维码几分钟就过期；扫完在这里等提示。'),
              h('p', { className: 'bsf-mono', style: { opacity: .5, wordBreak: 'break-all' } }, str(qr.url)),
            ),
          ) : null,
        ),

        /* ── 设置 ── */
        h('div', { className: 'bsf-card' },
          h('p', { className: 'bsf-h' }, '一轮怎么刷'),
          ...fields.map((f) => h(Field, { key: f.key, f, value: d[f.key], onChange: (v: unknown) => setField(f.key, v) })),
          h('p', { className: 'bsf-note', style: { marginTop: '10px' } },
            '读到的一切（标题/字幕/弹幕/评论）都只是素材，不会被当指令执行。'),
        ),

        /* ── 输出 ── */
        h('div', { className: 'bsf-card' },
          h('div', { className: 'bsf-tabs' },
            h('div', { className: `bsf-tab ${tab === 'config' ? 'bsf-on' : ''}`, onClick: () => setTab('config') }, '日志'),
            h('div', { className: `bsf-tab ${tab === 'report' ? 'bsf-on' : ''}`, onClick: () => setTab('report') }, '报告'),
            h('div', { className: `bsf-tab ${tab === 'seen' ? 'bsf-on' : ''}`, onClick: () => setTab('seen') }, '台账'),
          ),
          tab === 'config' ? h('pre', { className: 'bsf-pre' }, st.logTail || '（暂无日志）') : null,
          tab === 'report' ? h('div', null,
            // ⚠️ 「读失败」和「还没跑过」必须长得不一样：以前路由挂了也显示兜底那句，
            // 用户会以为是自己没点过，而不知道是读盘失败了。
            report && report.error ? h('p', { className: 'bsf-bad' }, `报告没读出来：${str(report.error)}`) : null,
            report && Array.isArray(report.reports) && (report.reports as string[]).length
              ? h('div', { className: 'bsf-row' }, (report.reports as string[]).map((day) => h('button', {
                key: day, className: `bsf-btn ${report.day === day ? 'bsf-primary' : ''}`,
                onClick: () => openReport(day),
              }, day)))
              : null,
            h('pre', { className: 'bsf-pre' }, str(report && report.text) || (report && report.error ? '' : '点上面的「看今天的报告」，或者先刷一轮')),
          ) : null,
          tab === 'seen' ? h('div', null,
            seen && seen.error ? h('p', { className: 'bsf-bad' }, `台账没读出来：${str(seen.error)}`) : null,
            h('pre', { className: 'bsf-pre' }, str(seen && seen.text) || (seen && seen.error ? '' : '点上面的「看台账」')),
          ) : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx: { effect: (fn: () => () => void, label?: string) => void; slots: { inject: (name: string, cb: () => void) => void; register: (spec: Record<string, unknown>, comp: unknown) => void } }) {
        ctx.effect(() => {
          const el = document.createElement('style')
          el.setAttribute('data-plugin-css', 'dsh-bili-surfer')
          el.textContent = CSS
          document.head.appendChild(el)
          return () => { try { el.remove() } catch (e) { /* 无所谓 */ } }
        }, 'bili-surfer: 设置页样式')

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'bili-surfer',
          order: 30,
          label: '刷B站',
        }, Panel))
      },
    }
  },
})
