// 状态与配置：家目录解析、JSON 读写、配置白名单化、日期工具。
// 一条铁律：所有落盘文件都住在 <DSH_HOME>/bili-surfer/ 下，绝不写插件包目录。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FieldMeta, OrderKind, ReportLevel, SourceKind, SurfConfig } from './types.js'

/**
 * 构建指纹：把插件源码的「文件清单 + 字节数 + mtime」揉成 8 位十六进制。
 * 为什么需要它：dsh 会在 profile 变化时**热挂**新 bundle，但 Node 的模块缓存不会跟着文件变，
 * 于是「设置页里出现了刷B站」≠「跑的是我刚改的代码」——踩过好几次。
 * `/status` 带上这个指纹，对着磁盘再算一遍就能一眼看出：跑的是新版本，还是某个旧构建。
 *
 * ⚠️ 默认只盖**宿主那一半**（index.js / lib/*.js / package.json）——那才是被 Node 模块缓存
 * 冻住、非重启不可的部分。client.js 是浏览器在页面加载时现取的，改它只需刷新页面（Ctrl+R），
 * 把它算进来只会让人因为「一个只改了 UI 的改动」去重启整个 dsh。
 *
 * ⚠️ `lib/*.js` 是 `tsc` 从 `src/lib/*.ts` 编出来的：改源码不重新 build，指纹算的还是旧产物 ——
 * 这是刻意的（跑的就是产物，指纹只该描述产物）。
 */
export function buildStamp(dir: string, files: readonly string[] = ['index.js', 'package.json']): string {
  try {
    const list = [...files]
    if (list.includes('index.js')) {
      for (const f of readdirSync(join(dir, 'lib'))) if (f.endsWith('.js')) list.push(`lib/${f}`)
    }
    const h = createHash('sha1')
    for (const f of list.sort()) {
      const st = statSync(join(dir, f))
      h.update(`${f}:${st.size}:${Math.floor(st.mtimeMs)}`)
    }
    return h.digest('hex').slice(0, 8)
  } catch {
    return ''
  }
}

export const PLUGIN_ID = 'bili-surfer'
export const HOME_SUBDIR = 'bili-surfer'

export const DEFAULTS: Readonly<SurfConfig> = Object.freeze({
  enabled: true,
  keywords: ['DeepSeek Harness', 'DSH 插件', 'dsh 教程'],
  source: 'search' as SourceKind, // search | popular | recommend
  order: 'pubdate' as OrderKind, // totalrank | click | pubdate | dm | stow
  perDay: 5,
  maxAgeDays: 30,
  readDanmaku: true,
  danmakuNum: 200,
  readComments: true,
  commentNum: 20,
  excerptChars: 1200,
  autoComment: false,
  mentionName: '',
  commentMax: 150,
  reportLevel: 'full' as ReportLevel, // full | brief | off
  dryRun: true,
})

export const REPORT_LEVELS: readonly ReportLevel[] = ['full', 'brief', 'off']
export const SOURCES: readonly SourceKind[] = ['search', 'popular', 'recommend']
export const ORDERS: readonly OrderKind[] = ['totalrank', 'click', 'pubdate', 'dm', 'stow']

/** 每个设置项在设置页里长什么样。index.ts 用它喂 `/status.fields`，client 靠它生成表单。 */
export const FIELDS: readonly FieldMeta[] = [
  { key: 'enabled', type: 'bool', label: '总开关', note: '关掉之后工具和设置页的「刷一轮」都拒绝执行' },
  { key: 'source', type: 'enum', values: SOURCES, label: '来源', note: 'search=按关键词搜 · popular=全站热门 · recommend=个性化推荐（要登录）' },
  { key: 'keywords', type: 'list', label: '关键词', note: 'source=search 时用，最多取前 5 个' },
  { key: 'order', type: 'enum', values: ORDERS, label: '搜索排序', note: 'pubdate=最新 · click=播放 · dm=弹幕 · totalrank=综合' },
  { key: 'perDay', type: 'num', min: 1, max: 20, label: '一轮几条' },
  { key: 'maxAgeDays', type: 'num', min: 1, max: 3650, label: '只要这么多天内的' },
  { key: 'readDanmaku', type: 'bool', label: '读弹幕', note: '游客也能读，是最稳的内容信号' },
  { key: 'danmakuNum', type: 'num', min: 0, max: 2000, label: '弹幕取多少条' },
  { key: 'readComments', type: 'bool', label: '读评论' },
  { key: 'commentNum', type: 'num', min: 0, max: 100, label: '评论取多少条' },
  { key: 'excerptChars', type: 'num', min: 0, max: 20000, label: '报告里正文摘录多少字' },
  { key: 'reportLevel', type: 'enum', values: REPORT_LEVELS, label: '报告详细度', note: 'full=带正文摘录 · brief=只列条目 · off=不写正文（台账照记）' },
  { key: 'autoComment', type: 'bool', label: '允许助手发评论 @ 我', note: '**默认关**。开了之后，助手在对话里跑一轮时才会挑一条发；评论文本永远由助手写，插件不会自己编' },
  { key: 'mentionName', type: 'string', label: '要 @ 的名字', note: '不带 @。留空 = 即使开了上面那个也绝不发' },
  { key: 'commentMax', type: 'num', min: 10, max: 1000, label: '评论最长多少字' },
  { key: 'dryRun', type: 'bool', label: '演练模式', note: '为真时评论只进报告与台账（写明「演练」），一个字都不发出去' },
]

/**
 * 把任意外部对象（DSH settings 的 live config、HTTP body、文件内容）按默认值的类型过滤成一份可信配置。
 * 这是防「config 里混进对象/函数 → 使用时炸掉整个宿主」的唯一闸门。
 *
 * 返回值是逐字段按 `DEFAULTS` 的类型重建出来的，所以这里的断言是「构造保证」而不是绕过检查。
 */
export function normalize(src: unknown, base: Readonly<SurfConfig> = DEFAULTS): SurfConfig {
  const out: Record<string, unknown> = { ...base }
  if (!src || typeof src !== 'object') return out as unknown as SurfConfig
  const from = src as Record<string, unknown>
  for (const [k, def] of Object.entries(base) as [string, unknown][]) {
    const v = from[k]
    if (v === undefined || v === null) continue
    if (Array.isArray(def)) {
      if (Array.isArray(v)) {
        const arr = v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
        if (arr.length) out[k] = arr
      }
      continue
    }
    if (typeof def === 'number') {
      const n = Number(v)
      if (Number.isFinite(n)) out[k] = n
      continue
    }
    if (typeof def === 'boolean') {
      if (typeof v === 'boolean') out[k] = v
      else if (v === 'true') out[k] = true
      else if (v === 'false') out[k] = false
      continue
    }
    if (typeof def === 'string') {
      if (typeof v === 'string') out[k] = v
      else if (typeof v === 'number') out[k] = String(v)
    }
  }
  // 枚举与范围钳制
  if (!SOURCES.includes(out.source as SourceKind)) out.source = DEFAULTS.source
  if (!ORDERS.includes(out.order as OrderKind)) out.order = DEFAULTS.order
  if (!REPORT_LEVELS.includes(out.reportLevel as ReportLevel)) out.reportLevel = DEFAULTS.reportLevel
  out.perDay = clamp(out.perDay, 1, 20)
  out.maxAgeDays = clamp(out.maxAgeDays, 1, 3650)
  out.danmakuNum = clamp(out.danmakuNum, 0, 2000)
  out.commentNum = clamp(out.commentNum, 0, 100)
  out.excerptChars = clamp(out.excerptChars, 0, 20_000)
  out.commentMax = clamp(out.commentMax, 10, 1000)
  out.mentionName = String(out.mentionName || '').replace(/^@+/, '').trim().slice(0, 40)
  return out as unknown as SurfConfig
}

export function clamp(n: unknown, lo: number, hi: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.floor(v)))
}

/** DSH 传给 apply 的 ctx 里我们真正用到的那一小块（别的一律不碰）。 */
export interface HostCtx {
  get?: (name: string) => unknown
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

/**
 * 解析 DSH 家目录。ctx.get('dshHomePath') 是**函数**（返回路径），旧版本/测试替身可能是字符串。
 * 两种形状都要支持 —— 当成字符串用过一次就会拿到函数源码，mkdir 直接 ENOENT。
 */
export function resolveHome(ctx: HostCtx | null | undefined): string {
  let base = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') base = String((p as () => unknown)() || '')
    else if (typeof p === 'string') base = p
  } catch {
    /* 忽略，走兜底 */
  }
  if (!base) base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return base
}

export function stateDirOf(ctx: HostCtx | null | undefined): string {
  const dir = join(resolveHome(ctx), HOME_SUBDIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, value: unknown): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  return file
}

export function readText(file: string, fallback = ''): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : fallback
  } catch {
    return fallback
  }
}

export function writeText(file: string, text: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return file
}

export function appendLog(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    /* 日志写不进去也不能影响主流程 */
  }
}

/** 只取末尾 n 个字符 —— 设置页展示进度用，别把整份日志塞进 HTTP。 */
export function tail(file: string, n = 2000): string {
  try {
    const s = readFileSync(file, 'utf8')
    return s.length > n ? s.slice(-n) : s
  } catch {
    return ''
  }
}

export function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** `ensureFiles` 的每个待铺文件：从哪来、到哪去、能不能覆盖。 */
export interface FileSpec {
  from: string
  to: string
  overwrite?: boolean
}

/** `ensureFiles` 真正动过的文件与动作（pending = 没覆盖，新版落成了 `<名字>.new`）。 */
export interface FileTouched {
  to: string
  action: 'created' | 'updated' | 'pending'
}

/**
 * 把插件自带的文件铺到家目录。overwrite=false 的文件（用户可改的章程）只在缺失时落一份。
 * 每次复制时比较内容，避免把用户的修改冲掉。
 *
 * 返回每次真正动过的文件：`[{ to, action }]`，action 是 created / updated / pending。
 * `pending` = 家目录里那份和插件里的不一样（多半是用户改过），**没覆盖**，而是把插件的新版
 * 摆到 `<名字>.new` 旁边 —— 不然「插件升级了章程」这件事会静默消失。
 */
export function ensureFiles(dir: string, specs: readonly FileSpec[]): FileTouched[] {
  const done: FileTouched[] = []
  for (const s of specs) {
    try {
      if (!existsSync(s.from)) continue
      const target = join(dir, s.to)
      const src = readFileSync(s.from, 'utf8')
      const cur = existsSync(target) ? readFileSync(target, 'utf8') : null
      if (cur === src) continue
      if (cur !== null && !s.overwrite) {
        const side = `${target}.new`
        if (!existsSync(side) || readFileSync(side, 'utf8') !== src) writeText(side, src)
        done.push({ to: s.to, action: 'pending' })
        continue
      }
      writeText(target, src)
      done.push({ to: s.to, action: cur === null ? 'created' : 'updated' })
    } catch {
      /* 单个文件失败不影响其它 */
    }
  }
  return done
}

/** 北京时间日期键 YYYY-MM-DD（b 站的「今天」按东八区算）。 */
export function dayKey(d: Date = new Date()): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

export function beijingNow(): Date {
  return new Date(Date.now() + 8 * 3600_000)
}

export function fmtDateTime(ts: unknown): string {
  const d = new Date(Number(ts) * 1000)
  if (!Number.isFinite(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ageDays(pubdate: unknown): number | null {
  if (!pubdate) return null
  return Math.max(0, (Date.now() / 1000 - Number(pubdate)) / 86400)
}

export function fmtAge(pubdate: unknown): string {
  const d = ageDays(pubdate)
  if (d === null) return '未知'
  if (d < 1) return '今天'
  if (d < 2) return '昨天'
  if (d < 30) return `${Math.floor(d)} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${(d / 365).toFixed(1)} 年前`
}
