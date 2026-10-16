// 状态与配置：家目录解析、JSON 读写、配置白名单化、日期工具。
// 一条铁律：所有落盘文件都住在 <DSH_HOME>/bili-surfer/ 下，绝不写插件包目录。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PLUGIN_ID = 'bili-surfer'
export const HOME_SUBDIR = 'bili-surfer'

export const DEFAULTS = Object.freeze({
  enabled: true,
  keywords: ['DeepSeek Harness', 'DSH 插件', 'dsh 教程'],
  source: 'search', // search | popular | recommend
  order: 'pubdate', // totalrank | click | pubdate | dm | stow
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
  reportLevel: 'full', // full | brief | off
  dryRun: true,
})

export const REPORT_LEVELS = ['full', 'brief', 'off']
export const SOURCES = ['search', 'popular', 'recommend']
export const ORDERS = ['totalrank', 'click', 'pubdate', 'dm', 'stow']

/**
 * 把任意外部对象（DSH settings 的 live config、HTTP body、文件内容）按默认值的类型过滤成一份可信配置。
 * 这是防「config 里混进对象/函数 → 使用时炸掉整个宿主」的唯一闸门。
 */
export function normalize(src, base = DEFAULTS) {
  const out = { ...base }
  if (!src || typeof src !== 'object') return out
  for (const [k, def] of Object.entries(base)) {
    const v = src[k]
    if (v === undefined || v === null) continue
    if (Array.isArray(def)) {
      if (Array.isArray(v)) {
        const arr = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
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
  if (!SOURCES.includes(out.source)) out.source = DEFAULTS.source
  if (!ORDERS.includes(out.order)) out.order = DEFAULTS.order
  if (!REPORT_LEVELS.includes(out.reportLevel)) out.reportLevel = DEFAULTS.reportLevel
  out.perDay = clamp(out.perDay, 1, 20)
  out.maxAgeDays = clamp(out.maxAgeDays, 1, 3650)
  out.danmakuNum = clamp(out.danmakuNum, 0, 2000)
  out.commentNum = clamp(out.commentNum, 0, 100)
  out.excerptChars = clamp(out.excerptChars, 0, 20_000)
  out.commentMax = clamp(out.commentMax, 10, 1000)
  out.mentionName = String(out.mentionName || '').replace(/^@+/, '').trim().slice(0, 40)
  return out
}

export function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.floor(v)))
}

/**
 * 解析 DSH 家目录。ctx.get('dshHomePath') 是**函数**（返回路径），旧版本/测试替身可能是字符串。
 * 两种形状都要支持 —— 当成字符串用过一次就会拿到函数源码，mkdir 直接 ENOENT。
 */
export function resolveHome(ctx) {
  let base = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') base = String(p() || '')
    else if (typeof p === 'string') base = p
  } catch {
    /* 忽略，走兜底 */
  }
  if (!base) base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return base
}

export function stateDirOf(ctx) {
  const dir = join(resolveHome(ctx), HOME_SUBDIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  return file
}

export function readText(file, fallback = '') {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : fallback
  } catch {
    return fallback
  }
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return file
}

export function appendLog(file, line) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    /* 日志写不进去也不能影响主流程 */
  }
}

/** 只取末尾 n 个字符 —— 设置页展示进度用，别把整份日志塞进 HTTP。 */
export function tail(file, n = 2000) {
  try {
    const s = readFileSync(file, 'utf8')
    return s.length > n ? s.slice(-n) : s
  } catch {
    return ''
  }
}

export function mtime(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 把插件自带的文件铺到家目录。overwrite=false 的文件（用户可改的章程）只在缺失时落一份。
 * 每次复制时比较内容，避免把用户的修改冲掉。
 */
export function ensureFiles(dir, specs) {
  const done = []
  for (const s of specs) {
    try {
      if (!existsSync(s.from)) continue
      const target = join(dir, s.to)
      const src = readFileSync(s.from, 'utf8')
      const cur = existsSync(target) ? readFileSync(target, 'utf8') : null
      if (cur === src) continue
      if (cur !== null && !s.overwrite) continue
      writeText(target, src)
      done.push(s.to)
    } catch {
      /* 单个文件失败不影响其它 */
    }
  }
  return done
}

/** 北京时间日期键 YYYY-MM-DD（b 站的「今天」按东八区算）。 */
export function dayKey(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

export function beijingNow() {
  return new Date(Date.now() + 8 * 3600_000)
}

export function fmtDateTime(ts) {
  const d = new Date(Number(ts) * 1000)
  if (!Number.isFinite(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ageDays(pubdate) {
  if (!pubdate) return null
  return Math.max(0, (Date.now() / 1000 - Number(pubdate)) / 86400)
}

export function fmtAge(pubdate) {
  const d = ageDays(pubdate)
  if (d === null) return '未知'
  if (d < 1) return '今天'
  if (d < 2) return '昨天'
  if (d < 30) return `${Math.floor(d)} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${(d / 365).toFixed(1)} 年前`
}
