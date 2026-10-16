// 一轮「自主冲浪」的编排：挑候选 → 读内容 → 出报告 →（可选）发评论。
// 所有外部依赖（clients、LLM 摘要器、日志）都由调用方注入，方便单测与降级。
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  newClient,
  whoami,
  searchVideos,
  videoInfo,
  fetchSubtitle,
  fetchAiSummary,
  fetchDanmaku,
  fetchComments,
  tags as fetchTags,
  popular,
  recommend,
  sendComment,
  isCommentVisible,
  sleep,
  fmtCount,
  fmtTime,
} from './bili.mjs'
import {
  DEFAULTS,
  normalize,
  readJson,
  writeJson,
  readText,
  writeText,
  appendLog,
  dayKey,
  ageDays,
  fmtAge,
  PLUGIN_ID,
} from './state.mjs'
import { SEEN_HEADER, SEEN_PATH_HINT, commentLine, parseSeen, seenRow, renderReport, stubReport } from './report.mjs'

export { newClient }

// ------------------------------------------------------------------ 挑选

/** 关键词命中：标题权重最高，其次标签/简介/分区。 */
function keywordHits(v, keywords) {
  const title = String(v.title || '')
  const blob = `${v.desc || ''} ${v.tag || ''} ${(v.tags || []).join(' ')} ${v.tname || ''}`
  let hits = 0
  const which = []
  for (const k of keywords) {
    const kw = String(k).trim()
    if (!kw) continue
    if (title.includes(kw)) {
      hits += 3
      which.push(kw)
    } else if (blob.includes(kw)) {
      hits += 1
      which.push(kw)
    }
  }
  return { hits, which }
}

/** 可解释的启发式打分：关键词 > 新鲜度 > 热度/互动率。 */
export function scoreCandidate(v, cfg) {
  const days = ageDays(v.pubdate)
  const { hits, which } = keywordHits(v, cfg.keywords)
  const fresh = days === null ? 0 : Math.max(0, 3 - days / 7)
  const play = Math.log10((Number(v.play) || 0) + 1) * 0.6
  const ratio = Number(v.play) > 1000 ? Math.min(2, (Number(v.danmaku) || 0) / Number(v.play) * 100) : 0
  const score = hits * 1.4 + fresh + play + ratio * 0.5
  const reasons = []
  if (which.length) reasons.push(`关键词命中 ${which.slice(0, 3).join('/')}`)
  if (days !== null && days <= 7) reasons.push(fmtAge(v.pubdate))
  if (Number(v.play) >= 10_000) reasons.push(`播放 ${fmtCount(v.play)}`)
  if (ratio >= 1) reasons.push('弹幕很热闹')
  return { score: Number(score.toFixed(3)), reasons, days }
}

const SKIP = {
  seen: '已看过',
  old: '超出时间窗',
  dup: '重复',
}

export async function gatherCandidates(cli, cfg, log = () => {}) {
  const stats = { candidates: 0, skipped: { [SKIP.seen]: 0, [SKIP.old]: 0, [SKIP.dup]: 0 } }
  const seen = loadSeen(cfg)
  let raw = []
  if (cfg.source === 'popular') {
    raw = await popular(cli, { num: 50 })
  } else if (cfg.source === 'recommend') {
    raw = await recommend(cli, { num: 30 })
  } else {
    const per = Math.max(8, Math.ceil((cfg.perDay * 3) / Math.max(1, cfg.keywords.length)))
    const bag = []
    for (const kw of cfg.keywords.slice(0, 5)) {
      try {
        const list = await searchVideos(cli, kw, { num: per, order: cfg.order })
        bag.push(...list)
        log(`搜索「${kw}」→ ${list.length} 条`)
      } catch (e) {
        log(`搜索「${kw}」失败：${e?.message || e}`)
      }
      await sleep(300)
    }
    raw = bag
  }

  const byId = new Map()
  for (const v of raw) {
    if (!v?.bvid) continue
    if (byId.has(v.bvid)) {
      stats.skipped[SKIP.dup] += 1
      continue
    }
    byId.set(v.bvid, v)
  }
  stats.candidates = byId.size

  const scored = []
  for (const v of byId.values()) {
    if (seen.has(v.bvid)) {
      stats.skipped[SKIP.seen] += 1
      continue
    }
    const days = ageDays(v.pubdate)
    if (days !== null && days > cfg.maxAgeDays) {
      stats.skipped[SKIP.old] += 1
      continue
    }
    const s = scoreCandidate(v, cfg)
    scored.push({ ...v, ...s })
  }
  scored.sort((a, b) => b.score - a.score)
  return { list: scored, stats, seen }
}

export function loadSeen(cfg) {
  try {
    return parseSeen(readText(seenFile(cfg)))
  } catch {
    return new Map()
  }
}

// ------------------------------------------------------------------ 读内容

/** 读到什么算什么：字幕 → AI 摘要 → 弹幕 → 简介。空不是错误。 */
export async function readItem(cli, v, cfg, log = () => {}) {
  const item = { ...v }
  const info = await videoInfo(cli, v.bvid)
  Object.assign(item, {
    aid: info.aid,
    cid: info.cid,
    title: info.title || item.title,
    desc: info.desc || item.desc || '',
    duration: info.duration || item.duration,
    pubdate: info.pubdate || item.pubdate,
    tname: info.tname,
    author: info.owner?.name || item.author,
    mid: info.owner?.mid || item.mid,
    stat: info.stat,
    play: info.stat?.view ?? item.play,
    danmaku: info.stat?.danmaku ?? item.danmaku,
    reply: info.stat?.reply ?? item.reply,
  })
  item.tags = await fetchTags(cli, v.bvid)

  if (cli.loggedIn) {
    try {
      const sub = await fetchSubtitle(cli, v.bvid, item.cid)
      if (sub?.lines?.length) {
        const text = sub.text.slice(0, cfg.excerptChars)
        item.subtitle = { lan: sub.lan, lanDoc: sub.lanDoc, ai: sub.ai, chars: sub.lines.length, text }
        log(`${v.bvid} 字幕 ${sub.lan}${sub.ai ? '（AI）' : ''}：${sub.lines.length} 行`)
      } else {
        log(`${v.bvid} 没有字幕轨（降级到 AI 摘要/弹幕）`)
      }
    } catch (e) {
      log(`${v.bvid} 字幕失败：${e?.message || e}`)
    }
  }

  if (!item.subtitle) {
    const ai = await fetchAiSummary(cli, v.bvid, item.cid, item.mid)
    if (ai?.summary) item.aiSummary = ai
  }

  if (cfg.readDanmaku && cfg.danmakuNum > 0) {
    try {
      const all = await fetchDanmaku(cli, item.cid, { num: cfg.danmakuNum })
      item.danmakuCount = all.length
      item.danmakuSample = pickDanmaku(all, 12)
      item.danmakuText = pickDanmaku(all, 40).join('\n')
    } catch (e) {
      log(`${v.bvid} 弹幕失败：${e?.message || e}`)
    }
  }

  if (cfg.readComments && cfg.commentNum > 0) {
    try {
      const cs = await fetchComments(cli, v.bvid, item.aid, { num: cfg.commentNum })
      item.commentsCount = cs.length
      if (!cs.length && (item.reply || 0) > 0) {
        // 「读到 0 条」和「这视频真没评论」是两件事，日志里要能分辨（风控/权限更常见）。
        log(`${v.bvid} 热评读到 0 条，但接口说共有 ${item.reply} 条（多半是风控或权限）`)
      }
      item.commentsSample = cs
        .filter((c) => c.message && c.message.length >= 4)
        .slice(0, 5)
        .map((c) => commentLine(c))
    } catch (e) {
      log(`${v.bvid} 评论失败：${e?.message || e}`)
    }
  }

  item.oneLiner = firstSentence(item.subtitle?.text || item.aiSummary?.summary || item.desc || item.danmakuSample?.[0] || '')
  item.why = item.reasons?.length ? item.reasons.join(' · ') : `按热度与新鲜度选中（播放 ${fmtCount(item.play)} · ${fmtAge(item.pubdate)}）`
  item.scoreText = `${item.score}（${item.why}）`
  return item
}

/** 弹幕里 90% 是「哈哈哈哈」「？？？」和复读，挑信息量大的：长、不重复、不是纯符号。 */
export function pickDanmaku(list, n) {
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const t = String(raw || '').trim()
    if (t.length < 6 || t.length > 60) continue
    if (/^[\d\s.。，,！!?？~～、哈啊哦嗯诶嘿嘻呵]+$/.test(t)) continue
    const key = t.slice(0, 8)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= n) break
  }
  if (out.length < n) {
    // 挑不出来就退回复读机，总比空着强
    for (const t of list) {
      if (out.length >= n) break
      if (String(t).trim().length >= 3 && !out.includes(String(t).trim())) out.push(String(t).trim())
    }
  }
  return out
}

export function firstSentence(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const m = /^(.{4,80}?[。！？!?；;])/.exec(t)
  return (m ? m[1] : t.slice(0, 60)).trim()
}

// ------------------------------------------------------------------ 一轮

export function paths(dir) {
  return {
    dir,
    outDir: join(dir, 'out'),
    logFile: join(dir, 'surf.log'),
    stateFile: join(dir, 'state.json'),
    cfgFile: join(dir, 'config.json'),
    seenFile: join(dir, 'seen.md'),
    credFile: join(dir, 'credential.json'),
  }
}

export const seenFile = (cfg) => cfg.__seenFile || join(cfg.__dir || process.cwd(), 'seen.md')

/** 从磁盘加载凭证（存在 <home>/credential.json）。 */
export function loadCredential(dir) {
  const f = join(dir, 'credential.json')
  const c = readJson(f, null)
  return c && c.sessdata ? c : null
}

export function saveCredential(dir, cred) {
  const f = join(dir, 'credential.json')
  // 退出登录 = 把 cookie 从盘上删掉，而不是留一个写着 null 的文件。
  if (!cred || !cred.sessdata) {
    try { rmSync(f, { force: true }) } catch { /* 本来就没有 */ }
    return null
  }
  return writeJson(f, cred)
}

/**
 * 跑一轮。
 * @param {{dir, cfg, log?, summarize?, commentWriter?, onProgress?}} opts
 */
export async function runRound({ dir, cfg: rawCfg, log = () => {}, summarize, commentWriter, round = 'manual' }) {
  const p = paths(dir)
  mkdirSync(p.outDir, { recursive: true })
  const day = dayKey()
  const cfg = normalize(rawCfg, DEFAULTS)
  cfg.__dir = dir
  cfg.__seenFile = p.seenFile
  const started = Date.now()
  const logLine = (m) => {
    log(m)
    appendLog(p.logFile, `[${new Date().toISOString()}] ${m}`)
  }

  // 台账必须先存在：模型/流程读不到它会以为「没记录」而重复推。
  if (!readText(p.seenFile)) writeText(p.seenFile, SEEN_HEADER)

  const cred = loadCredential(dir)
  const cli = newClient({ cookies: cred || undefined, logger: logLine })
  await cli.ensureBuvid()
  const me = await whoami(cli)
  logLine(`一轮开始（${round}）：登录=${me.loggedIn ? me.uname : '否'} 来源=${cfg.source} 关键词=${cfg.keywords.join('、')}`)

  const { list, stats, seen } = await gatherCandidates(cli, cfg, logLine)
  logLine(`候选 ${stats.candidates} 条，已排除 已看过 ${stats.skipped[SKIP.seen]} / 过期 ${stats.skipped[SKIP.old]} / 重复 ${stats.skipped[SKIP.dup]}`)

  const picked = list.slice(0, cfg.perDay)
  const items = []
  for (const v of picked) {
    try {
      const it = await readItem(cli, v, cfg, logLine)
      items.push(it)
      logLine(`读毕 ${it.bvid}（${it.subtitle ? '字幕' : it.aiSummary ? 'AI摘要' : it.danmakuSample?.length ? '弹幕' : '仅简介'}）：${it.title.slice(0, 40)}`)
    } catch (e) {
      stats.skipped['读取失败'] = (stats.skipped['读取失败'] || 0) + 1
      logLine(`读取失败 ${v.bvid}：${e?.message || e}`)
    }
    await sleep(600)
  }

  if (typeof summarize === 'function' && items.length) {
    try {
      const enriched = await summarize(items, cfg)
      if (Array.isArray(enriched)) {
        enriched.forEach((e, i) => {
          if (!items[i] || !e) return
          if (e.oneLiner) items[i].oneLiner = String(e.oneLiner).slice(0, 120)
          if (e.why) items[i].why = String(e.why).slice(0, 300)
        })
      }
    } catch (e) {
      logLine(`摘要器失败（忽略，用启发式）：${e?.message || e}`)
    }
  }

  // 评论：默认关（autoComment），没 @ 对象也不发；dryRun 时只演练不真发。
  const wantComment = Boolean(cfg.autoComment && cfg.mentionName)
  if (wantComment && typeof commentWriter === 'function') {
    if (cfg.dryRun) logLine('dryRun 开着 → 这一轮只演练评论，一个字都不会发出去')
    const target = items.slice(0, Math.max(1, Math.min(3, cfg.perDay)))
    for (const it of target) {
      try {
        const text = await commentWriter(it, cfg)
        const msg = normalizeComment(text, cfg)
        if (!msg) continue
        if (cfg.dryRun) {
          it.comment = { rpid: null, dryRun: true, message: msg }
          it.mentioned = cfg.mentionName
          logLine(`演练：本应评论 ${it.bvid}：${msg}`)
          continue
        }
        const r = await sendComment(cli, { aid: it.aid, text: msg })
        it.comment = { ...r, message: msg }
        it.rpid = r.rpid
        it.mentioned = cfg.mentionName
        const visible = await isCommentVisible(cli, it.aid, r.rpid)
        it.comment.visible = visible
        logLine(`已评论 ${it.bvid} rpid=${r.rpid} 可见性=${visible === null ? '没查到' : visible ? '可见' : '暂时不可见'}`)
        await sleep(1500)
      } catch (e) {
        logLine(`评论失败 ${it.bvid}：${e?.message || e}`)
      }
    }
  } else if (cfg.autoComment && !cfg.mentionName) {
    logLine('autoComment 开着但 mentionName 为空 → 不发评论（要 @ 就必须有名）')
  }

  const report = renderReport({ day, cfg, items, stats, generatedAt: new Date() })
  const reportPath = join(p.outDir, `${day}.md`)
  if (cfg.reportLevel !== 'off') writeText(reportPath, report)

  // 台账：本轮看过的都记，不只是入选的
  const ledgerRows = items.map((it) =>
    seenRow(it, {
      day,
      note: it.comment
        ? it.comment.dryRun
          ? '演练（没真发）'
          : `评论${it.comment.visible === false ? '(暂不可见)' : ''}`
        : '只读',
    }),
  )
  if (ledgerRows.length) {
    writeText(p.seenFile, readText(p.seenFile, SEEN_HEADER).replace(/\s*$/, '\n') + ledgerRows.join('\n') + '\n')
  }

  const state = readJson(p.stateFile, {})
  writeJson(p.stateFile, {
    ...state,
    lastRunAt: new Date().toISOString(),
    lastWhy: round,
    lastCount: items.length,
    lastCandidates: stats.candidates,
    lastReport: reportPath,
    day,
    runsToday: (state.day === day ? Number(state.runsToday || 0) : 0) + 1,
    seenTotal: seen.size + items.length,
  })

  logLine(`一轮结束：入选 ${items.length} 条，用时 ${((Date.now() - started) / 1000).toFixed(1)}s，报告 ${reportPath}`)
  return { ok: true, day, items, stats, report, reportPath, loginHint: me.loggedIn ? '' : '未登录：读不到字幕/AI 摘要，评论也发不出去（可在设置页扫码登录）' }
}

/** 把模型/模板给的评论文本收拾成合规的一条：限长、去 URL、必须 @ 人。 */
export function normalizeComment(text, cfg) {
  let t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  // 任何 scheme://…（不只是 http）都去掉：见过标题里带 `file:///C:/Users/…` 的视频，
  // 助手照抄进评论就是把本机路径贴到公开评论区。
  t = t.replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  const at = `@${cfg.mentionName}`
  if (cfg.mentionName && !t.includes(at)) t = `${at} ${t}`
  const max = Number(cfg.commentMax) || 150
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t
}

export { SEEN_PATH_HINT, stubReport, renderReport, PLUGIN_ID }
