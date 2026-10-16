// 报告与台账的纯格式化层：给数据，出 Markdown。不联网、不读盘。
import { fmtAge, dayKey } from './state.mjs'
import { fmtCount, fmtTime } from './bili.mjs'

export const SEEN_HEADER = [
  '# 看过的视频台账（每行一条，别删表头）',
  '',
  '| 日期 | BV | 标题 | 评论 rpid | @ | 备注 |',
  '| --- | --- | --- | --- | --- | --- |',
  '',
].join('\n')

export const SEEN_PATH_HINT = '台账路径以本轮开头给的绝对路径为准'

/**
 * 热评在报告里的一行：`用户（N 赞）：正文`。
 * 正文超长要截断，但**必须留痕** —— 半句话不能长得像「这条评论就这么短」
 * （真在报告里见过 `…记两个入口和一条账：把`）。
 */
export function commentLine(c, max = 80) {
  const msg = String(c?.message ?? '').replace(/\s+/g, ' ').trim()
  return `${c?.user ?? '匿名'}（${fmtCount(c?.like ?? 0)} 赞）：${msg.length > max ? `${msg.slice(0, max)}…` : msg}`
}

/** 一行台账。标题里的 `|` 会破坏表格，先转义。 */
export function seenRow(item, { day = dayKey(), note = '' } = {}) {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)
  // rpid 正常挂在 item.comment 上（`it.rpid` 是老字段，留着兼容）；演练行没有 rpid。
  const rpid = item.rpid || item.comment?.rpid || ''
  return `| ${day} | ${item.bvid} | ${esc(item.title)} | ${rpid} | ${item.mentioned || ''} | ${esc(note)} |`
}

/** 已看过的 BV 集合。容忍用户手改过的台账（只认 BV 号）。 */
export function parseSeen(text) {
  // 标题与备注里的 `|` 会被 seenRow 转义成 `\|`，所以这两格要允许「反斜杠 + 任意字符」，
  // 否则多一列、后面所有格子都错位（BV 号仍对，但 rpid/@/备注 会串位）。
  const cell = '((?:[^|\\\\]|\\\\.)*)'
  const re = new RegExp(`\\|\\s*(\\d{4}-\\d{2}-\\d{2})\\s*\\|\\s*(BV[0-9A-Za-z]+)\\s*\\|${cell}\\|([^|]*)\\|([^|]*)\\|${cell}\\|`)
  const unesc = (s) => String(s ?? '').trim().replace(/\\(.)/g, '$1')
  const map = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = re.exec(line)
    if (!m) continue
    map.set(m[2], { day: m[1], title: unesc(m[3]), rpid: m[4].trim(), mentioned: m[5].trim(), note: unesc(m[6]) })
  }
  return map
}

const bullet = (label, value) => (value === undefined || value === null || value === '' ? null : `- **${label}**：${value}`)

/**
 * 渲染一份日报。
 * @param {{day, cfg, items, stats, generatedAt}} p
 */
export function renderReport({ day = dayKey(), cfg, items = [], stats = {}, generatedAt = new Date() }) {
  const level = cfg.reportLevel
  if (level === 'off') {
    return `# B 站冲浪日报 · ${day}\n\n> reportLevel=off：本轮不写正文。候选 ${stats.candidates ?? 0} 条，入选 ${items.length} 条。\n`
  }
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${generatedAt.getFullYear()}-${p(generatedAt.getMonth() + 1)}-${p(generatedAt.getDate())} ${p(generatedAt.getHours())}:${p(generatedAt.getMinutes())}`
  const out = []
  out.push(`# B 站冲浪日报 · ${day}`)
  out.push('')
  out.push(
    `> 来源 \`${cfg.source}\` ｜ 关键词 ${(cfg.keywords || []).join('、') || '（无）'} ｜ 入选 ${items.length}/${cfg.perDay} 条 ｜ 生成于 ${stamp}`,
  )
  out.push('')

  if (!items.length) {
    out.push('本轮没有挑到值得推的视频。')
    if (stats.why) out.push('', `原因：${stats.why}`)
    return out.join('\n') + '\n'
  }

  items.forEach((it, i) => {
    out.push(`## ${i + 1}. ${it.title}`)
    out.push('')
    out.push(
      [
        bullet('UP', it.author),
        bullet('数据', `播放 ${fmtCount(it.play)} · 弹幕 ${fmtCount(it.danmaku)} · 评论 ${fmtCount(it.reply)} · 时长 ${fmtTime(it.duration)}`),
        bullet('发布', fmtAge(it.pubdate)),
        bullet('分区', it.tname),
        bullet('标签', (it.tags || []).join(' / ')),
        bullet('链接', `<https://www.bilibili.com/video/${it.bvid}>`),
        bullet('打分', it.scoreText),
        bullet('一句话', it.oneLiner),
        bullet('为什么值得', it.why),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    out.push('')

    if (level === 'full') {
      const src = it.subtitle
        ? `字幕（${it.subtitle.lan}${it.subtitle.ai ? '，AI' : ''}，${it.subtitle.chars} 字）`
        : it.aiSummary
          ? 'AI 视频摘要'
          : it.danmakuText
            ? `弹幕节选（共 ${it.danmakuCount ?? 0} 条）`
            : '视频简介'
      // 摘录源就是弹幕时，「弹幕在聊什么」会和上面那段摘录逐行重复（两边都出自 pickDanmaku），
      // 只留一处 —— 摘录那小节的标题已经写了「弹幕节选（共 N 条）」。
      const excerptIsDanmaku = !it.subtitle && !it.aiSummary && !!it.danmakuText
      out.push(`**内容摘录**（${src}）`)
      out.push('')
      const raw = it.subtitle?.text || it.aiSummary?.summary || it.danmakuText || it.desc || '（没读到内容）'
      // 四个摘录来源共用一个上限：以前只有字幕那条路被 excerptChars 截过，
      // 简介和弹幕是全量进来的 —— 有的 UP 把整篇文章贴进简介，报告会被淹掉。
      const max = Number(cfg?.excerptChars) || 1200
      const body = raw.length > max ? `${raw.slice(0, max)}\n…（摘录到此，原文 ${raw.length} 字）` : raw
      out.push(
        body
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
      )
      out.push('')
      if (it.aiSummary?.outline?.length) {
        out.push('**AI 大纲**')
        out.push('')
        for (const o of it.aiSummary.outline) out.push(`- ${o}`)
        out.push('')
      }
      if (it.danmakuSample?.length && !excerptIsDanmaku) {
        out.push('**弹幕在聊什么**')
        out.push('')
        for (const d of it.danmakuSample) out.push(`- ${d}`)
        out.push('')
      }
      if (it.commentsSample?.length) {
        out.push('**热评**')
        out.push('')
        for (const c of it.commentsSample) out.push(`- ${c}`)
        out.push('')
      }
      if (it.comment) {
        out.push(
          it.comment.dryRun
            ? '**本轮评论**：演练 —— dryRun 开着，没真发（关掉 dryRun 就会发出去）'
            : `**本轮评论**：已发（rpid ${it.comment.rpid}${it.mentioned ? `，@ ${it.mentioned}` : ''}）`,
        )
        out.push('')
        out.push(`> ${it.comment.message}`)
        out.push('')
      }
    }
  })

  out.push('## 本轮小结')
  out.push('')
  out.push(`- 候选 ${stats.candidates ?? 0} 条 → 入选 ${items.length} 条`)
  if (stats.skipped) {
    for (const [reason, n] of Object.entries(stats.skipped)) {
      if (n) out.push(`- 跳过（${reason}）：${n} 条`)
    }
  }
  if (stats.loginHint) out.push(`- ${stats.loginHint}`)
  out.push(`- 读取不到字幕/摘要的条目已按「弹幕 + 简介」降级，不算失败`)
  out.push('')
  return out.join('\n')
}

/** 数据不够或整轮失败时垫底的一行，保证每天都有产出。 */
export function stubReport({ day = dayKey(), reason = '', logTail = '' }) {
  return [
    `# B 站冲浪日报 · ${day}`,
    '',
    '本轮没有产出正文。',
    '',
    reason ? `原因：${reason}` : '',
    '',
    logTail ? '```\n' + logTail.slice(-1500) + '\n```' : '',
    '',
  ].join('\n')
}
