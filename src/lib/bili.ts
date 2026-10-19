// B 站领域层：搜索 / 视频信息 / 字幕 / 弹幕 / 评论 / 登录 / 发评论。
// 只做「一个函数 = 一个业务动作」，不关心 DSH，也不碰磁盘。
import { BiliClient, BiliError } from './net.js'
import type { BiliClientOptions, Cookies } from './net.js'

const API = 'https://api.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 把搜索接口返回的 <em class="keyword">…</em> 标签去掉。 */
export const stripHtml = (s: unknown): string =>
  String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")

export function newClient(opts?: BiliClientOptions): BiliClient {
  return new BiliClient(opts)
}

/** 登录态探测的结果。未登录时 code=-101、loggedIn=false，但这不算失败。 */
export interface WhoAmI {
  loggedIn: boolean
  uname: string
  mid: number
  code: number | null
  message: string
}

/** 登录态探测：未登录也能拿到 wbi 密钥，返回 {loggedIn, uname, mid}。 */
export async function whoami(cli: BiliClient): Promise<WhoAmI> {
  // nav 未登录时 code=-101，这里走 tolerate 分支拿 data。
  const env = await cli.getJson(`${API}/x/web-interface/nav`, undefined, { tolerate: true })
  const nav = env.data as { isLogin?: boolean; uname?: string; mid?: number } | null
  return {
    loggedIn: Boolean(nav?.isLogin),
    uname: nav?.uname || '',
    mid: nav?.mid || 0,
    code: env.code,
    message: env.message || '',
  }
}

const ORDERS = new Set([
  'totalrank',
  'click',
  'pubdate',
  'dm',
  'stow',
  'scores',
  'attention',
])

/** 搜索/热门/推荐共用的一条视频概要（比详情少 owner/stat 子结构）。 */
export interface VideoBrief {
  bvid?: string
  aid?: number
  title: string
  author?: string
  mid?: number
  play?: number
  danmaku?: number
  reply?: number
  duration?: number
  pubdate?: number
  desc?: string
  tag?: string
  pic?: string
}

/** 搜索接口 result[] 里我们读的字段（其余字段不管）。 */
interface RawSearchItem {
  bvid?: string
  aid?: number
  title?: string
  author?: string
  mid?: number
  play?: number
  video_review?: number
  review?: number
  duration?: string | number
  pubdate?: number
  description?: string
  tag?: string
  pic?: string
}

export interface SearchOpts {
  num?: number
  order?: string
  page?: number
}

/** 关键词搜索视频。 */
export async function searchVideos(
  cli: BiliClient,
  keyword: string,
  { num = 10, order = 'totalrank', page = 1 }: SearchOpts = {},
): Promise<VideoBrief[]> {
  await cli.ensureBuvid()
  const n = Math.max(1, Math.min(50, Number(num) || 10))
  const o = ORDERS.has(order) ? order : 'totalrank'
  const per = 20
  const out: VideoBrief[] = []
  for (let p = page; out.length < n; p += 1) {
    const d = await cli.getJson<{ result?: RawSearchItem[] }>(`${API}/x/web-interface/search/type`, {
      search_type: 'video',
      keyword,
      page: p,
      order: o,
    })
    const list = Array.isArray(d?.result) ? d.result : []
    if (!list.length) break
    for (const v of list) {
      out.push({
        bvid: v.bvid,
        aid: v.aid,
        title: stripHtml(v.title),
        author: v.author,
        mid: v.mid,
        play: v.play,
        danmaku: v.video_review,
        reply: v.review,
        duration: parseDuration(v.duration), // 搜索接口给的是 "16:33" 字符串，统一成秒
        pubdate: v.pubdate,
        desc: stripHtml(v.description),
        tag: stripHtml(v.tag),
        pic: v.pic?.startsWith('//') ? `https:${v.pic}` : v.pic,
      })
    }
    if (list.length < per) break
    await sleep(400) // 搜索接口翻页别打太急
  }
  return out.slice(0, n)
}

/** 视频详情（多 P 视频的 pages 一并带回）。 */
export interface VideoDetail {
  bvid?: string
  aid?: number
  cid?: number
  title?: string
  desc: string
  duration?: number
  pubdate?: number
  tname?: string
  pic?: string
  pages: { cid?: number; page?: number; part?: string; duration?: number }[]
  owner: { mid?: number; name?: string }
  stat: {
    view?: number
    danmaku?: number
    reply?: number
    like?: number
    coin?: number
    favorite?: number
    share?: number
  }
}

interface RawView {
  bvid?: string
  aid?: number
  cid?: number
  title?: string
  desc?: string
  duration?: number
  pubdate?: number
  tname?: string
  pic?: string
  pages?: { cid?: number; page?: number; part?: string; duration?: number }[]
  owner?: { mid?: number; name?: string }
  stat?: Record<string, number | undefined>
}

/** 视频详情。多 P 视频返回第一 P 的 cid。 */
export async function videoInfo(cli: BiliClient, bvid: string): Promise<VideoDetail> {
  const d = await cli.getJson<RawView>(`${API}/x/web-interface/view`, { bvid })
  if (!d) throw new BiliError(`拿不到视频信息：${bvid}`)
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: d.title,
    desc: d.desc || '',
    duration: d.duration,
    pubdate: d.pubdate,
    tname: d.tname,
    pic: d.pic,
    pages: (d.pages || []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
    owner: { mid: d.owner?.mid, name: d.owner?.name },
    stat: {
      view: d.stat?.view,
      danmaku: d.stat?.danmaku,
      reply: d.stat?.reply,
      like: d.stat?.like,
      coin: d.stat?.coin,
      favorite: d.stat?.favorite,
      share: d.stat?.share,
    },
  }
}

export const SUBTITLE_PRIORITY: readonly string[] = ['zh-CN', 'zh-Hans', 'zh-Hant', 'ai-zh', 'zh', 'ai-en', 'en']

/** 字幕正文的一行（from/to 是秒）。 */
export interface SubtitleLine {
  from?: number
  to?: number
  text: string
}

/** 取到的字幕（正文已按段落拼好，lines 是原始行）。 */
export interface SubtitleRaw {
  lan: string
  lanDoc: string
  ai: boolean
  lines: SubtitleLine[]
  text: string
}

interface RawSubtitleMeta {
  lan?: string
  lan_doc?: string
  ai_status?: number
  subtitle_url?: string
}

/**
 * 取字幕正文。b 站把「人工字幕」和「AI 字幕」混在同一个列表里，
 * 未登录时通常一个都不返回（所以读不到字幕不一定是视频没字幕）。
 */
export async function fetchSubtitle(cli: BiliClient, bvid: string, cid: number): Promise<SubtitleRaw | null> {
  const d = await cli.getWbi<{ subtitle?: { subtitles?: RawSubtitleMeta[] } }>(`${API}/x/player/wbi/v2`, { bvid, cid })
  const subs = d?.subtitle?.subtitles || []
  if (!subs.length) return null
  const rank = (lan?: string): number => {
    const i = SUBTITLE_PRIORITY.indexOf(String(lan))
    return i === -1 ? 99 : i
  }
  const ranked = [...subs].sort((a, b) => rank(a.lan) - rank(b.lan))
  const pick = ranked[0]!
  const rawUrl = String(pick.subtitle_url || '').trim()
  const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
  if (!url) return null
  // 正文在 aisubtitle.hdslb.com 这个 CDN 上：auth_key 分钟级有效，**URL 尾部不能截断**
  // （截了就是 403），而且要带视频页 Referer。
  // ⚠️ 这个响应是**裸 JSON**（`{"body":[{from,to,location,content}]}`），没有 code/message 信封，
  // 所以不能走 getJson（它按 code===0 判定，会拿 undefined 当错误抛）——和弹幕 XML 一样直接读 body。
  const res = await cli.raw(url, { headers: { Referer: `https://www.bilibili.com/video/${bvid}` } })
  const raw = await res.text()
  let body: { body?: { from?: number; to?: number; content?: string }[]; data?: { body?: { content?: string }[] } }
  try {
    body = JSON.parse(raw) as typeof body
  } catch {
    throw new BiliError(`字幕正文不是 JSON（HTTP ${res.status}）：${raw.slice(0, 120)}`, res.status)
  }
  // 文档里的形状是裸 JSON；万一哪天套上了信封，也认 data.body。
  const arr = Array.isArray(body?.body) ? body.body : body?.data?.body
  if (!Array.isArray(arr)) {
    throw new BiliError(`字幕正文格式不对（HTTP ${res.status}）：${raw.slice(0, 120)}`, res.status)
  }
  const lines = (body?.body || []).map((l) => ({ from: l.from, to: l.to, text: String(l.content || '').trim() }))
  return {
    lan: String(pick.lan || ''),
    lanDoc: String(pick.lan_doc || ''),
    ai: Boolean(pick.ai_status) || /^ai-/.test(String(pick.lan)),
    lines,
    text: joinLines(lines),
  }
}

/** 字幕/弹幕/ASR 文本清洗：去重复行、去纯符号行、压掉时间戳噪音。 */
export function joinLines(lines: readonly { text?: string }[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of lines) {
    const t = String(l.text || '').trim()
    if (!t || /^[\s.,!?，。！？、~～…—-]+$/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  // 相邻短句合并成段落，方便读；每段 ~200 字。
  const paras: string[] = []
  let buf = ''
  for (const t of out) {
    if (buf && (buf + t).length > 200) {
      paras.push(buf)
      buf = ''
    }
    buf += t
    if (/[。！？!?]$/.test(t) && buf.length > 60) {
      paras.push(buf)
      buf = ''
    }
  }
  if (buf) paras.push(buf)
  return paras.join('\n')
}

/** AI 摘要（outline 是「标题：要点；要点」这样的整句）。 */
export interface AiSummaryRaw {
  summary: string
  outline: string[]
}

/** AI 视频摘要（需登录，未登录返回 -403）。拿不到就返回 null，别当失败。 */
export async function fetchAiSummary(
  cli: BiliClient,
  bvid: string,
  cid: number,
  upMid?: number,
): Promise<AiSummaryRaw | null> {
  try {
    const d = await cli.getWbi<{
      model_result?: { summary?: string; outline?: { title?: string; part_outline?: string[] }[] }
    }>(`${API}/x/web-interface/view/conclusion/get`, {
      bvid,
      cid,
      up_mid: upMid || 0,
    })
    const mr = d?.model_result
    const s = mr?.summary
    if (!s) return null
    return {
      summary: s,
      outline: (mr?.outline || []).map((o) => `${o.title}：${(o.part_outline || []).join('；')}`),
    }
  } catch {
    return null
  }
}

/** 弹幕（无需登录）。返回按时间排序的文本数组。 */
export async function fetchDanmaku(cli: BiliClient, cid: number, { num = 300 }: { num?: number } = {}): Promise<string[]> {
  const res = await cli.raw(`${API}/x/v1/dm/list.so?oid=${cid}`, { redirect: 'follow' })
  const xml = await res.text()
  const texts: string[] = []
  for (const m of xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
    const t = stripHtml(m[2]).trim()
    if (t) texts.push(t)
  }
  return texts.slice(0, Math.max(1, Math.min(2000, num)))
}

const REPLY_SORT: Record<string, number> = { hot: 2, time: 0 }

/** 一条评论（replies 是它下面的楼中楼）。 */
export interface BiliComment {
  rpid: string
  root: string
  user: string
  mid?: number
  message: string
  like?: number
  ctime?: number
  replies: { rpid: string; user: string; message: string; like?: number; ctime?: number }[]
}

interface RawReply {
  rpid?: number | string
  rpid_str?: string
  root?: number | string
  root_str?: string
  member?: { uname?: string }
  mid?: number
  content?: { message?: string }
  like?: number
  ctime?: number
  replies?: RawReply[]
}

const normReply = (r: RawReply): BiliComment => ({
  rpid: r.rpid_str || String(r.rpid),
  root: r.root_str || String(r.root || 0),
  user: r.member?.uname || '',
  mid: r.mid,
  message: r.content?.message || '',
  like: r.like,
  ctime: r.ctime,
  replies: (r.replies || []).map((x) => ({
    rpid: x.rpid_str || String(x.rpid),
    user: x.member?.uname || '',
    message: x.content?.message || '',
    like: x.like,
    ctime: x.ctime,
  })),
})

/**
 * 读评论。优先新接口（需登录），失败回退老接口（游客可读）。
 */
export async function fetchComments(
  cli: BiliClient,
  bvid: string,
  aid: number,
  { num = 30, sort = 'hot' }: { num?: number; sort?: string } = {},
): Promise<BiliComment[]> {
  const n = Math.max(1, Math.min(100, Number(num) || 30))
  const out: BiliComment[] = []
  try {
    let next = 0
    while (out.length < n) {
      const d = await cli.getWbi<{ replies?: RawReply[]; cursor?: { next?: number } }>(
        `${API}/x/v2/reply/wbi/main`,
        {
          oid: aid,
          type: 1,
          mode: sort === 'time' ? 2 : 3,
          next,
          ps: 20,
        },
      )
      const replies = d?.replies || []
      if (!replies.length) break
      for (const r of replies) out.push(normReply(r))
      next = d?.cursor?.next ?? 0
      if (!next) break
      await sleep(500)
    }
  } catch {
    out.length = 0
  }
  if (!out.length) {
    // 游客兜底：老接口 + sort=2（热度）
    const d = await cli.getJson<{ replies?: RawReply[] }>(`${API}/x/v2/reply`, {
      type: 1,
      oid: aid,
      sort: REPLY_SORT[sort] ?? 2,
      ps: Math.min(20, n),
      pn: 1,
    })
    for (const r of d?.replies || []) out.push(normReply(r))
  }
  return out.slice(0, n)
}

/** `sendComment` 的返回值。 */
export interface SentComment {
  rpid: string
  message: string
  ctime: number
}

/** 发一条评论（或回复）。root/parent 都为 0 时是主楼评论。 */
export async function sendComment(
  cli: BiliClient,
  { aid, text, root = 0, parent = 0 }: { aid: number; text: string; root?: number; parent?: number },
): Promise<SentComment> {
  if (!cli.loggedIn) throw new BiliError('没有登录，发不了评论')
  const msg = String(text || '').trim()
  if (!msg) throw new BiliError('评论内容为空')
  if (msg.length > 1000) throw new BiliError(`评论太长（${msg.length} > 1000）`)
  const d = await cli.postForm<{ reply?: RawReply }>(`${API}/x/v2/reply/add`, {
    oid: aid,
    type: 1,
    message: msg,
    root: root || 0,
    parent: parent || 0,
    plat: 1,
    ordering: 'heat',
  })
  const r = d?.reply
  return {
    rpid: r?.rpid_str || String(r?.rpid || ''),
    message: r?.content?.message || msg,
    ctime: r?.ctime || Math.floor(Date.now() / 1000),
  }
}

/**
 * 比对一个 rpid：b 站同时给 `rpid`（数字）与 `rpid_str`（字符串）。
 * 数字在大数上会被 JSON.parse 丢精度（rpid 是 int64），所以**优先用字符串**比对，
 * 否则「刚发的评论明明在列表里，却被判成不可见」。
 */
const sameRpid = (x: { rpid_str?: string; rpid?: number | string }, rpid: string | number): boolean => {
  const a = x?.rpid_str != null ? String(x.rpid_str) : String(x?.rpid ?? '')
  return a !== '' && a === String(rpid)
}

/** 新评论是否真的对公众可见（api 说成功 ≠ 别人看得见）。null = 不确定。 */
export async function isCommentVisible(
  cli: BiliClient,
  aid: number,
  rpid: string | number,
  { root = 0 }: { root?: number } = {},
): Promise<boolean | null> {
  try {
    if (root) {
      const d = await cli.getJson<{ replies?: RawReply[] }>(`${API}/x/v2/reply/reply`, { type: 1, oid: aid, root, ps: 20, pn: 1 })
      return (d?.replies || []).some((x) => sameRpid(x, rpid))
    }
    const d = await cli.getWbi<{ replies?: RawReply[]; top_replies?: RawReply[] }>(
      `${API}/x/v2/reply/wbi/main`,
      { oid: aid, type: 1, mode: 3, next: 0, ps: 20 },
    )
    const all = [...(d?.replies || []), ...((d?.top_replies || []) || [])]
    return all.some((x) => sameRpid(x, rpid))
  } catch {
    return null // 不确定 ≠ 没发出去
  }
}

interface RawPopularItem {
  bvid?: string
  aid?: number
  title?: string
  owner?: { mid?: number; name?: string }
  stat?: { view?: number; danmaku?: number; reply?: number }
  duration?: number
  pubdate?: number
  desc?: string
  pic?: string
}

export async function popular(cli: BiliClient, { num = 20 }: { num?: number } = {}): Promise<VideoBrief[]> {
  const d = await cli.getJson<{ list?: RawPopularItem[] }>(`${API}/x/web-interface/popular`, { ps: Math.min(50, num), pn: 1 })
  return (d?.list || []).map((v) => ({
    bvid: v.bvid,
    aid: v.aid,
    title: String(v.title ?? ''),
    author: v.owner?.name,
    mid: v.owner?.mid,
    play: v.stat?.view,
    danmaku: v.stat?.danmaku,
    reply: v.stat?.reply,
    duration: parseDuration(v.duration),
    pubdate: v.pubdate,
    desc: v.desc,
    pic: v.pic,
  }))
}

export async function recommend(cli: BiliClient, { num = 12 }: { num?: number } = {}): Promise<VideoBrief[]> {
  await cli.ensureBuvid()
  const d = await cli.getWbi<{ item?: RawPopularItem[] }>(`${API}/x/web-interface/wbi/index/top/feed/rcmd`, {
    fresh_type: 3,
    ps: Math.min(30, num),
    fresh_idx: 1,
    feed_version: 'V8',
    homepage_ver: 1,
    ps_ver: 'V8',
  })
  return (d?.item || [])
    .filter((v) => v.bvid)
    .map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: String(v.title ?? ''),
      author: v.owner?.name,
      mid: v.owner?.mid,
      play: v.stat?.view,
      danmaku: v.stat?.danmaku,
      reply: v.stat?.reply,
      duration: parseDuration(v.duration),
      pubdate: v.pubdate,
      desc: v.desc,
      pic: v.pic,
    }))
}

export async function tags(cli: BiliClient, bvid: string): Promise<string[]> {
  try {
    const d = await cli.getJson<{ tag_name?: string }[]>(`${API}/x/tag/archive/tags`, { bvid })
    return (d || []).map((t) => String(t.tag_name ?? ''))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- 扫码登录

export type QrStatus = 'waiting' | 'scanned' | 'expired' | 'ok' | 'error' | 'unknown'

const QR_STATE: Record<number, { status: QrStatus; text: string }> = {
  86101: { status: 'waiting', text: '等待扫码' },
  86090: { status: 'scanned', text: '已扫码，请在手机上确认' },
  86038: { status: 'expired', text: '二维码已过期' },
  0: { status: 'ok', text: '登录成功' },
}

/** `qrStart` 的返回值。 */
export interface QrTicket {
  url: string
  key: string
}

export async function qrStart(cli: BiliClient): Promise<QrTicket> {
  const d = await cli.getJson<{ url?: string; qrcode_key?: string }>(
    `${PASSPORT}/x/passport-login/web/qrcode/generate`,
    { source: 'main-fe-header' },
  )
  if (!d?.url || !d?.qrcode_key) throw new BiliError('拿不到登录二维码')
  return { url: d.url, key: d.qrcode_key }
}

/** `qrPoll` 的返回值：credentials 只在真拿到 SESSDATA 时存在，绝不回传给 HTTP。 */
export interface QrPollResult {
  status: QrStatus
  code: number | null
  text: string
  credentials?: Cookies
}

interface QrEnvelope {
  code?: number
  message?: string
  data?: { code?: number; message?: string }
}

/** 轮询扫码结果。凭证只从 Set-Cookie 里取（data.url 里的参数不全）。 */
export async function qrPoll(cli: BiliClient, key: string): Promise<QrPollResult> {
  const res = await cli.raw(
    `${PASSPORT}/x/passport-login/web/qrcode/poll?${new URLSearchParams({ qrcode_key: key, source: 'main-fe-header' })}`,
    {
      redirect: 'manual',
    },
  )
  const text = await res.text()
  let env: QrEnvelope = {}
  try {
    env = JSON.parse(text) as QrEnvelope
  } catch {
    /* 未扫码时偶尔返回空 body */
  }
  // ⚠️ passport 的回包有两层 code：外层恒为 0（"OK" = 这次请求本身没问题），
  // 真正的扫码状态在内层 `data.code`（86101 未扫 / 86090 已扫待确认 / 86038 过期 / 0 成功）。
  // 读外层就会**还没扫就说「登录成功」**——实测踩过（对着活着的进程打真实 passport 抓到的）。
  const inner = env?.data && typeof env.data === 'object' ? env.data.code : undefined
  const code = inner === undefined ? env?.code ?? null : inner
  const state = (code !== null ? QR_STATE[code] : undefined) || {
    status: 'unknown' as QrStatus,
    text: env?.data?.message || env?.message || `未知状态 ${code}`,
  }
  const cred = BiliClient.pickCredentials(cli.cookies)
  if (state.status === 'ok' && !cred?.sessdata) {
    // 状态说成功、但响应里没有 Set-Cookie：不能装作登录成功（否则设置页会显示已登录、
    // 而后面每一次读字幕/评论都静默降级成游客）。
    return { status: 'error', code, text: '登录接口说成功了，但没拿到凭证（响应里没有 Set-Cookie）', credentials: undefined }
  }
  return { ...state, code, credentials: cred }
}

// ---------------------------------------------------------------- 文本工具

/** 秒 → mm:ss（超过一小时 → h:mm:ss）。也容忍已经是 "16:33" 的字符串（原样返回）。 */
export function fmtTime(sec: unknown): string {
  let v = sec
  if (typeof v === 'string') {
    const t = v.trim()
    if (/^\d+(:\d{1,2}){1,2}$/.test(t)) return t // 搜索接口那种 "16:33"，别再算成 00:00
    if (t === '') return '—'
    v = Number(t)
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const s = Math.max(0, Math.floor(n))
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  if (s >= 3600) return `${Math.floor(s / 3600)}:${mm}:${ss}`
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${ss}`
}

/**
 * 时长统一成**秒**。
 * ⚠️ 两个接口给的形状不一样：搜索接口是字符串 `"16:33"`，详情接口是秒 `993`。
 * 不统一的话，凡是按秒格式化的地方（日报的「时长」、`bili_surf_search` 的输出）
 * 都会把它算成 NaN → 全部显示 `00:00`。踩过一次，是靠真调用工具看出来的。
 */
export function parseDuration(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0
  const t = String(v ?? '').trim()
  if (!t) return 0
  const parts = t.split(':')
  if (parts.length > 3) return 0
  const nums = parts.map((x) => Number(x))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return 0
  return nums.reduce((acc, n) => acc * 60 + n, 0)
}

/** 播放量/弹幕数 → 1.2万 */
export function fmtCount(n: unknown): string {
  const v = Number(n) || 0
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`
  return String(v)
}
