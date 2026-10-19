// 共享类型：配置、凭证、条目、报告条目。运行时一行都不产生（只在编译期存在）。
//
// 约定：外部来的 JSON（B 站回包、HTTP body、盘上的 config.json）一律先当 `unknown`，
// 由各模块的 normalize/守卫函数收窄；类型断言只出现在「已经验过形状」的地方。

/** 设置页控件的种类（决定渲染什么，也决定 normalize 怎么过滤）。 */
export type FieldType = 'bool' | 'num' | 'list' | 'enum' | 'string'

/** `bili_surf_config` / `/status.fields` 里每个字段的元数据，client 靠它生成表单。 */
export interface FieldMeta {
  key: string
  type: FieldType
  label: string
  note?: string
  values?: readonly string[]
  min?: number
  max?: number
}

export type SourceKind = 'search' | 'popular' | 'recommend'
export type OrderKind = 'totalrank' | 'click' | 'pubdate' | 'dm' | 'stow'
export type ReportLevel = 'full' | 'brief' | 'off'

/** 配置的完整形状（DEFAULTS 是它的唯一真源）。 */
export interface SurfConfig {
  enabled: boolean
  keywords: string[]
  source: SourceKind
  order: OrderKind
  perDay: number
  maxAgeDays: number
  readDanmaku: boolean
  danmakuNum: number
  readComments: boolean
  commentNum: number
  excerptChars: number
  autoComment: boolean
  mentionName: string
  commentMax: number
  reportLevel: ReportLevel
  dryRun: boolean
}

export type ConfigKey = keyof SurfConfig

/** 盘上的凭证（cookie 名一律小写，发出去的时候由 net.mjs 的 COOKIE_ALIAS 映射）。 */
export interface Credential {
  sessdata?: string
  bili_jct?: string
  buvid3?: string
  dedeuserid?: string
  [k: string]: string | undefined
}

/** 一条视频的原始/半加工数据。B 站各接口字段不完全一致，所以宽容。 */
export interface VideoItem {
  bvid: string
  title: string
  author?: string
  mid?: number
  aid?: number
  cid?: number
  desc?: string
  duration?: number
  pubdate?: number
  tname?: string
  stat?: { view?: number; danmaku?: number; reply?: number; like?: number }
  play?: number
  danmaku?: number
  reply?: number
  tags?: string[]
  [k: string]: unknown
}

/** 内容是「靠什么读到的」——报告里会写出来，读者据此判断可信度。 */
export type ReadKind = '字幕' | 'AI 摘要' | '弹幕' | '仅简介'

export interface SubtitleBlock {
  lan: string
  lanDoc: string
  ai: boolean
  /** 字幕正文的**字数**（不是行数——以前填错过，报告里写成了「N 字」）。 */
  chars: number
  text: string
}

export interface AiSummaryBlock {
  summary: string
  /** 每条是「标题：要点；要点」这样拼好的整句（bili.ts 里 .map 出来的）。 */
  outline?: string[]
}

/** 发出去（或演练）的那条评论的结果，写进报告与台账。 */
export interface CommentResult {
  /** 演练时没有真发，这里是 null。 */
  rpid: string | null
  /** 真正发出去/写进报告的评论全文（已过 normalizeComment）。 */
  message: string
  visible?: boolean | null
  ctime?: number
  dryRun?: boolean
  error?: string
}

/** 一轮里挑中并读完的那条视频。 */
export interface Item {
  bvid: string
  title: string
  author?: string
  mid?: number
  aid?: number
  cid?: number
  desc?: string
  duration?: number
  pubdate?: number
  tname?: string
  stat?: { view?: number; danmaku?: number; reply?: number; like?: number }
  play?: number
  danmaku?: number
  reply?: number
  tags?: string[]
  score?: number
  scoreText?: string
  read?: ReadKind
  subtitle?: SubtitleBlock
  aiSummary?: AiSummaryBlock
  danmakuCount?: number
  danmakuSample?: string[]
  danmakuText?: string
  commentsCount?: number
  /** 已经过 `commentLine()` 拼好的「用户（N 赞）：内容」整句。 */
  commentsSample?: string[]
  comment?: CommentResult
  [k: string]: unknown
}

/** 台账里一行（seen.md 的解析结果）。 */
export interface SeenEntry {
  day: string
  title: string
  rpid?: string
  mentioned?: string
  note?: string
}

/** 一轮的结果概要（`bili_surf` 工具的返回值）。 */
export interface RoundResult {
  ok: boolean
  round: string
  day: string
  picked: number
  count: number
  reportPath: string
  reportChars: number
  pickedBvids: string[]
  candidates: number
  skipped: number
  loginHint: string
  seconds: number
  error?: string
}

export type LogFn = (msg: string) => void

/** `paths(dir)` 的返回值：状态目录里每个文件的位置。 */
export interface SurfPaths {
  dir: string
  outDir: string
  logFile: string
  stateFile: string
  cfgFile: string
  seenFile: string
  credFile: string
}
