/**
 * selfcheck.mjs —— 离线预检（不联网、不碰真实家目录）
 * ============================================================================
 * 为什么需要它：这个插件跑在别人的 dsh 进程里，**激活失败是静默的**（只剩一句
 * `1 entry did not activate`），而工具 schema 写错、二维码画错、配置里混进非标量
 * 都是「上线才炸」的类型。所以这里用假 ctx + 假 DOM 把能验的都验一遍：
 *
 *   A. 二维码编码器：格式/版本信息的**真值**、RS 纠错的**综合校验**、数据模块的**往返解码**
 *   B. state/report/surf/net/tools 的纯函数行为
 *   C. 宿主半端：用假 ctx 真跑 apply()，再打一次 /api/bili-surfer/status
 *   D. 源码不变式：不许裸 import @deepseek-ai/*、不许常驻定时器、client.js 必须是经典脚本
 *
 * 跑法：node selfcheck.mjs      （需要联网的另有两个：selfcheck.live.mjs / selfcheck.round.mjs）
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

import {
  DEFAULTS, appendLog, clamp, dayKey, ensureFiles, fmtAge, mtime, normalize,
  readJson, readText, resolveHome, stateDirOf, tail, writeJson, writeText,
} from './lib/state.js'
import { BiliClient, mixinKey, signWbi, UA } from './lib/net.js'
import {
  fetchAiSummary, fetchComments, fetchSubtitle, fmtCount, fmtTime, isCommentVisible, newClient,
  parseDuration, searchVideos, sendComment, stripHtml,
} from './lib/bili.js'
import {
  firstSentence, normalizeComment, paths, pickDanmaku, runRound, saveCredential, scoreCandidate,
} from './lib/surf.js'
import { commentLine, parseSeen, renderReport, seenRow, stubReport } from './lib/report.js'
import { assertObjectNodes, compileParams, defineTool, safe, textOutput } from './lib/tools.js'
import { qrMatrix, __test as qrt } from './lib/qr.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const results = []
let currentSection = ''

function section(title) {
  currentSection = title
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`)
}
function check(name, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('断言返回 false')
    results.push({ ok: true, name, section: currentSection })
    console.log(`  ✓ ${name}`)
  } catch (e) {
    results.push({ ok: false, name, section: currentSection, err: String(e?.message || e) })
    console.log(`  ✗ ${name}\n      ${e?.message || e}`)
  }
}
async function checkAsync(name, fn) {
  try {
    const r = await fn()
    if (r === false) throw new Error('断言返回 false')
    results.push({ ok: true, name, section: currentSection })
    console.log(`  ✓ ${name}`)
  } catch (e) {
    results.push({ ok: false, name, section: currentSection, err: String(e?.message || e) })
    console.log(`  ✗ ${name}\n      ${e?.message || e}`)
  }
}
const eq = (a, b, what = '') => {
  if (a !== b) throw new Error(`${what} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg || '条件不成立') }
const hex = (n) => '0x' + n.toString(16).toUpperCase()

/* ══════════════════════════════════════════════════════════════════ A. 二维码 */
section('A. 二维码编码器（真值 / 综合校验 / 往返解码）')

check('GF(256) 指数对数表自洽（EXP[LOG[x]] === x）', () => {
  for (let x = 1; x < 256; x++) eq(qrt.EXP[qrt.LOG[x]], x, `x=${x}`)
})

check('格式信息 = 标准真值 0x5412 / 0x5125 / 0x5E7C / 0x5B4B / 0x45F9 / 0x40CE / 0x4F97 / 0x4AA0（ECC=M）', () => {
  const want = [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0]
  want.forEach((w, mask) => eq(qrt.formatBits(mask), w, `mask=${mask}`))
})

check('版本信息 = 标准真值 7:0x07C94 8:0x085BC 9:0x09A99 10:0x0A4D3', () => {
  eq(qrt.versionBits(7), 0x07C94); eq(qrt.versionBits(8), 0x085BC)
  eq(qrt.versionBits(9), 0x09A99); eq(qrt.versionBits(10), 0x0A4D3)
  eq(qrt.formatBits(0) ^ 0x5412, 0, 'format 0')
})

// 完全独立地重建 GF(256)（本原多项式 0x11D），用来对 rsEC 的结果做综合校验。
check('RS 纠错：每块的 α^0..α^(ec-1) 综合量全为 0', () => {
  const EXP2 = new Uint8Array(512); const LOG2 = new Uint8Array(256)
  for (let i = 0, x = 1; i < 255; i++, x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)) { EXP2[i] = x; LOG2[x] = i }
  for (let i = 255; i < 512; i++) EXP2[i] = EXP2[i - 255]
  const mul = (a, b) => (a && b ? EXP2[LOG2[a] + LOG2[b]] : 0)
  const syndromes = (poly, n) => {
    const out = []
    // qr.mjs 的 genPoly(deg) = ∏(x + α^i), i = 0..deg-1 —— 生成多项式的根是 α^0..α^(ec-1)，
    // 综合量必须按同一组根求值（写成 α^1..α^ec 会差一个偏移，前 ec-1 个碰巧还是 0）。
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (const c of poly) acc = mul(acc, EXP2[i]) ^ c
      out.push(acc)
    }
    return out
  }
  // 阶数要够：ec=10 → 用 16 字节数据
  for (const data of [[1, 2, 3, 4, 5], [255, 0, 128, 64, 32, 16, 8, 4], [[...Array(20).keys()].map((x) => x * 7 & 0xff)]]) {
    for (const ec of [7, 10, 13, 17, 22]) {
      const buf = Uint8Array.from(data.flat ? data.flat() : data)
      const e = qrt.rsEC(buf, ec)
      eq(e.length, ec, 'ec 长度')
      const synd = syndromes([...buf, ...e], ec)
      ok(synd.every((s) => s === 0), `ec=${ec} 综合量应为全 0，实际 ${synd.join(',')}`)
    }
  }
})

/**
 * ECC 等级 M 的分块表（版本 1–20）：[总数据码字, 每块纠错码字, [[块数, 每块数据码字], ...]]
 * 这份是**为了验证 qr.mjs 而重新誊写一遍**的，不从 qr.mjs 导入 —— 表抄错了这里就会红。
 */
const QR_ECC_M = [
  null,
  [16, 10, [[1, 16]]], [28, 16, [[1, 28]]], [44, 26, [[1, 44]]], [64, 18, [[2, 32]]],
  [86, 24, [[2, 43]]], [108, 16, [[4, 27]]], [124, 18, [[4, 31]]], [154, 22, [[2, 38], [2, 39]]],
  [182, 22, [[3, 36], [2, 37]]], [216, 26, [[4, 43], [1, 44]]], [254, 30, [[1, 50], [4, 51]]],
  [290, 22, [[6, 36], [2, 37]]], [334, 22, [[8, 37], [1, 38]]], [365, 24, [[4, 40], [5, 41]]],
  [415, 24, [[5, 41], [5, 42]]], [453, 28, [[7, 45], [3, 46]]], [507, 28, [[10, 46], [1, 47]]],
  [563, 26, [[9, 43], [4, 44]]], [627, 26, [[3, 44], [11, 45]]], [669, 26, [[3, 41], [13, 42]]],
]

check('分块表与几何自洽：码字总数 = 数据 + 纠错×块数，且刚好填满非功能模块', () => {
  let prev = 0
  for (let v = 1; v <= 20; v++) {
    const [dataWords, ecLen, groups] = QR_ECC_M[v]
    const blocks = groups.reduce((n, [cnt]) => n + cnt, 0)
    const sum = groups.reduce((n, [cnt, per]) => n + cnt * per, 0)
    eq(sum, dataWords, `v${v} 数据码字数`)
    ok(dataWords > prev, `v${v} 容量必须递增`)
    prev = dataWords
    // 矩阵里剩下的模块数（floor 到整字节）必须等于 数据+纠错
    const free = qrt.makeMatrix(v).fixed.flat().filter((x) => !x).length
    eq(Math.floor(free / 8), dataWords + ecLen * blocks, `v${v} 码字总数 vs 剩余模块`)
  }
})

/**
 * 往返解码：按 QR 规范从右往左两列一"条"地读数据模块，解掩码，**按分块表反交织**，再解析位流。
 * 这段是**独立实现**（不调用 qr.mjs 的 placeData/encodeData/interleave），所以它能证伪
 * 放置 / 掩码 / 编码 / 分块 / 交织 里任何一环。
 */
function decodeQr(text) {
  const q = qrMatrix(text)
  const { size, modules: m0, version, mask } = q
  const fixed = qrt.makeMatrix(version).fixed
  const masks = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ]
  const m = m0.map((row) => row.slice())
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (!fixed[r][c] && masks[mask](r, c)) m[r][c] ^= 1
  }
  // 读格式信息（两份）
  const rd1 = []
  for (let i = 0; i <= 5; i++) rd1[i] = m[8][i]
  rd1[6] = m[8][7]; rd1[7] = m[8][8]; rd1[8] = m[7][8]
  for (let i = 9; i <= 14; i++) rd1[i] = m[14 - i][8]
  // 两种位序都要：格式信息按「value 的 bit i 写在位置 i」写下去，读回是 LSB-first；
  // 码字字节是数据流的 MSB-first。混用会得到 mode=0 这类假失败。
  const lsb = (bits) => bits.reduce((acc, b, i) => acc | ((b & 1) << i), 0)
  const msb = (bits) => bits.reduce((acc, b) => (acc << 1) | (b & 1), 0)
  const fmt1 = lsb(rd1)
  const rd2 = []
  for (let i = 0; i <= 7; i++) rd2[i] = m[8][size - 1 - i]
  for (let i = 8; i <= 14; i++) rd2[i] = m[size - 15 + i][8]
  const fmt2 = lsb(rd2)

  // 走之字形取数据位
  const bits = []
  let col = size - 1
  let up = true
  while (col > 0) {
    if (col === 6) col-- // 竖直时序列不参与
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i
      for (const c of [col, col - 1]) if (!fixed[row][c]) bits.push(m[row][c])
    }
    col -= 2
    up = !up
  }
  // 位 → 交织后的码字流
  const stream = []
  for (let i = 0; i + 8 <= bits.length; i += 8) stream.push(msb(bits.slice(i, i + 8)))
  // 反交织：数据段按块轮流取，纠错段同理
  const [dataWords, ecLen, groups] = QR_ECC_M[version]
  const shapes = groups.flatMap(([cnt, per]) => Array.from({ length: cnt }, () => per))
  const blocks = shapes.map((per) => ({ data: new Array(per), ec: new Array(ecLen) }))
  let p = 0
  const maxData = Math.max(...shapes)
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) b.data[i] = stream[p++]
  for (let i = 0; i < ecLen; i++) for (const b of blocks) b.ec[i] = stream[p++]
  ok(p === stream.length, '反交织应当刚好用完所有码字')
  const data = blocks.flatMap((b) => b.data)
  eq(data.length, dataWords, '数据码字数')
  // 位流解析（数据码字按块顺序拼回去）
  const dataBits = []
  for (const b of data) for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1)
  const mode = msb(dataBits.slice(0, 4))
  const countBits = version <= 9 ? 8 : 16
  const dataStart = 4 + countBits
  const count = msb(dataBits.slice(4, dataStart))
  // ⚠️ 字节模式是**位打包**的：4 位模式 + 8/16 位长度 = 12/20 位，正文并不从字节边界开始，
  // 必须从位流偏移 dataStart 处按 8 位一组重拼（按字节切会得到 "T\xNN T…" 这种乱码）。
  const payloadBits = dataBits.slice(dataStart, dataStart + count * 8)
  const payload = []
  for (let i = 0; i + 8 <= payloadBits.length; i += 8) payload.push(msb(payloadBits.slice(i, i + 8)))
  return { q, fmt1, fmt2, mode, count, blocks, text: Buffer.from(payload).toString('utf8'), dark: m[size - 8][8] }
}

check('往返解码：ASCII 短串 / 中文 / 真实登录 URL / 长 URL（多块 + 16 位长度）都能原样读回', () => {
  const samples = [
    'HELLO',
    'DSH 自主刷B站 · 二维码自检',
    'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&from=-1&qrcode_key=2f2b6c3f7d9e4a1b8c0d5e6f7a8b9c0d&only_QR=1',
    // 200+ 字节：逼到版本 10 以上，才能覆盖 16 位长度字段与多块交织
    'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&from=-1&only_QR=1&qrcode_key=' + 'a1b2c3d4e5f60718'.repeat(8),
    '中'.repeat(120),
  ]
  for (const s of samples) {
    const d = decodeQr(s)
    const tag = `「${s.slice(0, 12)}…」v${d.q.version}`
    eq(d.mode, 4, `${tag} 的模式应为字节模式`)
    eq(d.count, Buffer.byteLength(s), `${tag} 长度字段`)
    eq(d.text, s, `${tag} 往返文本`)
    eq(d.fmt1, qrt.formatBits(d.q.mask), '格式信息第一份')
    eq(d.fmt2, qrt.formatBits(d.q.mask), '格式信息第二份')
    eq(d.dark, 1, '暗模块必须为 1')
    eq(d.q.size, d.q.modules.length, 'size 与矩阵一致')
    eq(d.q.size, 17 + 4 * d.q.version, 'size = 17 + 4×版本')
  }
})

check('结构：三个定位图案 + 时序图案', () => {
  const { size, modules: m } = qrMatrix('https://passport.bilibili.com/x')
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        const want = edge || core ? 1 : 0
        eq(m[r0 + r][c0 + c], want, `定位图案 (${r0 + r},${c0 + c})`)
      }
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0)
  for (let i = 8; i < size - 8; i++) {
    eq(m[6][i], i % 2 === 0 ? 1 : 0, `横向时序 ${i}`)
    eq(m[i][6], i % 2 === 0 ? 1 : 0, `竖向时序 ${i}`)
  }
})

check('确定性：同输入两次一致，不同输入不同', () => {
  const a = qrMatrix('https://passport.bilibili.com/x').modules.map((r) => r.join('')).join('')
  const b = qrMatrix('https://passport.bilibili.com/x').modules.map((r) => r.join('')).join('')
  const c = qrMatrix('https://passport.bilibili.com/y').modules.map((r) => r.join('')).join('')
  eq(a, b, '同输入'); ok(a !== c, '不同输入应当不同')
})

check('超长内容会抛（不静默截断）', () => {
  let threw = false
  try { qrMatrix('x'.repeat(2000)) } catch { threw = true }
  ok(threw, '两千字符应当装不下并抛异常')
})

check('qrMatrix 返回的 mask 在 0–7 之间、version 在 1–20 之间', () => {
  const q = qrMatrix('x'.repeat(300))
  ok(q.mask >= 0 && q.mask <= 7, `mask=${q.mask}`)
  ok(q.version >= 1 && q.version <= 20, `version=${q.version}`)
})

/* ═══════════════════════════════════════════════════════════════ B. 纯函数 */
section('B. 配置 / 状态 / 报告 / 域名动作 / 工具契约（纯函数）')

check('normalize：非标量一律丢弃，枚举回退，范围钳制，mentionName 去 @', () => {
  const evil = {
    enabled: 'yes-please', perDay: 999, maxAgeDays: -5, source: 'hack', order: {}, reportLevel: () => {},
    keywords: ['  好好  ', 42, null, 'ok'], mentionName: '@@某人  ', commentMax: 3, danmakuNum: 'abc',
    dryRun: 'false', excerptChars: { nope: 1 },
  }
  const c = normalize(evil, DEFAULTS)
  eq(c.enabled, DEFAULTS.enabled, '非布尔 → 保持默认（字符串 "yes-please" 不是 true/false）')
  eq(c.perDay, 20, 'perDay 上限')
  eq(c.maxAgeDays, 1, 'maxAgeDays 下限')
  eq(c.source, 'search', '非法枚举 → 默认')
  eq(c.order, 'pubdate', 'order 是对象 → 默认')
  eq(c.reportLevel, 'full', 'reportLevel 是函数 → 默认')
  eq(c.dryRun, false, '字符串 "false" → false')
  eq(c.keywords.join('|'), '好好|ok', '数组里只留非空字符串并 trim')
  eq(c.mentionName, '某人', '去掉 @ 与空白')
  eq(c.commentMax, 10, 'commentMax 下限')
  eq(c.danmakuNum, DEFAULTS.danmakuNum, '非数字 → 默认')
  eq(c.excerptChars, DEFAULTS.excerptChars, '对象 → 默认')
})

check('normalize(undefined) / normalize(null) 都返回完整默认值', () => {
  for (const v of [undefined, null, 'str', 7]) {
    const c = normalize(v, DEFAULTS)
    eq(Object.keys(c).length, Object.keys(DEFAULTS).length, '字段数')
    eq(c.perDay, DEFAULTS.perDay, 'perDay')
  }
})

check('clamp 边界与非数字', () => {
  eq(clamp(5, 1, 10), 5); eq(clamp(0, 1, 10), 1); eq(clamp(99, 1, 10), 10)
  eq(clamp('x', 2, 10), 2); eq(clamp(7.9, 1, 10), 7)
})

check('dayKey 是北京时间、格式 YYYY-MM-DD', () => {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(dayKey()), dayKey())
  // 北京 00:30 属于当天，而不是 UTC 的前一天
  const t = new Date('2026-03-01T16:30:00Z') // 北京 2026-03-02 00:30
  eq(dayKey(t), '2026-03-02', '跨时区日期')
})

check('fmtAge：今天 / 昨天 / 天前 / 个月前 都有可读输出', () => {
  const now = Math.floor(Date.now() / 1000)
  eq(fmtAge(now), '今天')
  eq(fmtAge(now - 7200), '今天', '两小时前也还是「今天」（ageDays 以天为单位）')
  ok(fmtAge(now - 86400 * 3).includes('3'), fmtAge(now - 86400 * 3))
  ok(fmtAge(now - 86400 * 40).includes('个月'), fmtAge(now - 86400 * 40))
  eq(fmtAge(0), '未知')
})

check('fmtCount / fmtTime / stripHtml 的输出形状', () => {
  eq(fmtCount(999), '999'); ok(fmtCount(12345).includes('万'), fmtCount(12345))
  eq(fmtTime(90), '01:30'); eq(fmtTime(3725), '1:02:05')
  eq(stripHtml('<em class="keyword">DeepSeek</em> 插件'), 'DeepSeek 插件')
})

check('时长：搜索接口给 "16:33" 字符串、详情接口给秒，必须统一成秒（否则日报全是 00:00）', () => {
  // 真值来自真接口：搜索 result[].duration = "16:33"（string），view.duration = 993（number）
  eq(parseDuration('16:33'), 993, '搜索接口的字符串')
  eq(parseDuration('1:02:05'), 3725, '带小时的')
  eq(parseDuration(993), 993, '已经是秒的原样返回')
  eq(parseDuration(''), 0); eq(parseDuration(null), 0); eq(parseDuration('胡说'), 0); eq(parseDuration('-1:00'), 0)
  // fmtTime 的第二层防御：真收到字符串也不许算成 00:00
  eq(fmtTime('16:33'), '16:33', '字符串原样返回')
  eq(fmtTime(993), '16:33')
  eq(fmtTime(''), '—'); eq(fmtTime('胡说'), '—'); eq(fmtTime(NaN), '—')
  eq(fmtTime(0), '00:00', '真的是 0 秒还是老实显示 00:00')
})

check('resolveHome：ctx.get("dshHomePath") 是函数也兼容（当字符串用过一次就会挂）', () => {
  // resolveHome 返回的是**家目录本身**，bili-surfer 这一层由 stateDirOf 追加
  const asFn = { get: (k) => (k === 'dshHomePath' ? (...seg) => join('C:', 'fake-home', ...seg) : undefined) }
  eq(resolveHome(asFn), join('C:', 'fake-home'), '函数形状')
  eq(stateDirOf(asFn), join('C:', 'fake-home', 'bili-surfer'), '函数形状 + 子目录')
  const asStr = { get: (k) => (k === 'dshHomePath' ? join('C:', 'fake-home') : undefined) }
  eq(resolveHome(asStr), join('C:', 'fake-home'), '字符串形状（旧版本替身）')
  const none = { get: () => undefined }
  ok(resolveHome(none).endsWith('.dsh'), `兜底到 ~/.dsh，实际 ${resolveHome(none)}`)
  ok(stateDirOf(none).endsWith(join('.dsh', 'bili-surfer')), `兜底 + 子目录，实际 ${stateDirOf(none)}`)
})

check('ensureFiles：内容相同不重写；overwrite=false 时已存在就不动（但新版会摆到 .new）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsf-ef-'))
  try {
    const src = join(dir, 'src.md'); writeFileSync(src, 'v1\n', 'utf8')
    const first = ensureFiles(dir, [{ from: src, to: 'keep.md', overwrite: false }])
    eq(readText(join(dir, 'keep.md')), 'v1\n', '首次复制')
    eq(first.map((f) => f.action).join(','), 'created', '首次要报 created')
    eq(ensureFiles(dir, [{ from: src, to: 'keep.md', overwrite: false }]).length, 0, '内容一样就什么都不做')
    writeFileSync(join(dir, 'keep.md'), '我改过\n', 'utf8')
    writeFileSync(src, 'v2\n', 'utf8')
    const third = ensureFiles(dir, [{ from: src, to: 'keep.md', overwrite: false }])
    eq(readText(join(dir, 'keep.md')), '我改过\n', 'overwrite=false 不许覆盖用户改过的')
    eq(third.map((f) => f.action).join(','), 'pending', '不覆盖时要报 pending，别静默丢新版')
    eq(readText(join(dir, 'keep.md.new')), 'v2\n', '新版要摆到 .new 旁边')
    ensureFiles(dir, [{ from: src, to: 'keep.md', overwrite: true }])
    eq(readText(join(dir, 'keep.md')), 'v2\n', 'overwrite=true 才覆盖')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

check('JSON/文本读写、appendLog、tail、mtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsf-io-'))
  try {
    writeJson(join(dir, 'a.json'), { x: 1, s: '中文' })
    eq(readJson(join(dir, 'a.json'), null).s, '中文')
    eq(readJson(join(dir, 'missing.json'), { fallback: true }).fallback, true)
    writeText(join(dir, 'a.txt'), 'line1\n')
    appendLog(join(dir, 'a.txt'), 'line2')
    eq(readText(join(dir, 'a.txt')), 'line1\nline2\n')
    appendLog(join(dir, 'a.txt'), 'line3')
    ok(tail(join(dir, 'a.txt'), 8).endsWith('line3\n'), JSON.stringify(tail(join(dir, 'a.txt'), 8)))
    ok(mtime(join(dir, 'a.txt')) > 0); eq(mtime(join(dir, 'nope.txt')), 0)
    ok(existsSync(join(dir, 'a.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

check('stateDirOf 会真的把目录建出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsf-sd-'))
  try {
    const base = join(dir, 'home')
    const got = stateDirOf({ get: (k) => (k === 'dshHomePath' ? (...seg) => join(base, ...seg) : undefined) })
    ok(existsSync(got), `目录应存在：${got}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

check('paths() 七个路径键齐全且都在家目录下', () => {
  const p = paths(join('C:', 'h', 'bili-surfer'))
  for (const k of ['dir', 'outDir', 'logFile', 'stateFile', 'cfgFile', 'seenFile', 'credFile']) {
    ok(typeof p[k] === 'string' && p[k].startsWith(p.dir), `paths().${k} = ${p[k]}`)
  }
})

const item = {
  bvid: 'BV1xx411c7mD', aid: 1, title: '标题 | 带竖线', author: 'UP主', score: 7.5,
  scoreText: '7.5（关键词命中）', why: '命中关键词', play: 123456, danmaku: 2345, reply: 345,
  duration: 123, pubdate: Math.floor(Date.now() / 1000) - 3600, oneLiner: '一句话概括。',
  subtitle: { lan: 'zh-CN', chars: 10, text: '正文正文' }, tags: ['a', 'b'],
}

check('renderReport：标题/BV/统计/正文都在，表格能被 parseSeen 读回', () => {
  const md = renderReport({ day: '2026-03-02', cfg: DEFAULTS, items: [item], stats: { candidates: 12, skipped: { 已看过: 1 } }, generatedAt: new Date() })
  ok(md.includes('2026-03-02'), '日期')
  ok(md.includes('BV1xx411c7mD'), 'BV 号')
  ok(md.includes('标题 \\| 带竖线') || md.includes('标题 | 带竖线'), '标题（竖线需转义或用原样）')
  ok(md.includes('12'), '候选数')
  const row = seenRow(item, { day: '2026-03-02', note: '只读' })
  const parsed = parseSeen(`${row}\n`) // 返回 Map<BV, {day,title,rpid,mentioned,note}>
  eq(parsed.size, 1, '台账行数')
  eq(parsed.get('BV1xx411c7mD')?.day, '2026-03-02', '台账日期')
  ok((parsed.get('BV1xx411c7mD')?.title || '').includes('标题'), '台账标题')
  ok(md.length > 200, '报告不该是空壳')
})

check('renderReport：弹幕当摘录时不再和「弹幕在聊什么」逐行重复；热评截断要留痕', () => {
  const dm = {
    ...item, subtitle: null, aiSummary: null, desc: '', danmakuCount: 18,
    danmakuText: '夯爆了\n还没用过', danmakuSample: ['夯爆了', '还没用过'],
  }
  const md = renderReport({ day: '2026-03-02', cfg: DEFAULTS, items: [dm], stats: {}, generatedAt: new Date() })
  ok(md.includes('弹幕节选（共 18 条）'), '摘录来源要标明是弹幕')
  ok(!md.includes('弹幕在聊什么'), '摘录本身就是弹幕了，别再列一遍同样的话')
  eq((md.match(/夯爆了/g) || []).length, 1, '同一句弹幕只该出现一次')

  // 有字幕时弹幕照列 —— 是「重复才不列」，不是「一律不列」
  const both = { ...item, danmakuSample: ['哈哈'], danmakuText: '' }
  const md2 = renderReport({ day: '2026-03-02', cfg: DEFAULTS, items: [both], stats: {}, generatedAt: new Date() })
  ok(md2.includes('弹幕在聊什么') && md2.includes('哈哈'), '有字幕时弹幕照列')

  // 热评截断必须留痕（半句话不能长得像整句）
  ok(commentLine({ user: '甲', like: 3, message: '啊'.repeat(200) }).endsWith('…'), '超长热评要有省略号')
  eq(commentLine({ user: '甲', like: 3, message: '短评' }), '甲（3 赞）：短评', '短评原样')
  eq(commentLine({ user: '甲', like: 0, message: '  多   空格  ' }), '甲（0 赞）：多 空格', '空白要压平')
})

check('renderReport：四个摘录来源都受 excerptChars 约束（含简介与弹幕）', () => {
  const cfg = normalize({ excerptChars: 100 }, DEFAULTS)
  const longDesc = { ...item, subtitle: null, aiSummary: null, danmakuText: '', desc: '啊'.repeat(5000) }
  const md = renderReport({ day: '2026-03-02', cfg, items: [longDesc], stats: {}, generatedAt: new Date() })
  ok(md.includes('（摘录到此，原文 5000 字）'), '截断要说明原文有多长')
  ok(!md.includes('啊'.repeat(200)), '5000 字的简介不许整段进报告')
  ok(md.length < 2000, `报告不该被一段简介淹掉（实际 ${md.length} 字符）`)

  // 弹幕那条路也一样（以前只有字幕被截过）
  const cfg2 = normalize({ excerptChars: 60 }, DEFAULTS)
  const longDm = { ...item, subtitle: null, aiSummary: null, desc: '', danmakuText: '哈'.repeat(3000), danmakuSample: ['哈'] }
  const md2 = renderReport({ day: '2026-03-02', cfg: cfg2, items: [longDm], stats: {}, generatedAt: new Date() })
  ok(md2.includes('（摘录到此，原文 3000 字）'), '弹幕摘录也要截')
  // 短内容不该被加尾巴
  const md3 = renderReport({ day: '2026-03-02', cfg, items: [item], stats: {}, generatedAt: new Date() })
  ok(!md3.includes('摘录到此'), '没超上限就不要动它')
})

check('renderReport：摘录的标题与正文必须同源；excerptChars=0 是「按设置关掉」不是「用默认值」', () => {
  const cfg = normalize({ excerptChars: 500 }, DEFAULTS)
  // 字幕正文是空串时，以前会「标题写字幕（N 字）、正文贴的却是简介」
  const emptySub = { ...item, subtitle: { lan: 'zh-CN', lanDoc: '中文', ai: false, chars: 0, text: '' }, aiSummary: null, danmakuText: '', desc: '简介正文' }
  const md = renderReport({ day: '2026-03-02', cfg, items: [emptySub], stats: {}, generatedAt: new Date() })
  ok(!/内容摘录\*\*（[^）]*字幕/.test(md), `字幕正文为空时标题不许说字幕：${(md.match(/内容摘录[^\n]*/) || [''])[0]}`)
  ok(md.includes('内容摘录**（视频简介）'), '该退到简介就老实写简介')

  const withSub = { ...item, subtitle: { lan: 'zh-CN', lanDoc: '中文', ai: false, chars: 4, text: '字幕正文' }, aiSummary: { summary: '摘要正文' } }
  const md2 = renderReport({ day: '2026-03-02', cfg, items: [withSub], stats: {}, generatedAt: new Date() })
  ok(md2.includes('内容摘录**（字幕（zh-CN，4 字））'), `标题要标明来源与字数：${(md2.match(/内容摘录[^\n]*/) || [''])[0]}`)
  ok(md2.includes('字幕正文') && !md2.includes('摘要正文'), '摘的是字幕，就不许把摘要塞进摘录')

  // 0 = 关掉。以前 `Number(0) || 1200` 会静默变成 1200，「关掉摘录」这个意图根本表达不出来。
  const off = normalize({ excerptChars: 0 }, DEFAULTS)
  eq(off.excerptChars, 0, '0 不能被当成缺省吃掉')
  const md3 = renderReport({ day: '2026-03-02', cfg: off, items: [withSub], stats: {}, generatedAt: new Date() })
  ok(!md3.includes('内容摘录**（'), 'excerptChars=0 就不许摘录')
  ok(md3.includes('关掉了'), '要说清是按设置关掉的，别让人以为没读到内容')

  // 四个来源全空（新视频常见：没字幕 / 没摘要 / 没人发弹幕 / 简介也空）。
  // 以前这里是退化成占位对象当来源，渲染成「**内容摘录**（（没读到内容））」再跟一段
  // 「> （没读到内容）」—— 括号套括号，同一句话还说两遍。这是读真报告时看出来的。
  const empty = { ...item, subtitle: null, aiSummary: null, danmakuText: '', desc: '', danmakuSample: [] }
  const md4 = renderReport({ day: '2026-03-02', cfg, items: [empty], stats: {}, generatedAt: new Date() })
  ok(md4.includes('这条没读到正文'), `一条正文都没读到时要直说：${(md4.match(/内容摘录[^\n]*/) || [''])[0]}`)
  ok(!md4.includes('（（'), '不许括号套括号')
  ok(!md4.includes('> （没读到内容）'), '不许拿占位文案当引用正文贴一遍')
  ok((md4.match(/没读到正文/g) || []).length === 1, '同一句话说两遍读者会以为报告重了')
})

check('评论：演练（dryRun）在报告与台账里都标明「没真发」，真发的行带 rpid', () => {
  const cfg = normalize({ autoComment: true, mentionName: '小明' }, DEFAULTS)
  const dry = { ...item, mentioned: '小明', comment: { rpid: null, dryRun: true, message: '@小明 说得好' } }
  const mdDry = renderReport({ day: '2026-03-02', cfg, items: [dry], stats: {}, generatedAt: new Date() })
  ok(mdDry.includes('演练'), '报告要说清是演练')
  ok(!mdDry.includes('已发'), '演练不该写成已发')
  const parsedDry = parseSeen(`${seenRow(dry, { day: '2026-03-02', note: '演练（没真发）' })}\n`).get('BV1xx411c7mD')
  eq(parsedDry?.note, '演练（没真发）', '台账备注')
  eq(parsedDry?.rpid, '', '演练没有 rpid')

  const sent = { ...item, mentioned: '小明', comment: { rpid: 123456, message: '@小明 说得好' } }
  const mdSent = renderReport({ day: '2026-03-02', cfg, items: [sent], stats: {}, generatedAt: new Date() })
  ok(mdSent.includes('已发') && mdSent.includes('123456'), '真发要带 rpid')
  // README 承诺写「可见 / 暂时不可见 / 没查到」——查不到时含糊成「已发」等于每天骗用户一次
  ok(mdSent.includes('可见性：没查到'), `查不到可见性必须老实写「没查到」：${(mdSent.match(/本轮评论[^\n]*/) || [''])[0]}`)
  const hidden = { ...sent, comment: { ...sent.comment, visible: false } }
  ok(renderReport({ day: '2026-03-02', cfg, items: [hidden], stats: {}, generatedAt: new Date() }).includes('可见性：暂时不可见'), '先审后放要写出来')
  const shown = { ...sent, comment: { ...sent.comment, visible: true } }
  ok(renderReport({ day: '2026-03-02', cfg, items: [shown], stats: {}, generatedAt: new Date() }).includes('可见性：可见'), '真可见也要写出来')
  eq(parseSeen(`${seenRow(sent, { day: '2026-03-02' })}\n`).get('BV1xx411c7mD')?.rpid, '123456', '台账 rpid 从 it.comment 兜底')
})

check('stubReport：失败也要留下报告（底线产出）', () => {
  const md = stubReport({ day: '2026-03-02', reason: '网络挂了', logTail: 'x' })
  ok(md.includes('2026-03-02') && md.includes('网络挂了'), md.slice(0, 120))
})

check('normalizeComment：补 @、去 URL、按上限截断、必须 @ 到人', () => {
  const cfg = normalize({ mentionName: '小明', commentMax: 30, autoComment: true }, DEFAULTS)
  eq(normalizeComment('说得好', cfg), '@小明 说得好', '补 @')
  ok(!normalizeComment('看这个 https://b23.tv/abc 挺好', cfg).includes('http'), 'URL 必须去掉')
  ok(!normalizeComment('看这个 file:///C:/Users/x/a.png 挺好', cfg).includes('file'), 'file:// 这类 scheme 也要去掉')
  const long = normalizeComment('啊'.repeat(80), cfg)
  ok(long.length <= 30, `截断后长度 ${long.length}`)
  ok(long.startsWith('@小明'), '截断后 @ 还在')
  eq(normalizeComment('   ', cfg), '', '空正文 → 空')
  // 整条评论就是一个链接：去 URL 之后必须**再判一次空**，否则补上 @ 就变成一条正文只有 @ 的评论
  eq(normalizeComment('https://www.bilibili.com/video/BV1xx411c7mD', cfg), '', '只有链接 → 空，不许退化成「@小明 」')
  eq(normalizeComment('看这个 https://b23.tv/abc', cfg), '@小明 看这个', '去完 URL 还剩正文就照发，别把整条评论误杀')
  eq(normalizeComment('@小明 已经在里面了', cfg), '@小明 已经在里面了', '不重复 @')
})

check('pickDanmaku：去复读、偏好长句、丢纯符号', () => {
  const list = ['哈哈哈哈', '哈哈哈哈', '哈哈哈哈', '？？？', '这段配乐一起，整段气氛就完全不一样了', '好']
  const got = pickDanmaku(list, 3)
  ok(got.length > 0 && got.length <= 3, `条数 ${got.length}`)
  eq(new Set(got).size, got.length, '不许重复')
  // 复读最多留一条
  ok(got.filter((s) => s === '哈哈哈哈').length <= 1, JSON.stringify(got))
  ok(got.includes('这段配乐一起，整段气氛就完全不一样了'), JSON.stringify(got))
})

check('firstSentence：切一个完整句子，且不会超长', () => {
  eq(firstSentence('这是第一句。第二句在这里。'), '这是第一句。')
  ok(firstSentence('没有标点的一段很长的话'.repeat(10)).length <= 60, '超长要截')
  eq(firstSentence(''), '')
})

check('scoreCandidate：命中关键词 > 没命中；同样命中时新的 > 旧的', () => {
  const now = Math.floor(Date.now() / 1000)
  const cfg = normalize({ keywords: ['DeepSeek'], maxAgeDays: 30 }, DEFAULTS)
  const hit = scoreCandidate({ title: 'DeepSeek Harness 插件开发', play: 1000, pubdate: now - 3600 }, cfg)
  const miss = scoreCandidate({ title: '完全无关的内容', play: 1000, pubdate: now - 3600 }, cfg)
  ok(hit.score > miss.score, `${hit.score} vs ${miss.score}`)
  const fresh = scoreCandidate({ title: 'DeepSeek', play: 1000, pubdate: now - 3600 }, cfg)
  const old = scoreCandidate({ title: 'DeepSeek', play: 1000, pubdate: now - 3600 * 24 * 20 }, cfg)
  ok(fresh.score > old.score, `${fresh.score} vs ${old.score}`)
  ok(Array.isArray(hit.reasons) && hit.reasons.length > 0, '要给出可解释的理由')
})

check('mixinKey 输出 32 字符，且只由 imgKey/subKey 的字符组成', () => {
  const img = '7cd084941338484aae1ad9425b84077c'
  const sub = '4932caff0ff746eab6f01bf08b70ac45'
  const mk = mixinKey(img, sub)
  eq(mk.length, 32, '长度')
  ok([...mk].every((ch) => (img + sub).includes(ch)), mk)
  eq(mixinKey(img, sub), mk, '必须确定性')
})

check('signWbi：键排序 + wts + w_rid(md5) + 过滤 !\'()* 并 encodeURIComponent', () => {
  const q = signWbi({ b: '2', a: "it's!()* ok", c: '中' }, 'k'.repeat(32), 's'.repeat(32))
  ok(/^a=.*&b=2&c=.*&wts=\d+&w_rid=[0-9a-f]{32}$/.test(q), q)
  ok(!/[!'()*]/.test(q.split('&wts=')[0]), '参数里不许留 !\'()*')
  ok(q.includes(encodeURIComponent('中')), '非 ASCII 要编码')
  eq(signWbi({ a: '1' }, 'x'.repeat(32), 'y'.repeat(32)).split('wts=')[0], 'a=1&', '去掉 wts/w_rid 后只剩参数')
})

check('UA 常量像浏览器（B 站会挑 UA）', () => {
  ok(UA.includes('Mozilla/5.0'), UA)
})

// ⚠️ 回归：`String(undefined)` 会拼出字符串 "undefined" 发出去（`up_mid=undefined`），
// 接口按非法参数处理 —— 症状是「有的视频就是读不到 AI 摘要」，而不是报错。
check('signWbi：undefined / null 参数整个丢掉，不许变成字符串 "undefined"', () => {
  const q = signWbi({ a: '1', up_mid: undefined, cid: null }, 'x'.repeat(32), 'y'.repeat(32))
  ok(!q.includes('undefined'), q)
  ok(!q.includes('null'), q)
  eq(q.split('&wts=')[0], 'a=1', '只留真值参数')
})

// ⚠️ 回归：没有超时的 fetch 遇到黑洞连接（TCP 建上了但不回）会把整轮永久挂住，
// 而工具不带 timeoutMs、`/run` 又是后台跑的 —— 用户只能重启 dsh 才能再跑。
await checkAsync('net：每个请求自带超时（黑洞连接不许把整轮挂死）', async () => {
  const realFetch = globalThis.fetch
  // ⚠️ AbortSignal.timeout() 的定时器是 **unref** 的：用例里如果只有它一个待办，
  // node 会在它触发之前就直接退出（实测「Detected unsettled top-level await」）。
  // 真宿主里事件循环一直活着，所以没事；用例里得自己留点活干。
  const keepAlive = setTimeout(() => {}, 5000)
  const seen = []
  try {
    globalThis.fetch = (url, init = {}) => {
      seen.push(init)
      return new Promise((_, reject) => {
        if (!init.signal) return // 没有 signal 就永远挂着 —— 正是要防的那件事
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      })
    }
    const cli = newClient()
    const t0 = Date.now()
    let err = ''
    try {
      // 显式给个小上限，免得用例自己等 15 秒；要验的是「signal 一定在，且到点真会中止」。
      await cli.raw('https://api.bilibili.com/x/web-interface/nav', { timeoutMs: 50 })
    } catch (e) {
      err = String(e?.name || e?.message || e)
    }
    const ms = Date.now() - t0
    ok(seen[0]?.signal, 'raw() 必须给 fetch 带 AbortSignal')
    ok(ms < 3000, `超时应该很快发生（实际 ${ms}ms）`)
    ok(err, `不带超时就会永久挂着；这里应当因超时失败（实际 err=${err || '无'}）`)
  } finally {
    clearTimeout(keepAlive)
    globalThis.fetch = realFetch
  }
})

// ⚠️ 回归：`{...rest}` 排在 headers 后面会把 Content-Type 整个顶掉，表单发成无类型 body，
// B 站按空表单处理 —— 症状是「评论发出去了但没内容」。
await checkAsync('net：postForm 的 Content-Type 不会被 opts.headers 顶掉，csrf 照样带上', async () => {
  const realFetch = globalThis.fetch
  let seen = null
  try {
    globalThis.fetch = async (url, init = {}) => {
      seen = { url: String(url), headers: init.headers || {}, body: String(init.body || '') }
      return { status: 200, headers: { getSetCookie: () => [] }, text: async () => JSON.stringify({ code: 0, data: {} }) }
    }
    const cli = newClient({ cookies: { sessdata: 's', bili_jct: 'JCT' } })
    await cli.postForm('https://api.bilibili.com/x/v2/reply/add', { oid: 1, message: 'hi' }, { headers: { 'X-Test': '1' } })
    eq(seen.headers['Content-Type'], 'application/x-www-form-urlencoded', '表单类型必须还在')
    eq(seen.headers['X-Test'], '1', '额外 headers 照旧带上')
    ok(seen.body.includes('csrf=JCT'), `csrf 必须来自 bili_jct：${seen.body}`)
    ok(seen.body.includes('message=hi'), seen.body)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ⚠️ 这条是真实事故的回归测试：cookie 名大小写敏感，凭证文件存小写、
// 回填时必须映射成官方名，否则「扫码成功但读字幕仍是游客」，且全程不报错。
check('cookie 名双向映射：小写凭证回填成官方名（SESSDATA/DedeUserID）', () => {
  const cli = newClient({ cookies: { sessdata: 'aaa', bili_jct: 'bbb', buvid3: 'ccc', dedeuserid: '42' } })
  eq(cli.loggedIn, true, '小写 sessdata 必须让客户端认为自己已登录')
  eq(cli.csrf, 'bbb', 'csrf 取的是 bili_jct')
  const h = cli.cookieHeader
  ok(h.includes('SESSDATA=aaa'), `请求头里必须是官方名：${h}`)
  ok(h.includes('DedeUserID=42'), `请求头里必须是官方名：${h}`)
  ok(!/(^|; )sessdata=/.test(h), '不能把小写键原样发出去')
  const picked = BiliClient.pickCredentials({ SESSDATA: 'aaa', DedeUserID: '42', b_nut: 'x' })
  eq(Object.keys(picked).sort().join(','), 'dedeuserid,sessdata', 'pickCredentials 只留四个键、且输出小写')
  eq(BiliClient.pickCredentials({ b_nut: 'x' }), undefined, '没有 sessdata 就等于没有登录态，必须给 undefined 而不是 {}')
  eq(picked.sessdata, 'aaa')
})

check('compileParams：根节点不带 additionalProperties，required 只列必填', () => {
  const s = compileParams({
    bvid: { type: 'string', required: true, description: 'BV' },
    num: { type: 'number' },
    force: { type: 'boolean' },
  })
  eq(s.type, 'object')
  eq(s.additionalProperties, undefined, '根节点不能有 additionalProperties（内核要求"省略"）')
  eq((s.required || []).join(','), 'bvid')
  eq(Object.keys(s.properties).join(','), 'bvid,num,force')
})

check('assertObjectNodes：每个 object 节点都必须显式写 additionalProperties', () => {
  let threw = false
  try { assertObjectNodes({ type: 'object', properties: { x: { type: 'object', properties: {} } } }) } catch { threw = true }
  ok(threw, '嵌套 object 缺 additionalProperties 必须抛')
  assertObjectNodes({ type: 'object', additionalProperties: true, properties: { x: { type: 'string' } } })
})

check('defineTool：缺 output.render / execute 就抛；正常定义能编译出 JSON Schema', () => {
  let a = false; try { defineTool({ name: 'x', description: 'd', parameters: {}, output: { schema: { type: 'string' } } }) } catch { a = true }
  ok(a, '缺 render 必须抛')
  let b = false; try { defineTool({ name: 'y', description: 'd', parameters: {}, output: textOutput }) } catch { b = true }
  ok(b, '缺 execute 必须抛')
  const t = defineTool({
    name: 'ok_tool', description: 'd',
    parameters: { a: { type: 'string', required: true } },
    output: textOutput,
    execute: async (args) => ({ got: args.a }),
  })
  eq(t.name, 'ok_tool'); eq(t.parameters.required.join(','), 'a')
  eq(t.output.schema.additionalProperties, true)
})

check('safe()：非 lossless JSON 的返回值会被拦住', () => {
  eq(safe({ a: [1, 'x', null] }).a[1], 'x')
  for (const bad of [() => {}, new Map(), { big: 1n }, undefined]) {
    let threw = false
    try { safe(bad) } catch { threw = true }
    ok(threw, `${String(bad)} 应当抛`)
  }
})

await checkAsync('字幕链：登录后按优先级挑轨 / 协议相对 URL 补 https / 带视频页 Referer / 正文去重', async () => {
  const realFetch = globalThis.fetch
  const reqs = []
  let tracks = [
    { lan: 'en', lan_doc: 'English', ai_status: 0, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/en.json?auth_key=1' },
    { lan: 'ai-zh', lan_doc: '中文（自动）', ai_status: 1, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/zh.json?auth_key=2' },
  ]
  globalThis.fetch = async (url, init) => {
    const s = String(url)
    reqs.push({ url: s, referer: String(init?.headers?.Referer || ''), cookie: String(init?.headers?.Cookie || '') })
    const reply = (body) => ({ status: 200, headers: { getSetCookie: () => [] }, text: async () => JSON.stringify(body) })
    if (s.includes('/x/web-interface/nav')) {
      return reply({
        code: -101, message: '账号未登录', // 未登录时业务码是 -101，但 wbi_img 照样在 data 里
        data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png` } },
      })
    }
    if (s.includes('/x/player/wbi/v2')) return reply({ code: 0, data: { subtitle: { subtitles: tracks } } })
    // 字幕 CDN 返回的是裸 JSON（没有 code/message 信封），这里必须照着真样造。
    if (s.includes('zh.json')) {
      return reply({ body: [{ from: 1, to: 2, content: ' 第一句。 ' }, { from: 2, to: 3, content: '第二句。' }, { from: 3, to: 4, content: '第二句。' }] })
    }
    if (s.includes('zhcn.json')) return reply({ body: [{ from: 1, to: 2, content: '人工字幕第一句。' }] })
    throw new Error(`测试没预料到的请求：${s}`)
  }
  try {
    const cli = newClient({ cookies: { sessdata: 'S', bili_jct: 'J' } })
    ok(cli.loggedIn, '有 sessdata 就该是已登录')

    const sub = await fetchSubtitle(cli, 'BV1xx411c7mD', 123)
    ok(sub, '应该挑出一条字幕')
    eq(sub.lan, 'ai-zh', 'ai-zh 必须排在 en 前面')
    eq(sub.ai, true, "ai_status=1 → 标成 AI 字幕")
    eq(sub.lines.length, 3, '原始行数照记（去重交给 joinLines）')
    eq(sub.text, '第一句。第二句。', `正文要 trim + 去重 + 拼段：${sub.text}`)

    const wbi = reqs.find((r) => r.url.includes('/x/player/wbi/v2'))
    ok(/w_rid=/.test(wbi.url) && /wts=/.test(wbi.url), `字幕轨请求必须过 wbi 签名：${wbi.url}`)
    ok(/bvid=BV1xx411c7mD/.test(wbi.url) && /cid=123/.test(wbi.url), `参数要带上：${wbi.url}`)
    ok(wbi.cookie.includes('SESSDATA=S'), `要带官方名 cookie：${wbi.cookie}`)

    const cdn = reqs.find((r) => r.url.includes('aisubtitle'))
    ok(cdn.url.startsWith('https://aisubtitle.hdslb.com/'), `协议相对 URL 要补成 https：${cdn.url}`)
    ok(cdn.url.includes('auth_key=2'), `auth_key 一个字符都不能少：${cdn.url}`)
    eq(cdn.referer, 'https://www.bilibili.com/video/BV1xx411c7mD', 'CDN 认视频页 Referer')
    ok(!cdn.cookie, `CDN 是 *.hdslb.com，不许把 B 站 cookie 发过去：${cdn.cookie}`)

    tracks = [{ lan: 'zh-CN', lan_doc: '中文（中国）', ai_status: 0, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/zhcn.json?auth_key=3' }, ...tracks]
    const best = await fetchSubtitle(cli, 'BV1xx411c7mD', 123)
    eq(best.lan, 'zh-CN', '人工简中优先于 AI 字幕')
    eq(best.ai, false, '人工字幕不该被标成 AI')

    tracks = []
    eq(await fetchSubtitle(cli, 'BV1xx411c7mD', 123), null, '一条轨都没有时返回 null（不是抛错）')
  } finally {
    globalThis.fetch = realFetch
  }
})

await checkAsync('登录后才能验的两条读链：热评（wbi/main）与 AI 摘要的字段解析', async () => {
  const realFetch = globalThis.fetch
  const reqs = []
  globalThis.fetch = async (url, init) => {
    const s = String(url)
    reqs.push({ url: s, cookie: String(init?.headers?.Cookie || '') })
    const reply = (body) => ({ status: 200, headers: { getSetCookie: () => [] }, text: async () => JSON.stringify(body) })
    if (s.includes('/x/web-interface/nav')) {
      return reply({
        code: -101, message: '账号未登录',
        data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png` } },
      })
    }
    // 形状照文档造：member.uname / content.message / like / replies[]；没有 cursor 就该停在一页。
    if (s.includes('/x/v2/reply/wbi/main')) {
      return reply({
        code: 0, data: {
          replies: [{
            rpid_str: '11', mid: 7, like: 12, ctime: 1700000000,
            member: { uname: '甲' }, content: { message: '讲得真清楚' },
            replies: [{ rpid_str: '12', like: 1, ctime: 1700000001, member: { uname: '乙' }, content: { message: '同意' } }],
          }],
          page: { count: 2 },
        },
      })
    }
    if (s.includes('conclusion/get')) {
      return reply({ code: 0, data: { model_result: { summary: '讲了三件事', outline: [{ title: '一', part_outline: ['a', 'b'] }, { title: '二', part_outline: ['c'] }] } } })
    }
    throw new Error(`测试没预料到的请求：${s}`)
  }
  try {
    const cli = newClient({ cookies: { sessdata: 'S', bili_jct: 'J' } })
    const cs = await fetchComments(cli, 'BV1xx411c7mD', 999, { num: 20 })
    eq(cs.length, 1, `应该读到 1 条主楼：${JSON.stringify(cs)}`)
    eq(cs[0].user, '甲'); eq(cs[0].message, '讲得真清楚'); eq(cs[0].like, 12)
    eq(cs[0].rpid, '11', 'rpid 优先用字符串版')
    eq(cs[0].replies.length, 1); eq(cs[0].replies[0].user, '乙')
    eq(reqs.filter((r) => r.url.includes('reply/wbi/main')).length, 1, '没有 cursor 就不该翻页')
    ok(reqs[0].cookie.includes('SESSDATA=S') || reqs[1]?.cookie?.includes('SESSDATA=S'), '读评论要带登录 cookie')

    const ai = await fetchAiSummary(cli, 'BV1xx411c7mD', 123, 7)
    eq(ai.summary, '讲了三件事')
    eq(ai.outline.join(' | '), '一：a；b | 二：c')
    const wbiReq = reqs.find((r) => r.url.includes('conclusion/get'))
    ok(/w_rid=/.test(wbiReq.url) && /up_mid=7/.test(wbiReq.url), `AI 摘要要过 wbi 并带 up_mid：${wbiReq.url}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

/* ═════════════════════════════════════════════════ C. 宿主半端（假 ctx） */

async function hostTests() {
  section('C. 宿主半端：用假 ctx 真跑 apply()')
  const home = mkdtempSync(join(tmpdir(), 'bsf-host-'))
  const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  const tools = []; const routes = []; const effects = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    tools: { register: (d) => { tools.push(d); return () => {} } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    effect: (fn) => { effects.push(fn()); return () => {} },
    on: () => () => {},
  }

  check('index.js 导出 name / inject / apply 的形状正确', () => {
    eq(mod.name, 'bili-surfer', 'name 必须等于插件 id/命名空间/目录名')
    eq(mod.inject.join(','), 'webServer,tools')
    eq(typeof mod.apply, 'function')
    eq(mod.Config, undefined, '不导出 Config —— 配置走自己的 config.json（少一个失败点）')
  })

  await checkAsync('apply() 不抛，并注册 8 个工具 + 1 条前缀路由', async () => {
    mod.apply(ctx, {})
    eq(tools.length, 8, '工具数')
    eq(routes.length, 1, '路由数')
    eq(routes[0].kind, 'prefix'); eq(routes[0].path, '/api/bili-surfer')
    eq(typeof routes[0].handler, 'function')
    ok(effects.length >= 1, '注册必须挂在 ctx.effect 下（能被卸载）')
    const names = tools.map((t) => t.name).sort()
    ok(names.includes('bili_surf') && names.includes('bili_surf_status') && names.includes('bili_surf_comment'), names.join(','))
  })

  check('每个工具的 output.schema 与 parameters 都过关', () => {
    for (const t of tools) {
      ok(t.output && typeof t.output.render === 'function', `${t.name} 缺 render`)
      assertObjectNodes(t.output.schema, `${t.name}.output`)
      // ⚠️ 参数**根**是内核造的 implicit root，必须省略 additionalProperties；
      // 要校验的是每个参数节点本身（它们都是显式写的）。
      ok(t.parameters && t.parameters.type === 'object', `${t.name} 参数根应为 object`)
      for (const [key, spec] of Object.entries(t.parameters.properties || {})) {
        assertObjectNodes(spec, `${t.name}.parameters.${key}`)
      }
      eq(t.parameters.additionalProperties, undefined, `${t.name} 参数根不该有 additionalProperties`)
      ok(typeof t.description === 'string' && t.description.length > 8, `${t.name} 缺 description`)
    }
  })

  const call = async (method, path, body) => {
    const res = { code: 0, headers: {}, body: undefined }
    res.writeHead = (c, h) => { res.code = c; res.headers = h || {} }
    res.end = (t) => { res.body = t === undefined ? '' : String(t) }
    const req = new EventEmitter()
    req.method = method; req.url = path; req.headers = {}; req.destroy = () => {}
    if (body !== undefined) process.nextTick(() => { req.emit('data', JSON.stringify(body)); req.emit('end') })
    routes[0].handler(req, res)
    const t0 = Date.now()
    while (res.body === undefined && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 10))
    ok(res.body !== undefined, `${method} ${path} 超时没回应`)
    return { code: res.code, json: JSON.parse(res.body) }
  }

  await checkAsync('GET /status 返回配置、字段表与运行状态', async () => {
    const { code, json } = await call('GET', '/api/bili-surfer/status')
    eq(code, 200)
    eq(json.ok, true)
    eq(json.config.enabled, true, '默认启用')
    eq(json.enabled, true, '设置页顶部标签读的是顶层 enabled，不能只给 config.enabled')
    ok(/^[0-9a-f]{8}$/.test(String(json.build || '')), `st.build 要是 8 位源码指纹（实际 ${JSON.stringify(json.build)}）—— 旧构建没有它，正好用来分辨「跑的是新代码还是热挂的旧代码」`)
    eq(json.running, false)
    ok(Array.isArray(json.fields) && json.fields.length >= 14, '字段表要够全')
    ok(json.fields.some((f) => f.key === 'autoComment'), '必须有 autoComment')
    // 设置页是照 fields 渲染的：config 里有、fields 里没有的项＝用户永远看不到那个开关；
    // 反过来 fields 有、config 没有＝控件显示 undefined。两边必须逐键对齐。
    const cfgKeys = Object.keys(json.config).sort().join(',')
    const fldKeys = json.fields.map((f) => f.key).sort().join(',')
    eq(cfgKeys, fldKeys, `config 与 fields 的键必须一一对应（config=${cfgKeys} / fields=${fldKeys}）`)
    ok(json.fields.every((f) => f.key && f.type && f.label), '每个字段都要有 key/type/label')
    eq(json.config.autoComment, false, '自动评论默认关')
    eq(json.config.dryRun, true, '演练模式默认开')
    ok(typeof json.home === 'string' && json.home.startsWith(home), json.home)
    ok(Array.isArray(json.logTail === '' ? [] : json.logTail.split('\n')), 'logTail 是字符串')
  })

  await checkAsync('凭证存在时 /status 会读 B 站，但 60 秒内只读一次（设置页 5 秒轮询一次）', async () => {
    const st0 = await call('GET', '/api/bili-surfer/status')
    eq(st0.json.loggedIn, false, '没有凭证时不该是已登录')
    writeJson(join(st0.json.home, 'credential.json'), { sessdata: 'S', bili_jct: 'J', buvid3: 'B', dedeuserid: '42' })

    const seen = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), cookie: String(init?.headers?.Cookie || '') })
      return {
        status: 200,
        headers: { getSetCookie: () => [] },
        text: async () => JSON.stringify({ code: 0, message: '0', data: { isLogin: true, uname: '测试用户', mid: 42 } }),
      }
    }
    try {
      const a = await call('GET', '/api/bili-surfer/status')
      eq(a.json.loggedIn, true, `带凭证的 /status 要是已登录：${JSON.stringify(a.json)}`)
      eq(a.json.uname, '测试用户')
      eq(a.json.hasCredential, true)
      eq(seen.length, 1, '第一次要真去问 B 站')
      ok(seen[0].url.includes('/x/web-interface/nav'), `问的必须是 nav 接口：${seen[0].url}`)
      ok(seen[0].cookie.includes('SESSDATA=S'), `请求要带上官方名的 cookie：${seen[0].cookie}`)
      ok(seen[0].cookie.includes('bili_jct=J'), `csrf 也要带上：${seen[0].cookie}`)

      const b = await call('GET', '/api/bili-surfer/status')
      eq(b.json.loggedIn, true)
      eq(seen.length, 1, '60 秒内第二次 /status 必须走缓存，不能再打 B 站')

      await call('POST', '/api/bili-surfer/logout', {})
      const c = await call('GET', '/api/bili-surfer/status')
      eq(c.json.loggedIn, false, '退出后要立刻不再是已登录（缓存必须作废）')
      eq(c.json.hasCredential, false)
      eq(seen.length, 1, '没有凭证时根本不该发请求')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  await checkAsync('POST /login/start：rows 是等长 0/1 字符串，且逐格等于 qrMatrix(登录 URL)', async () => {
    const realFetch = globalThis.fetch
    const url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=deadbeefdeadbeef'
    globalThis.fetch = async (u) => {
      const s = String(u)
      const reply = (body) => ({ status: 200, headers: { getSetCookie: () => [] }, text: async () => JSON.stringify(body) })
      if (s.includes('finger/spi')) return reply({ code: 0, data: { b_3: 'buv3', b_4: 'buv4' } })
      if (s.includes('qrcode/generate')) return reply({ code: 0, message: '0', data: { url, qrcode_key: 'deadbeefdeadbeef' } })
      throw new Error(`测试没预料到的请求：${s}`)
    }
    try {
      const r = await call('POST', '/api/bili-surfer/login/start', {})
      ok(r.json.ok, `login/start 应该是 ok：${JSON.stringify(r.json)}`)
      eq(r.json.url, url)
      const rows = r.json.rows
      ok(Array.isArray(rows), 'rows 必须是数组')
      eq(rows.length, r.json.size, 'rows 行数要等于 size')
      ok(rows.every((s) => typeof s === 'string'), '每行必须是字符串（数字数组会让 canvas 全白）')
      ok(rows.every((s) => /^[01]+$/.test(s) && s.length === rows.length), '每行必须是等长的 0/1 串')
      const want = qrMatrix(url).modules.map((line) => line.join('')).join('\n')
      eq(rows.join('\n'), want, '服务端给的矩阵必须逐格等于 qrMatrix(登录 URL)')
      ok(!JSON.stringify(r.json).includes('sessdata'), '响应里不许出现凭证')
    } finally {
      globalThis.fetch = realFetch
      // 这个用例建了一个登录会话，得清掉，否则后面的「没有会话时软失败」用例就被它带跑偏了
      await call('POST', '/api/bili-surfer/logout', {})
    }
  })

  await checkAsync('扫码状态机：外层 code 恒为 0，状态在 data.data.code（读错就会「还没扫就说登录成功」）', async () => {
    const realFetch = globalThis.fetch
    const url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=deadbeefdeadbeef'
    // ⚠️ 这是 passport 的**真实回包形状**（2026-10 实测）：外层 code=0 表示「这次请求本身成功」，
    // 扫码状态在内层 data.code。以前我把外层当状态读 → 一按「生成二维码」就报登录成功。
    const env = (inner, message) => ({ code: 0, message: 'OK', ttl: 1, data: { url: '', refresh_token: '', timestamp: 0, code: inner, message } })
    let pollBody = env(86101, '未扫码')
    let setCookie = []
    globalThis.fetch = async (u) => {
      const s = String(u)
      const reply = (body) => ({ status: 200, headers: { getSetCookie: () => setCookie }, text: async () => JSON.stringify(body) })
      if (s.includes('finger/spi')) return reply({ code: 0, data: { b_3: 'buv3', b_4: 'buv4' } })
      if (s.includes('qrcode/generate')) return reply({ code: 0, message: 'OK', ttl: 1, data: { url, qrcode_key: 'deadbeefdeadbeef' } })
      if (s.includes('qrcode/poll')) return reply(pollBody)
      throw new Error(`测试没预料到的请求：${s}`)
    }
    const credFile = join(home, 'bili-surfer', 'credential.json')
    const startAndPoll = async () => {
      const st = await call('POST', '/api/bili-surfer/login/start', {})
      ok(st.json.ok, `login/start 要成功：${JSON.stringify(st.json)}`)
      return call('POST', '/api/bili-surfer/login/poll', {})
    }
    try {
      // ① 未扫码：外层 code=0 也不能当成成功
      let r = await startAndPoll()
      eq(r.json.status, 'waiting', `86101 必须是「等待扫码」，实际 ${JSON.stringify(r.json)}`)
      eq(r.json.loggedIn, false, '还没扫就不许说登录成功')
      ok(!existsSync(credFile), '没扫成功就不许写凭证文件')

      // ② 已扫码待确认
      pollBody = env(86090, '扫码成功，请在手机上确认')
      r = await call('POST', '/api/bili-surfer/login/poll', {})
      eq(r.json.status, 'scanned', '86090 是已扫待确认')
      ok(/确认/.test(r.json.text), `要告诉用户去手机上确认：${r.json.text}`)

      // ③ 过期
      pollBody = env(86038, '二维码已失效')
      r = await call('POST', '/api/bili-surfer/login/poll', {})
      eq(r.json.status, 'expired', '86038 是过期')

      // ④ 状态说成功、但没有 Set-Cookie：不许装作登录成功
      pollBody = env(0, '0')
      setCookie = []
      r = await startAndPoll()
      eq(r.json.loggedIn, false, '没有 Set-Cookie 时不许说登录成功')
      ok(!existsSync(credFile), '没拿到凭证就不许写凭证文件')

      // ⑤ 真成功：data.code=0 且响应带 Set-Cookie
      setCookie = ['SESSDATA=abc%2Cdef; Path=/; HttpOnly', 'bili_jct=jjj; Path=/', 'DedeUserID=42; Path=/', 'buvid3=bv3; Path=/']
      r = await startAndPoll()
      eq(r.json.loggedIn, true, `带 Set-Cookie 的成功才算成功：${JSON.stringify(r.json)}`)
      const saved = JSON.parse(readFileSync(credFile, 'utf8'))
      eq(saved.sessdata, 'abc%2Cdef', '凭证按小写键存盘')
      eq(saved.dedeuserid, '42', 'mid 也要存下来')
      ok(!JSON.stringify(r.json).includes('abc'), '凭证不许出现在响应里（会进对话）')

      // ⑥ 退出登录 = 文件消失
      await call('POST', '/api/bili-surfer/logout', {})
      ok(!existsSync(credFile), 'logout 之后凭证文件必须消失')
      const st = await call('GET', '/api/bili-surfer/status')
      eq(st.json.loggedIn, false, '/logout 之后 /status 该说没登录')
    } finally {
      globalThis.fetch = realFetch
      await call('POST', '/api/bili-surfer/logout', {})
    }
  })

  await checkAsync('POST /config 改配置后能读回（并再次过一遍白名单）', async () => {
    const { json } = await call('POST', '/api/bili-surfer/config', { patch: { perDay: 3, keywords: ['测试'], evil: 1, source: '不存在的来源' } })
    eq(json.ok, true)
    eq(json.config.perDay, 3)
    eq(json.config.keywords.join(','), '测试')
    eq(json.config.source, 'search', '非法枚举要回退')
    eq(json.config.evil, undefined, '不认识的字段不许写进配置')
    ok(json.changed.includes('perDay') && json.changed.includes('keywords'), `changed 要列出真变了的键：${JSON.stringify(json.changed)}`)
    ok(!json.changed.includes('source'), '枚举非法、回退成原值时，source 不算改动')
    ok(json.ignored.includes('evil'), '白名单丢掉的键要说出来（不然用户以为写进去了）')
    const again = await call('GET', '/api/bili-surfer/status')
    eq(again.json.config.perDay, 3, '落盘了没有')
    ok(readFileSync(join(home, 'bili-surfer', 'config.json'), 'utf8').includes('"perDay": 3'), 'config.json 内容')
    // 空 patch（设置页什么都没改就点保存）不该在 surf.log 里留一行：一次探针 POST 就能刷出几十行
    // 「设置页改了配置：{}」（真实发生过，把真日志刷成了噪声）。
    const logPath = join(home, 'bili-surfer', 'surf.log')
    const count = () => (readText(logPath).match(/设置页改了配置/g) || []).length
    const n0 = count()
    const empty = await call('POST', '/api/bili-surfer/config', { patch: {} })
    eq(empty.json.changed.length, 0, '空 patch 的 changed 必须是空数组')
    eq(empty.json.ignored.length, 0, '空 patch 的 ignored 也必须是空数组')
    eq(count(), n0, '空 patch 不许往 surf.log 里写「设置页改了配置」')
  })

  await checkAsync('POST /login/poll 在没有会话时是软失败（不是 500）', async () => {
    const { code, json } = await call('POST', '/api/bili-surfer/login/poll', {})
    eq(code, 200); eq(json.ok, false)
    ok(String(json.error).includes('扫码'), json.error)
  })

  await checkAsync('未知路径返回 404 JSON', async () => {
    const { code, json } = await call('GET', '/api/bili-surfer/nope')
    eq(code, 404); eq(json.ok, false)
  })

  await checkAsync('总开关关掉后 /run 直接拒绝（同步返回、不起后台任务）', async () => {
    await call('POST', '/api/bili-surfer/config', { patch: { enabled: false } })
    const { code, json } = await call('POST', '/api/bili-surfer/run', {})
    eq(code, 200)
    eq(json.ok, false, '/run 在总开关关掉时必须拒绝')
    ok(String(json.error).includes('总开关'), json.error)
    await new Promise((r) => setTimeout(r, 150))
    const st = await call('GET', '/api/bili-surfer/status')
    eq(st.json.running, false, '关掉之后不该真的跑起来')
    ok(readFileSync(join(home, 'bili-surfer', 'surf.log'), 'utf8').includes('总开关'), '日志里要说明为什么没跑')
  })

  check('凭证文件不会被顺手写出来（必须显式登录）', () => {
    ok(!existsSync(join(home, 'bili-surfer', 'credential.json')), '没登录就不该有凭证文件')
  })

  await checkAsync('README 的「设置项」表与代码里的字段表一一对应（文档不许落后于代码）', async () => {
    const { json } = await call('GET', '/api/bili-surfer/status')
    const block = readFileSync(join(ROOT, 'README.md'), 'utf8').split('## 设置项')[1]?.split(/\n## /)[0] || ''
    const documented = new Set()
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('|')) continue
      const cell = line.split('|')[1] || ''
      for (const m of cell.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)) documented.add(m[1])
    }
    const code = new Set(json.fields.map((f) => f.key))
    const missing = [...code].filter((k) => !documented.has(k))
    const extra = [...documented].filter((k) => !code.has(k))
    eq(missing.join(','), '', `README 漏了这些设置项：${missing.join(',')}`)
    eq(extra.join(','), '', `README 写了代码里没有的设置项：${extra.join(',')}`)
  })

  /* ── C3. 工具层：把工具真执行一遍 ─────────────────────────────────────
     这一层补的是「内部函数测了一堆，真正展示出去的字段却是错的」那个坑
     （搜索条目时长全显示 00:00，离线 68 项全绿也没拦住 —— 是**真去调用工具**才看见的）。
     所以这里不看函数，只看工具**返回**的东西，并且每个返回值都过一遍 safe()：
     那不是自检的洁癖，是内核真的会拿它当硬失败（value is not lossless JSON）。 */
  section('C3. 工具层：打桩真执行（返回形状 + lossless JSON）')
  const toolOf = (n) => tools.find((t) => t.name === n)
  const runTool = async (n, args = {}) => {
    const t = toolOf(n)
    ok(!!t, `找不到工具 ${n}`)
    const v = await t.execute(args, {})
    safe(v)
    return v
  }

  const stub = stubBili()
  try {
    await checkAsync('bili_surf_config：真执行，改完能读回（白名单之外的键进不来，但要明说被丢了）', async () => {
      // C 段前面的用例把 enabled 关掉了，这里顺手打开（也顺便测了写路径）
      const w = await runTool('bili_surf_config', { patch: { enabled: true, perDay: 2, 并不存在的键: 1 } })
      eq(w.ok, true)
      eq(w.config.enabled, true)
      eq(w.config.perDay, 2)
      eq('并不存在的键' in w.config, false, '白名单之外的键不许进配置')
      eq(w.ignored.join(','), '并不存在的键', '被丢掉的键要说清，别让 changed 看着像改成功了')
      ok(w.changed.includes('enabled') && w.changed.includes('perDay'), `真变了的键要列出来：${w.changed}`)
      const ro = await runTool('bili_surf_config', {})
      ok(Array.isArray(ro.fields) && ro.fields.some((f) => f.key === 'perDay'), '只读时要回字段表（设置页照它渲染）')
    })

    await checkAsync('bili_surf_status：真执行，enabled / home / logTail / 计数都在', async () => {
      const r = await runTool('bili_surf_status')
      eq(r.ok, true)
      eq(r.enabled, true, '工具返回也要带 enabled（和 /status 是同一个字段）')
      eq(r.home, join(home, 'bili-surfer'), 'home 必须指向状态目录')
      ok(typeof r.logTail === 'string', 'logTail 要是字符串')
      eq(typeof r.runsToday, 'number')
      ok(String(r.credential).includes('没有'), `没登录时要说清读不到字幕：${r.credential}`)
    })

    await checkAsync('bili_surf_search：真执行，时长必须是 "02:05" 而不是 "00:00"', async () => {
      const r = await runTool('bili_surf_search', { keyword: 'DeepSeek Harness', num: 3 })
      eq(r.ok, true)
      eq(r.count, 1)
      const it = r.items[0]
      eq(it.duration, '02:05', '搜索接口给的是字符串 "2:05"，展示出去必须是格式化后的 mm:ss')
      ok(!it.title.includes('<em'), `标题里的 <em> 要剥掉：${it.title}`)
      ok(it.play.includes('万'), `播放数要格式化：${it.play}`)
    })

    await checkAsync('bili_surf_read：真执行，游客态降级到弹幕、并把降级说出来', async () => {
      const r = await runTool('bili_surf_read', { bvid: 'BV1test0001' })
      eq(r.ok, true)
      eq(r.read, 'danmaku', '没有凭证时拿不到字幕轨，要明说是靠弹幕读到的')
      eq(r.subtitle, null)
      ok(r.danmakuSample.length > 0, '要带回弹幕样本')
      ok(String(r.commentHint).includes('默认关'), `commentHint 要说清发评论是关着的：${r.commentHint}`)
      const bad = await runTool('bili_surf_read', { bvid: '不是BV号' })
      eq(bad.ok, false, '不像 BV 号要直接拒绝')
    })

    await checkAsync('bili_surf：真跑一轮（工具 → runRound → 报告落盘），slimItem 的字段都在', async () => {
      const r = await runTool('bili_surf', { perDay: 1 })
      eq(r.ok, true)
      ok(r.picked >= 1, `至少要挑中一条：${JSON.stringify(r.stats)}`)
      ok(String(r.reportPath).startsWith(home), `报告只能写进状态目录：${r.reportPath}`)
      const it = r.items[0]
      ok(it.bvid && it.title, '条目的基本字段')
      ok(String(it.url).startsWith('https://www.bilibili.com/video/'), it.url)
      eq(it.duration, '02:05', 'slimItem 的时长也要格式化')
      ok(['subtitle', 'aiSummary', 'danmaku', 'desc'].includes(it.read), `read 只能是四种之一：${it.read}`)
      ok(it.excerpt.length > 0 && it.excerpt.length <= 481, `摘录要瘦身（别把整篇字幕塞进对话）：${it.excerpt.length} 字`)
      ok(Array.isArray(it.tags), 'tags 要是数组')
      eq(typeof it.scoreText, 'string')
    })

    await checkAsync('bili_surf_report：真执行，日报与台账都读得回来', async () => {
      const r = await runTool('bili_surf_report', {})
      eq(r.ok, true, '刚跑完一轮，当天的报告必须读得到')
      ok(String(r.text).includes('# B 站冲浪日报'), String(r.text).slice(0, 60))
      const seen = await runTool('bili_surf_report', { seen: true })
      eq(seen.ok, true)
      eq(seen.kind, 'seen')
      ok(String(seen.text).includes('BV1test0001'), '台账里要有刚看过的这条')
    })

    await checkAsync('bili_surf_comment：三道闸在工具层也生效，dryRun 下一个字节都不发', async () => {
      const off = await runTool('bili_surf_comment', { bvid: 'BV1test0001', text: '不错' })
      eq(off.ok, false, 'autoComment 关着就必须拒绝')
      await runTool('bili_surf_config', { patch: { autoComment: true, mentionName: '@冲浪助手', dryRun: true } })
      const dry = await runTool('bili_surf_comment', { bvid: 'BV1test0001', text: '看这个 https://b23.tv/x 挺好' })
      eq(dry.ok, true)
      eq(dry.dryRun, true)
      ok(String(dry.wouldSend).startsWith('@冲浪助手'), `会发什么要说清：${dry.wouldSend}`)
      ok(!String(dry.wouldSend).includes('http'), 'URL 要去掉')
      eq(stub.posts().length, 0, 'dryRun 下不许有 /x/v2/reply/add')
    })

    await checkAsync('bili_surf_login：status 不建会话、也不碰网络以外的状态', async () => {
      const r = await runTool('bili_surf_login', { action: 'status' })
      eq(r.ok, true)
      eq(typeof r.loggedIn, 'boolean')
    })
  } finally {
    stub.restore()
  }

  rmSync(home, { recursive: true, force: true })
}

/* ═══════════════════════════════════════════════ C2. 设置页（client.js）真跑一遍 */
section('C2. 设置页（client.js）真跑一遍')

/**
 * 极简 React 替身：只实现这个设置页用到的 createElement + useState/useEffect/useRef/useCallback。
 * 目的不是「正确」，而是**把 client.js 真的执行一遍** —— 它是经典脚本，静态 grep 看不出
 * `undefined is not a function` 这类错，而那正好会让设置页白屏，用户重启一次才发现。
 * 局限：hook 单元按「组件函数名」存（本页里只有 Panel/QrCode 带 hook，且各只渲染一次）。
 */
function makeFakeReact() {
  let cur = null
  const cells = new Map()
  const React = {
    createElement(type, props, ...children) {
      const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props || {}), children: kids } }
    },
    Fragment: '#fragment',
    useState(init) {
      const c = cur
      const i = c.i++
      if (!(i in c.hooks)) c.hooks[i] = typeof init === 'function' ? init() : init
      return [c.hooks[i], (v) => { c.hooks[i] = typeof v === 'function' ? v(c.hooks[i]) : v; c.dirty = true }]
    },
    useRef(init) { const c = cur; const i = c.i++; if (!(i in c.hooks)) c.hooks[i] = { current: init }; return c.hooks[i] },
    useEffect(fn) { cur.effects.push(fn) },
    useCallback(fn) { return fn },
  }
  const flat = (node, acc = '') => {
    if (node === null || node === undefined || node === true || node === false) return acc
    if (Array.isArray(node)) { for (const n of node) acc = flat(n, acc); return acc }
    if (typeof node === 'object') return flat(node.props?.children, acc)
    return acc + String(node)
  }
  const walk = (node, out) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) { for (const n of node) walk(n, out); return }
    if (typeof node !== 'object') { out.text += `${node}\n`; return }
    const { type, props } = node
    const kids = props?.children
    if (props && typeof props.onClick === 'function') out.clickables.push({ label: flat(kids).trim(), onClick: props.onClick })
    if (type === '#fragment') { walk(kids, out); return }
    if (typeof type === 'string') {
      if (type === 'canvas') {
        out.canvas++
        out.canvases = out.canvases || []
        // 假 canvas：把所有 fillRect 记下来，这样「二维码画出来长什么样」可以逐像素核对
        const ctx = { fillStyle: '', rects: [], fillRect(x, y, w, h) { this.rects.push([x, y, w, h]) } }
        node.getContext = (kind) => {
          if (kind !== '2d') throw new Error(`只支持 2d，实际要 ${kind}`)
          return ctx
        }
        if (props && props.ref && typeof props.ref === 'object') props.ref.current = node
        out.canvases.push({ node, ctx })
      }
      if ((type === 'input' || type === 'select') && props && typeof props.onChange === 'function') {
        // 受控输入的 value 会被外部 props 覆盖 —— 想验「用户打的字会不会被吃掉」就必须看到它
        out.inputs = out.inputs || []
        out.inputs.push({ kind: type, props })
      }
      if (typeof kids === 'string') out.text += `${kids}\n`
      walk(kids, out)
      return
    }
    if (typeof type === 'function') {
      const name = type.name || 'anon'
      // ⚠️ 同一类型的多个实例（Field / RawField 每个字段一个）必须各有各的 hook 槽。
      // 只按组件名存，两个输入框的 useState 会串成一个 —— 真 React 是按树里的位置区分的。
      out._inst = out._inst || {}
      const idx = (out._inst[name] = (out._inst[name] || 0) + 1)
      const key = `${name}#${idx}`
      if (!cells.has(key)) cells.set(key, { hooks: [], i: 0, effects: [], dirty: false })
      const prev = cur
      cur = cells.get(key)
      cur.i = 0
      cur.effects = []
      let tree
      try { tree = type(props) } catch (e) { throw new Error(`渲染 <${name}> 抛了：${e.message}`) }
      const effects = cur.effects
      cur = prev
      out.renders[name] = (out.renders[name] || 0) + 1
      walk(tree, out)
      // effect 按 React 的语义在提交后跑；QrCode 的 canvas ref 在真 React 里这时才非空
      for (const fn of effects) {
        let cleanup
        try { cleanup = fn() } catch (e) { throw new Error(`<${name}> 的 useEffect 抛了：${e.message}`) }
        if (typeof cleanup === 'function') out.cleanups.push({ name, cleanup })
      }
      return
    }
    throw new Error(`不认识的节点：${String(type)}`)
  }
  return { React, walk, cells, flat }
}

/** 在假的 window/document/fetch/setInterval 里执行 client.js，拿到注册的工厂。 */
function bootClient() {
  const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const styles = []
  const fetched = []
  const routes = {}
  const intervals = []
  const cleared = []
  let reg = null
  const doc = {
    head: { appendChild: (el) => { el.appended = true } },
    createElement: () => {
      const el = { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v }, remove() { this.removed = true } }
      styles.push(el)
      return el
    },
  }
  const fetchImpl = async (url, opts = {}) => {
    const key = String(url).split('?')[0]
    fetched.push({ url: String(url), method: opts.method || 'GET', credentials: opts.credentials, body: opts.body ? JSON.parse(opts.body) : undefined })
    return { json: async () => (routes[key] === undefined ? { ok: false, error: `no route ${key}` } : routes[key]) }
  }
  const win = { __ModuleLoader__: { load: (r) => { reg = r } } }
  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'console', src)(
    win, doc, fetchImpl,
    (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    (id) => { cleared.push(id) },
    console,
  )
  return { src, reg, styles, fetched, routes, intervals, cleared, win }
}

const clientEnv = bootClient()
const requiredByClient = []
const fake = makeFakeReact()
let clientPlugin = null

check('client.js 自注册：id 等于包名，factory 是函数', () => {
  ok(clientEnv.reg, '没有调用 window.__ModuleLoader__.load')
  eq(clientEnv.reg.id, 'dsh-bili-surfer', '注册 id 必须等于 package.json 的 name')
  eq(typeof clientEnv.reg.factory, 'function', 'factory 必须是函数')
  ok(!/^\s*(import|export)\s/m.test(clientEnv.src), '经典脚本不能有顶层 import/export')
})

const slotRegs = []
const clientCtx = {
  effect: (fn, label) => {
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  slots: {
    inject: (name, cb) => { slotRegs.push({ injected: name }); return cb() },
    register: (spec, comp) => { slotRegs.push({ spec, comp }); return () => {} },
  },
}

check('factory(require) 只允许 require("react")，apply() 挂样式 + 注册设置页 slot', () => {
  clientPlugin = clientEnv.reg.factory((name) => {
    requiredByClient.push(name)
    if (name === 'react') return fake.React
    throw new Error(`client.js 不许 require 别的包：${name}（会被 client bundle purity 拦下）`)
  })
  ok(clientPlugin && typeof clientPlugin.apply === 'function', 'factory 要返回带 apply 的插件对象')
  ok(Array.isArray(clientPlugin.inject) && clientPlugin.inject.includes('slots'), 'inject 必须含 slots')
  clientPlugin.apply(clientCtx)
  eq(requiredByClient.join(','), 'react', '只允许 require("react")')
  eq(slotRegs.filter((s) => s.injected).length, 1, '要 inject 一次 settings.section')
  eq(slotRegs.find((s) => s.injected)?.injected, 'settings.section')
  const regd = slotRegs.find((s) => s.spec)
  ok(regd, '没有 register 组件')
  eq(regd.spec.name, 'settings.section')
  eq(regd.spec.id, 'bili-surfer', 'slot id 要和插件名一致')
  eq(regd.spec.label, '刷B站')
  ok(typeof regd.comp === 'function', 'register 的第二个参数必须是组件函数')
  const style = clientEnv.styles[0]
  ok(style && style.appended, '样式没插进 document.head')
  eq(style.attrs['data-plugin-css'], 'dsh-bili-surfer')
  ok(String(style.textContent).includes('.bsf-wrap'), '样式内容不对')
})

const Panel = slotRegs.find((s) => s.spec)?.comp

/** 渲染一次；effect 里的 fetch 落地后 setState 会置 dirty，所以要多轮才稳定。 */
const renderSettled = async (max = 8) => {
  let out = null
  for (let i = 0; i < max; i++) {
    out = { text: '', canvas: 0, clickables: [], renders: {}, cleanups: [] }
    fake.walk(fake.React.createElement(Panel), out)
    await new Promise((r) => setImmediate(r))
    const dirty = [...fake.cells.values()].some((c) => c.dirty)
    for (const c of fake.cells.values()) c.dirty = false
    if (!dirty) return out
  }
  return out
}

/** 按按钮文字点一下；找不到就把当前所有按钮打出来（比 TypeError 好诊断）。 */
const click = async (out, label) => {
  const btn = out.clickables.find((c) => c.label === label)
  if (!btn) {
    throw new Error(`找不到按钮「${label}」；当前按钮：${out.clickables.map((c) => c.label).join(' / ') || '（一个都没有）'}\n当前文本：${out.text.replace(/\n/g, ' ⏎ ').slice(0, 300)}`)
  }
  await btn.onClick()
  await new Promise((r) => setImmediate(r))
  return renderSettled()
}

const statusFixture = {
  ok: true, version: '0.1.0', home: join('C:', 'x', '.dsh', 'bili-surfer'),
  enabled: true,
  config: { enabled: true, autoComment: false, mentionName: '', perDay: 5 },
  fields: [
    { key: 'enabled', type: 'bool', label: '总开关', note: '关掉就完全不动' },
    { key: 'perDay', type: 'num', label: '一轮几条', min: 1, max: 20 },
    { key: 'source', type: 'enum', label: '来源', values: ['search', 'popular', 'recommend'] },
  ],
  loggedIn: false, uname: '', mid: 0, hasCredential: false, running: false,
  lastRunAt: '', runsToday: 0, seenRows: 0, lastCount: 0, lastReport: '',
  logTail: '第一行日志\n第二行日志', login: { pending: false },
}

await checkAsync('设置页满血渲染：状态 / 字段 / 日志 / 按钮都在（真执行，不是 grep）', async () => {
  const first = { text: '', canvas: 0, clickables: [], renders: {}, cleanups: [] }
  fake.walk(fake.React.createElement(Panel), first)
  ok(first.text.includes('正在连插件'), `首帧应显示「正在连插件…」，实际 ${JSON.stringify(first.text.slice(0, 60))}`)

  clientEnv.routes['/api/bili-surfer/status'] = statusFixture
  const out = await renderSettled()
  const dump = () => `\n渲染文本：${out.text.replace(/\n/g, ' ⏎ ').slice(0, 400)}\n按钮：${out.clickables.map((c) => c.label).join(' / ') || '（一个都没有）'}`
  ok(out.text.includes('刷 B 站（手动跑，无定时器）'), `标题没渲染出来${dump()}`)
  ok(out.text.includes('未登录（只能读简介/弹幕）'), '未登录标签没渲染')
  ok(out.text.includes('已启用'), '启用标签没渲染')
  ok(out.text.includes('第一行日志'), '日志没渲染')
  ok(out.text.includes('台账共 0 条'), '统计没渲染')
  eq(out.renders.Field, 3, `每个字段都要渲染一行，实际 ${out.renders.Field}`)
  eq(out.canvas, 0, '没扫码时不该有 canvas')
  const labels = out.clickables.map((c) => c.label)
  for (const want of ['▶ 刷一轮', '看今天的报告', '看台账', '保存设置', '扫码登录']) {
    ok(labels.includes(want), `按钮「${want}」不见了，只有 ${labels.join(' / ')}`)
  }
  ok(clientEnv.fetched.every((f) => f.credentials === 'same-origin'), '每次请求都要带 same-origin')
  ok(clientEnv.fetched.some((f) => f.url === '/api/bili-surfer/status'), '没去要 /status')
})

await checkAsync('设置页交互：刷一轮 / 看报告 / 看台账 都打到了真后端路径', async () => {
  clientEnv.routes['/api/bili-surfer/run'] = { ok: true, started: true }
  clientEnv.routes['/api/bili-surfer/report'] = { ok: true, day: '2026-10-16', path: 'x', text: '报告正文在这里', reports: ['2026-10-16'] }
  clientEnv.routes['/api/bili-surfer/seen'] = { ok: true, path: 'x', text: '台账正文在这里' }
  let out = await renderSettled()

  await click(out, '▶ 刷一轮')
  out = await renderSettled()
  ok(clientEnv.fetched.some((f) => f.method === 'POST' && f.url === '/api/bili-surfer/run'), '没发 POST /run')
  ok(out.text.includes('已经开始了'), `跑起来的提示没出现：${out.text.slice(0, 80)}`)

  out = await click(out, '看今天的报告')
  ok(clientEnv.fetched.some((f) => f.url.startsWith('/api/bili-surfer/report')), '没要 /report')
  ok(out.text.includes('报告正文在这里'), '报告正文没渲染')
  ok(out.clickables.some((c) => c.label === '2026-10-16'), '历史报告按钮没渲染')

  out = await click(out, '看台账')
  ok(clientEnv.fetched.some((f) => f.url === '/api/bili-surfer/seen'), '没要 /seen')
  ok(out.text.includes('台账正文在这里'), '台账正文没渲染')
})

await checkAsync('扫码登录：矩阵逐像素画到 canvas + 3s 轮询 + 卸载时清掉', async () => {
  const url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=0123456789abcdef'
  const m = qrMatrix(url)
  const rows = m.modules.map((r) => r.join(''))
  clientEnv.routes['/api/bili-surfer/login/start'] = { ok: true, url, size: m.size, rows }
  clientEnv.routes['/api/bili-surfer/login/poll'] = { ok: true, status: 'scanned', text: '扫到了，等确认' }
  let out = await renderSettled()
  out = await click(out, '扫码登录')
  ok(clientEnv.fetched.some((f) => f.method === 'POST' && f.url === '/api/bili-surfer/login/start'), '没发 /login/start')
  eq(out.canvas, 1, '二维码 canvas 没画出来')

  const { node, ctx } = out.canvases[0]
  const scale = Math.max(2, Math.floor(232 / m.size))
  eq(node.width, m.size * scale, 'canvas 宽度')
  eq(node.height, m.size * scale, 'canvas 高度')
  const dark = m.modules.flat().filter(Boolean).length
  eq(ctx.rects.length, 1 + dark, `矩形数 = 1 个白底 + ${dark} 个暗模块`)
  eq(JSON.stringify(ctx.rects[0]), JSON.stringify([0, 0, node.width, node.height]), '第一笔必须是铺满整块的白底')

  // 把画出来的矩形还原成矩阵，逐格跟 qrMatrix 对比 —— 用户手机扫的就是这些像素
  const grid = Array.from({ length: m.size }, () => new Array(m.size).fill(0))
  for (const [x, y, w, h] of ctx.rects.slice(1)) {
    eq(w, scale, '暗块宽度')
    eq(h, scale, '暗块高度')
    eq(x % scale, 0, '暗块 x 要对齐网格')
    eq(y % scale, 0, '暗块 y 要对齐网格')
    grid[y / scale][x / scale] = 1
  }
  eq(grid.map((r) => r.join('')).join('\n'), rows.join('\n'), 'canvas 上的图案必须逐格等于矩阵')

  const qrId = clientEnv.intervals.findIndex((i) => i.ms === 3000) + 1
  ok(qrId > 0, '没起 3s 轮询')
  const before = clientEnv.cleared.length
  for (const c of out.cleanups) c.cleanup()
  // ⚠️ 只数「clearInterval 出现几次」不够：状态轮询清了、扫码那条没清也能过。
  // 必须点名：卸载时清掉的到底是不是**扫码那条**定时器。
  ok(clientEnv.cleared.includes(qrId), `卸载要清掉扫码那条定时器（id=${qrId}），实际清了 ${JSON.stringify(clientEnv.cleared.slice(before))}`)
})

await checkAsync('扫码轮询：登录成功后自己停；重开二维码不会留下两条 3s 定时器', async () => {
  clientEnv.routes['/api/bili-surfer/login/poll'] = { ok: true, status: 'ok' }
  const timers = clientEnv.intervals.filter((i) => i.ms === 3000)
  ok(timers.length > 0, '上一步点二维码应当留下一条 3s 轮询')
  const id = clientEnv.intervals.indexOf(timers[timers.length - 1]) + 1
  await timers[timers.length - 1].fn()
  await new Promise((r) => setImmediate(r))
  ok(clientEnv.cleared.includes(id), `登录成功后必须停掉自己那条轮询（id=${id}，实际清了 ${JSON.stringify(clientEnv.cleared)}）`)

  let out = await renderSettled()
  const label = out.clickables.some((c) => c.label === '换一张二维码') ? '换一张二维码' : '扫码登录'
  out = await click(out, label)
  const live = clientEnv.intervals.filter((i) => i.ms === 3000)
  eq(live.length, timers.length + 1, '重开二维码只该多出一条 3s 定时器（旧的必须先停）')
})

await checkAsync('设置页：报告/台账读失败要说「读失败」，不能假装成「你还没点过」', async () => {
  clientEnv.routes['/api/bili-surfer/report'] = { ok: false, error: 'ENOENT: 报告文件不见了' }
  let out = await renderSettled()
  out = await click(out, '看今天的报告')
  ok(out.text.includes('ENOENT'), `读失败必须把错误原文显示出来：${out.text.replace(/\n/g, ' ⏎ ').slice(0, 220)}`)
  ok(!out.text.includes('点上面的「看今天的报告」'), '读失败时不许再显示「你还没点过」那句')

  clientEnv.routes['/api/bili-surfer/seen'] = { ok: false, error: 'EACCES: 台账读不了' }
  out = await click(out, '看台账')
  ok(out.text.includes('EACCES'), `台账读失败也要显示：${out.text.replace(/\n/g, ' ⏎ ').slice(0, 220)}`)
  // 收尾：把路由还回好用的形状，免得影响后面的用例
  clientEnv.routes['/api/bili-surfer/report'] = { ok: true, day: '2026-10-16', path: 'x', text: '报告正文在这里', reports: ['2026-10-16'] }
  clientEnv.routes['/api/bili-surfer/seen'] = { ok: true, path: 'x', text: '台账正文在这里' }
})

await checkAsync('设置页输入框：列表分隔符打得进去；清空数字框不许把值改成下限', async () => {
  clientEnv.routes['/api/bili-surfer/status'] = {
    ...statusFixture,
    config: { keywords: ['DeepSeek'], perDay: 5 },
    fields: [
      { key: 'keywords', type: 'list', label: '关键词', note: '用、或空格分隔' },
      { key: 'perDay', type: 'num', label: '一轮几条', min: 3, max: 20 },
    ],
  }
  let out = await renderSettled()
  const pick = (o, pred) => (o.inputs || []).find(pred)
  const kwSel = (i) => i.props.placeholder === '用、或空格分隔'
  const kw = pick(out, kwSel)
  ok(kw, 'list 字段要渲染成输入框')
  eq(kw.props.value, 'DeepSeek', '初值来自 config')

  // ⚠️ 用户正在打第二个词：下一次渲染的 value 必须还是他打的原样。
  // 以前受控 input 每次渲染都过 asList().join('、')，分隔符当场被吃掉 —— 第二个词永远打不进去。
  await kw.props.onChange({ target: { value: 'DeepSeek、' } })
  out = await renderSettled()
  eq(pick(out, kwSel).props.value, 'DeepSeek、', '分隔符必须留在框里')
  await pick(out, kwSel).props.onChange({ target: { value: 'DeepSeek、Harness 插件' } })
  out = await renderSettled()
  eq(pick(out, kwSel).props.value, 'DeepSeek、Harness 插件', '边打边显示原样')

  // 数字框清空 → 以前立刻变 0，保存时被 clamp 抬到下限（偷偷改了用户的条数）
  const numSel = (i) => i.props.type === 'number'
  const num = pick(out, numSel)
  ok(num, 'num 字段要渲染成输入框')
  await num.props.onChange({ target: { value: '' } })
  out = await renderSettled()
  eq(pick(out, numSel).props.value, '', '清空就是空着，别自作主张变 0')

  const saveBtn = out.clickables.find((c) => c.label.startsWith('保存设置'))
  // 保存后要说清「改了什么 / 有没有白改」：空保存、被白名单丢掉的键，都要看得见。
  clientEnv.routes['/api/bili-surfer/config'] = { ok: true, changed: ['perDay', 'keywords'], ignored: ['evil'], config: { keywords: ['DeepSeek', 'Harness', '插件'], perDay: 5 } }
  await saveBtn.onClick()
  out = await renderSettled()
  ok(out.text.includes('perDay'), `保存提示要点出改动的键：${out.text.replace(/\n/g, ' ⏎ ').slice(0, 220)}`)
  ok(out.text.includes('evil'), '被白名单丢掉的键要在提示里点名')
  const posts = clientEnv.fetched.filter((f) => f.method === 'POST' && f.url === '/api/bili-surfer/config')
  ok(posts.length > 0, '点保存要发 POST /config')
  const patch = posts[posts.length - 1].body.patch
  eq(patch.perDay, 5, '清空数字框不许把条数改成下限')
  eq(JSON.stringify(patch.keywords), JSON.stringify(['DeepSeek', 'Harness', '插件']), '关键词照样按分隔符切')

  // 什么都没改（把数字重新打一遍同样的值，dirty 变 true 但 changed 为空）→ 提示要说「没有改动」
  clientEnv.routes['/api/bili-surfer/config'] = { ok: true, changed: [], ignored: [], config: { keywords: ['DeepSeek', 'Harness', '插件'], perDay: 5 } }
  out = await renderSettled()
  await pick(out, numSel).props.onChange({ target: { value: '5' } })
  out = await renderSettled()
  const again = out.clickables.find((c) => c.label.startsWith('保存设置'))
  ok(again, '重新打过一遍值之后，保存按钮要能点')
  await again.onClick()
  out = await renderSettled()
  ok(out.text.includes('没有改动'), `空保存要说「没有改动」：${out.text.replace(/\n/g, ' ⏎ ').slice(0, 220)}`)
})

/* ═══════════════════════════════════════════════════ D. 源码不变式 */
section('D. 源码不变式（防「静默不激活」）')

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const hostFiles = ['index.js', 'lib/net.js', 'lib/bili.js', 'lib/state.js', 'lib/surf.js', 'lib/report.js', 'lib/tools.js', 'lib/qr.js']

/** 去掉注释再检查裸 import —— 注释里举反例（如 lib/tools.mjs 顶部的说明）不该被当成违规。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

check('没有任何裸 import @deepseek-ai/*（桌面版 autoInstallPeers=false，会让整条插件不激活）', () => {
  for (const f of hostFiles) {
    const src = stripComments(read(f))
    ok(!/^\s*import\s[^\n]*from\s+['"]@deepseek-ai\//m.test(src), `${f} 里有裸 import`)
    ok(!/require\(\s*['"]@deepseek-ai\//.test(src), `${f} 里有裸 require`)
    ok(!/^\s*import\s+['"]@deepseek-ai\//m.test(src), `${f} 里有裸副作用 import`)
  }
})

check('宿主侧没有常驻定时器（setInterval / 长 setTimeout）', () => {
  for (const f of hostFiles) {
    const src = read(f)
    ok(!/setInterval\s*\(/.test(src), `${f} 里有 setInterval`)
    ok(!/setTimeout\s*\(/.test(src) || f === 'lib/bili.js', `${f} 里不该有 setTimeout（bili.mjs 的 sleep 例外）`)
  }
  const cli = read('client.js')
  ok((cli.match(/clearInterval/g) || []).length >= 2, 'client.js 里的轮询必须有清理')
  ok(!/setInterval/.test(read('index.js')), 'index.js 不许有定时器')
})

// ⚠️ 回归：源码是 TS，跑的是编译产物。改了 src 忘了 build，dsh 就会继续跑旧代码，而且**一声不响**
// （/status 的 build 指纹算的是编译产物，它只会如实地告诉你「旧产物没变」）。这条只有比 mtime 拦得住。
check('TS 源码与编译产物对得上（改了 src 就要 build，别让 dsh 跑旧代码）', () => {
  const pairs = [['src/index.ts', 'index.js'], ['src/client.ts', 'client.js']]
  for (const f of readdirSync(join(ROOT, 'src/lib'))) {
    if (f.endsWith('.ts')) pairs.push([`src/lib/${f}`, `lib/${f.replace(/\.ts$/, '.js')}`])
  }
  ok(pairs.length >= 9, `源码/产物对只有 ${pairs.length} 对，src 目录是不是读错了`)
  for (const [src, out] of pairs) {
    let so = 0
    let oo = 0
    try { so = statSync(join(ROOT, src)).mtimeMs } catch { ok(false, `源码不见了：${src}`); continue }
    try { oo = statSync(join(ROOT, out)).mtimeMs } catch { ok(false, `编译产物不见了：${out}（先跑 pnpm run build）`); continue }
    // 1 秒容差：文件系统的 mtime 粒度 + 同一秒内写完两个文件
    ok(oo >= so - 1000, `${out} 比 ${src} 旧 —— 改了 ts 忘了 build（dsh 会继续跑旧代码）`)
  }
  // 只留一套实现：老的 .mjs 不许回来（两套实现并存 = 改一处、跑另一处）
  for (const f of readdirSync(join(ROOT, 'lib'))) {
    ok(!f.endsWith('.mjs'), `lib/${f} 是旧的 JS 实现，应该只留编译出来的 .js`)
  }
})

// ⚠️ 回归：打过真 HTTP 的脚本不许在结尾 process.exit() —— 退出时和 undici 关 keep-alive socket 抢时序
// 会撞 libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），退出码变成 -1073740791，
// 恰好把「33 项过了 6 项没过」这种人话淹进崩溃信息里（实测 process.exit 4 次崩 3 次）。见 AGENTS 规矩 23。
check('检查脚本不用 process.exit() 收尾（改成 process.exitCode，让事件循环自己排空）', () => {
  for (const f of ['selfcheck.host.mjs', 'selfcheck.live.mjs', 'selfcheck.mjs']) {
    ok(!/^\s*process\.exit\(/m.test(stripComments(read(f))), `${f} 里还有 process.exit(`)
  }
  // 参数校验那几处允许保留（发生在联网之前）
  const round = stripComments(read('selfcheck.round.mjs'))
  ok((round.match(/process\.exit\(/g) || []).length <= 3, 'selfcheck.round.mjs 的 process.exit 只该出现在参数校验里')
})

// ⚠️ 回归：「本机状态目录 × 本地代码」那一节必须不依赖活进程（DSH 没开、或者只有旧构建时也要能跑），
// 而且不许被挪到联网之后 —— 它是「升级后老装机状态还能不能被现在的代码读懂」的唯一一处检查。
check('selfcheck.host.mjs：本机状态目录这一节先跑、不依赖活进程，两条路径都出总结', () => {
  const src = stripComments(read('selfcheck.host.mjs'))
  const at = src.indexOf('本机状态目录 × 本地代码')
  const firstReq = src.indexOf('await req(')
  ok(at >= 0, '要有「本机状态目录 × 本地代码」这一节')
  ok(at >= 0 && firstReq > 0 && at < firstReq, '这一节必须在第一次联网之前（DSH 没起来时也要能告诉你状态目录读不读得动）')
  ok(/countSeen/.test(src) && /parseSeen/.test(src), '要拿 parseSeen 与 countSeen 对账（三个入口必须同一口径）')
  ok(/buildStamp=/.test(src), '要打印磁盘源码指纹（重启后 /status.build 应该等于它）')
  ok(
    /if \(!st\) \{[\s\S]{0,200}?hostMissing = true[\s\S]{0,200}?printSummary\(\)/.test(src),
    '拿不到 /status 时也要出总结，而且不许说「契约一致」',
  )
})

// ⚠️ 回归：卡住的那一轮不会自己解锁（没有任何东西会来解锁），用户只能重启 dsh。
// 锁必须能超时自我释放，而且**两个忙判定入口**都要先释放再判忙。
check('index.js：一轮的锁带「卡住就释放」的兜底，两处忙判定都先释放再判忙', () => {
  const src = read('index.js')
  ok(/const releaseStale = \(\) =>/.test(src), '必须有 releaseStale()')
  ok(/lastStale/.test(src), '释放过要留痕（/status 里看得见 lastStale）')
  const lines = src.split('\n')
  const guards = lines.filter((l) => /if \(round\.running\)/.test(l))
  eq(guards.length, 2, `忙判定应当只有两处（doRound 与 POST /run），实际 ${guards.length}`)
  for (let i = 0; i < lines.length; i++) {
    if (!/if \(round\.running\)/.test(lines[i])) continue
    ok(/releaseStale\(\)/.test(lines[i - 1] || ''), `忙判定前一行必须先 releaseStale()：${lines[i - 1]} || ${lines[i]}`)
  }
})

check('client.js 是经典脚本：无顶层 import/export，且 id 等于包名', () => {
  const src = read('client.js')
  ok(!/^\s*import\s/m.test(src), '不许有 import')
  ok(!/^\s*export\s/m.test(src), '不许有 export')
  ok(src.includes('window.__ModuleLoader__.load({'), '必须有 __ModuleLoader__.load')
  ok(/id:\s*'dsh-bili-surfer'/.test(src), 'id 必须是包名 dsh-bili-surfer')
  const reqs = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
  eq([...new Set(reqs)].join(','), 'react', `只许 require react，实际 ${reqs.join(',')}`)
  ok(src.includes("'settings.section'"), '要挂到设置页')
})

check('package.json：形状、bundle、client、engines，且不声明 @deepseek-ai 依赖', () => {
  const pkg = JSON.parse(read('package.json'))
  eq(pkg.name, 'dsh-bili-surfer', 'name')
  eq(pkg.type, 'module', 'type')
  eq(pkg.main, 'index.js', 'main')
  eq(pkg.exports['.'], './index.js', 'exports["."]')
  eq(pkg.exports['./client'], './client.js', 'exports["./client"]')
  eq(pkg.exports['./package.json'], './package.json')
  eq(pkg.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch')
  eq(pkg.dsh.client.platform, 'web', 'dsh.client.platform')
  ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'), 'client.inject')
  ok(pkg.engines.node, 'engines.node 必须有')
  eq(pkg.engines.dsh, undefined, '不写 engines.dsh：写错了内核会静默跳过整条插件')
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}), ...(pkg.devDependencies || {}) })
  ok(!deps.some((d) => d.startsWith('@deepseek-ai/')), `不许声明 @deepseek-ai 依赖：${deps.join(',')}`)
  ok(!pkg.scripts || !/postinstall/.test(JSON.stringify(pkg.scripts)), '不许有 postinstall 之类的东西')
})

check('cordis.patch.yml 的 id 与插件 id 一致（对不上设置页就认不出 entry）', () => {
  const yml = read('cordis.patch.yml')
  ok(/id:\s*bili-surfer\b/.test(yml), yml)
  ok(/name:\s*dsh-bili-surfer\b/.test(yml), yml)
})

check('prompts/surfer.md 存在且含关键小节', () => {
  const md = read('prompts/surfer.md')
  ok(md.length > 1500, `章程太短：${md.length}`)
  for (const kw of ['素材', '@', '台账']) ok(md.includes(kw), `章程缺「${kw}」`)
})

check('四个 selfcheck 入口都在', () => {
  for (const f of ['selfcheck.mjs', 'selfcheck.live.mjs', 'selfcheck.round.mjs', 'selfcheck.host.mjs']) {
    ok(existsSync(join(ROOT, f)), `${f} 不存在`)
  }
})

/* ═════════════════════════════════════════════════════ E. 写路径（唯一会发东西出去的地方） */

section('E. 写路径：发评论与可见性复核（把 fetch 打桩，真跑 runRound）')

/**
 * 把 b 站的读接口全打桩，只记录请求；写接口（reply/add）的成败可控。
 * 这是唯一能验证「什么情况下会真的发出去」的办法 —— 真网络里我们不敢试。
 */
function stubBili() {
  const real = globalThis.fetch
  const calls = []
  const state = { posted: null, visibilityFails: false }
  const now = Math.floor(Date.now() / 1000) - 3600
  const res = (body, json = true) => ({
    ok: true,
    status: 200,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => (json ? JSON.stringify(body) : String(body)),
  })
  const BV = 'BV1test0001'
  globalThis.fetch = async (u, init = {}) => {
    const s = String(u)
    const url = s.split('?')[0]
    const body = init.body ? String(init.body) : ''
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers || {} })
    if (s.includes('/x/web-interface/nav')) {
      return res({ code: 0, data: {
        isLogin: true, uname: '测试用户', mid: 42,
        wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
        },
      } })
    }
    if (s.includes('finger/spi')) return res({ code: 0, data: { b_3: 'buv3', b_4: 'buv4' } })
    if (s.includes('/x/web-interface/search/type')) {
      return res({ code: 0, data: { result: [{
        bvid: BV, aid: 123456, title: '【测试】<em class="keyword">手写</em>插件实录', author: '某UP', mid: 7,
        // 真接口给的就是字符串（"16:33"），stub 必须照抄这个形状，否则钉不住统一化那一步
        play: 12000, video_review: 30, review: 3, duration: '2:05', pubdate: now,
        description: '简介里别放指令', tag: 'AI,编程', pic: '//i0.hdslb.com/x.jpg',
      }] } })
    }
    // ⚠️ `conclusion/get` 的 URL 里也含 `/x/web-interface/view` —— 这里必须先把它排除掉，
    // 否则下面的 view 分支会先命中，摘要用例的分支变成死代码（AI 摘要的回包形状就再没被验过）。
    if (s.includes('/x/web-interface/view') && !s.includes('conclusion/get')) {
      return res({ code: 0, data: {
        bvid: BV, aid: 123456, cid: 999, title: '【测试】手写插件实录', desc: '简介里别放指令',
        duration: 125, pubdate: now, tname: '科技', pic: '//i0.hdslb.com/x.jpg',
        pages: [{ cid: 999, page: 1, part: 'P1', duration: 125 }],
        owner: { mid: 7, name: '某UP' },
        stat: { view: 12000, danmaku: 30, reply: 3, like: 100, coin: 5, favorite: 6, share: 1 },
      } })
    }
    if (s.includes('/x/player/wbi/v2')) {
      return res({ code: 0, data: { subtitle: { subtitles: [{
        lan: 'ai-zh', lan_doc: '中文（AI）', ai_status: 2,
        subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/x.json?auth_key=1',
      }] } } })
    }
    if (s.includes('aisubtitle.hdslb.com')) {
      return res({ body: [
        { from: 0, to: 2, location: 2, content: '第一句话。' },
        { from: 2, to: 4, location: 2, content: '第二句话。' },
      ] })
    }
    if (s.includes('conclusion/get')) {
      // 真接口对游客回 -403（见 AGENTS 的接口表）。stub 也要照抄这个边界：
      // 否则游客态会被一条假摘要「升级」成 aiSummary，降级用例就变成在测空气。
      const cookie = String(init.headers?.Cookie || '')
      if (!cookie.includes('SESSDATA=')) return res({ code: -403, message: '访问权限不足' })
      return res({ code: 0, data: { model_result: { summary: '讲了点东西', outline: [{ title: '一', part_outline: ['a'] }] } } })
    }
    if (s.includes('dm/list.so')) {
      return res('<?xml version="1.0" encoding="UTF-8"?><i><d p="1,1,25,16777215,1,0,0,1">哈哈哈哈</d><d p="2,1,25,16777215,1,0,0,2">这个思路确实清楚</d></i>', false)
    }
    if (s.includes('tag/archive/tags')) return res({ code: 0, data: [{ tag_name: 'AI' }, { tag_name: '编程' }] })
    if (url.endsWith('/x/v2/reply/add')) {
      state.posted = { rpid: '555', body }
      return res({ code: 0, data: { reply: { rpid_str: '555', ctime: now, content: { message: 'x' } } } })
    }
    if (s.includes('/x/v2/reply/wbi/main')) {
      if (state.visibilityFails) throw new Error('stub：读评论炸了')
      const rpid = state.posted ? '555' : '1'
      return res({ code: 0, data: { replies: [{
        // 真实回包两个字段都给：rpid 是数字、rpid_str 是字符串。
        rpid: state.bigRpid ? 9007199254740992 : Number(rpid),
        rpid_str: state.bigRpid ? '9007199254740993' : rpid,
        member: { uname: state.posted ? '我' : '甲' },
        content: { message: '不错' }, like: 3, ctime: now,
      }] } })
    }
    throw new Error(`stub 没预料到的请求：${s}`)
  }
  return {
    calls, state,
    posts: () => calls.filter((c) => c.url.endsWith('/x/v2/reply/add')),
    restore: () => { globalThis.fetch = real },
  }
}

const loggedCli = (extra = {}) => newClient({ cookies: { sessdata: 'S', bili_jct: 'J', ...extra } })

await checkAsync('searchVideos：搜索接口的 duration 是 "2:05" 字符串，出来必须是 125 秒', async () => {
  const stub = stubBili()
  try {
    const found = await searchVideos(loggedCli(), '测试', { num: 1 })
    eq(found.length, 1, '要搜到那条')
    eq(found[0].duration, 125, '字符串时长要统一成秒，否则日报与工具输出全是 00:00')
    eq(found[0].title, '【测试】手写插件实录', '标题里的 <em> 要剥掉')
    eq(found[0].pic, 'https://i0.hdslb.com/x.jpg', '// 开头的图要补 https')
    eq(found[0].danmaku, 30, '弹幕数取 video_review')
    eq(found[0].reply, 3, '评论数取 review')
  } finally { stub.restore() }
})

await checkAsync('sendComment：没登录 / 空内容 / 超长 都拒绝，且被拒绝时一个请求都不发', async () => {
  const guest = newClient({})
  let msg = ''
  try { await sendComment(guest, { aid: 1, text: '你好' }) } catch (e) { msg = e.message }
  ok(/没有登录/.test(msg), `游客态要拒绝，实际：${msg}`)

  const stub = stubBili()
  try {
    const cli = loggedCli()
    try { await sendComment(cli, { aid: 1, text: '   ' }) } catch (e) { msg = e.message }
    ok(/为空/.test(msg), `空内容要拒绝，实际：${msg}`)
    try { await sendComment(cli, { aid: 1, text: '啊'.repeat(1001) }) } catch (e) { msg = e.message }
    ok(/太长/.test(msg), `超长要拒绝，实际：${msg}`)
    eq(stub.posts().length, 0, '被拒绝的评论不许留下任何 /x/v2/reply/add 请求')
  } finally { stub.restore() }
})

await checkAsync('sendComment：表单字段齐全、csrf 来自 bili_jct、正文是 normalizeComment 之后的样子', async () => {
  const stub = stubBili()
  try {
    const r = await sendComment(loggedCli(), { aid: 123456, text: '第一句话' })
    const post = stub.posts()[0]
    ok(post, '要真的打 /x/v2/reply/add')
    eq(post.method, 'POST', '必须是 POST')
    const form = new URLSearchParams(post.body)
    eq(form.get('oid'), '123456', 'oid 要等于 aid')
    eq(form.get('type'), '1', 'type 1 = 视频')
    eq(form.get('message'), '第一句话')
    eq(form.get('csrf'), 'J', 'csrf 必须来自 bili_jct（不带上必被拒）')
    eq(form.get('root'), '0')
    eq(form.get('parent'), '0')
    ok(String(post.headers['Content-Type'] || '').includes('form-urlencoded'), '要按表单提交')
    eq(r.rpid, '555', 'rpid 要取 rpid_str')
  } finally { stub.restore() }
})

await checkAsync('isCommentVisible：在列表里 → true；不在 → false；读不到 → null（不确定 ≠ 没发出去）', async () => {
  const stub = stubBili()
  try {
    const cli = loggedCli()
    eq(await isCommentVisible(cli, 123456, '1'), true, '列表里有这个 rpid')
    eq(await isCommentVisible(cli, 123456, '999'), false, '列表里没有')
    // rpid 是 int64：JSON 里的 number 会丢精度，必须靠 rpid_str 认。
    stub.state.bigRpid = true
    eq(await isCommentVisible(cli, 123456, '9007199254740993'), true, '大 rpid 要用 rpid_str 比，别用被丢精度的 number')
    stub.state.bigRpid = false
    stub.state.visibilityFails = true
    eq(await isCommentVisible(cli, 123456, '555'), null, '读不到时必须回 null，别当成没发出去')
  } finally { stub.restore() }
})

const WRITE_CFG = { ...DEFAULTS, keywords: ['测试'], perDay: 1, autoComment: true, mentionName: '冲浪助手' }

await checkAsync('runRound 写闸门 dryRun=false：只真发一条、带 @、过 commentMax、复核可见性、台账记「评论」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsr-write-'))
  const stub = stubBili()
  try {
    saveCredential(dir, { sessdata: 'S', bili_jct: 'J', buvid3: 'B', dedeuserid: '42' })
    const logs = []
    const res = await runRound({
      dir,
      cfg: { ...WRITE_CFG, dryRun: false },
      log: (m) => logs.push(m),
      commentWriter: () => '这个视频讲得挺清楚，我也去试试',
    })
    ok(res.ok, 'runRound 要成功返回')
    const posts = stub.posts()
    eq(posts.length, 1, `一轮只许真发一条评论，实际 ${posts.length}`)
    const msg = new URLSearchParams(posts[0].body).get('message')
    ok(msg.startsWith('@冲浪助手'), `评论要自动补 @：${msg}`)
    ok(msg.includes('讲得挺清楚'), `正文要原样带上：${msg}`)
    ok(msg.length <= DEFAULTS.commentMax + 1, `正文要过 commentMax（${DEFAULTS.commentMax}）：${msg.length}`)
    const seen = readText(join(dir, 'seen.md'))
    ok(/\|\s*评论\s*\|/.test(seen), `台账备注要写「评论」：\n${seen}`)
    ok(seen.includes('555'), '台账要记下 rpid（下一轮才不会重复评）')
    const report = readText(join(dir, 'out', `${dayKey()}.md`))
    ok(report.includes('本轮评论'), '报告里要有本轮评论')
    ok(logs.some((l) => l.includes('已评论') && l.includes('可见性')), '日志要留下 rpid 与可见性')
    // 日志归一个人写：宿主注入了 log，surf.mjs 就不该再往同一个文件写第二份。
    const own = readText(join(dir, 'surf.log'))
    eq((own.match(/一轮开始/g) || []).length, 0, `注入了 log 时 surf.mjs 不该自己再写一份 surf.log：\n${own}`)
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }) }
})

await checkAsync('runRound 写闸门 dryRun=true：一个字节都不发出去，报告与台账都标「演练」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsr-write-dry-'))
  const stub = stubBili()
  try {
    saveCredential(dir, { sessdata: 'S', bili_jct: 'J', buvid3: 'B', dedeuserid: '42' })
    await runRound({
      dir,
      cfg: { ...WRITE_CFG, dryRun: true },
      log: () => {},
      commentWriter: () => '演练用的正文',
    })
    eq(stub.posts().length, 0, 'dryRun 下不许有任何 /x/v2/reply/add')
    const seen = readText(join(dir, 'seen.md'))
    ok(seen.includes('演练（没真发）'), `台账要标演练：\n${seen}`)
    ok(readText(join(dir, 'out', `${dayKey()}.md`)).includes('演练'), '报告里也要标明是演练')
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }) }
})

await checkAsync('runRound 写闸门 autoComment=true 但没 @ 对象：根本不问助手要正文，也不发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsr-write-noat-'))
  const stub = stubBili()
  let asked = 0
  try {
    saveCredential(dir, { sessdata: 'S', bili_jct: 'J', buvid3: 'B', dedeuserid: '42' })
    const logs = []
    await runRound({
      dir,
      cfg: { ...WRITE_CFG, mentionName: '', dryRun: false },
      log: (m) => logs.push(m),
      commentWriter: () => { asked += 1; return '不该被问到' },
    })
    eq(asked, 0, '没有 @ 对象时不许向助手要评论正文')
    eq(stub.posts().length, 0, '没有 @ 对象时不许发评论')
    ok(logs.some((l) => l.includes('mentionName 为空')), '要留一句日志说明为什么没发')
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }) }
})

await checkAsync('runRound 没注入 log 时自己写 surf.log，且每行只许出现一次（不许两份格式）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsr-log-'))
  const stub = stubBili()
  try {
    saveCredential(dir, { sessdata: 'S', bili_jct: 'J', buvid3: 'B', dedeuserid: '42' })
    await runRound({ dir, cfg: { ...WRITE_CFG, perDay: 1, dryRun: true } })
    const text = readText(join(dir, 'surf.log'))
    ok(text.includes('一轮开始'), `没有注入 log 时得自己落盘：\n${text}`)
    eq((text.match(/一轮开始/g) || []).length, 1, `同一件事故只能写一行：\n${text}`)
    ok(!/^\[\d{4}-\d\d-\d\dT/m.test(text), `日志里不许再有 [iso] 前缀（那是写了两遍的指纹）：\n${text}`)
    ok(/^\d{4}-\d\d-\d\dT[\d:.]+Z {2}\S/m.test(text), `日志格式要跟宿主那份一致（iso 后两个空格）：\n${text}`)
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }) }
})

await checkAsync('runRound：字幕摘录的「N 字」是字数不是行数，且 surf 不许在这里预截断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsr-sub-'))
  const stub = stubBili()
  try {
    saveCredential(dir, { sessdata: 'S', bili_jct: 'J', buvid3: 'B', dedeuserid: '42' })
    // excerptChars 故意开得比字幕还小：截断必须发生在 renderReport 里，而不是 surf 里
    const res = await runRound({
      dir,
      cfg: { ...WRITE_CFG, perDay: 1, autoComment: false, dryRun: true, excerptChars: 6 },
      log: () => {},
    })
    const it = res.items?.[0]
    ok(it?.subtitle?.text, 'stub 有字幕轨，这一轮应当读到字幕')
    const n = [...it.subtitle.text].length
    ok(it.subtitle.text.length > 6, `surf 里不许预截断（预截断了报告就永远说不出「原文多少字」）：${JSON.stringify(it.subtitle.text)}`)
    eq(it.subtitle.chars, n, `chars 要是字数（实际 ${it.subtitle.chars} / ${n}）`)
    ok(it.subtitle.chars !== 2, `stub 那两条字幕是 2 行，以前这里填的就是行数 2（现在 ${it.subtitle.chars}）`)
    const md = readText(join(dir, 'out', `${dayKey()}.md`))
    ok(md.includes(`内容摘录**（字幕（ai-zh，AI，${n} 字））`), `标题要写清来源与字数：${(md.match(/内容摘录[^\n]*/) || [''])[0]}`)
    ok(md.includes(`（摘录到此，原文 ${n} 字）`), `超上限必须留痕，且字数与标题一致：${md.slice(0, 600)}`)
  } finally { stub.restore(); rmSync(dir, { recursive: true, force: true }) }
})

/* ═════════════════════════════════════════════════════════════════ 汇总 */
await hostTests()

const failed = results.filter((r) => !r.ok)
const bySection = {}
for (const r of results) {
  bySection[r.section] = bySection[r.section] || { ok: 0, bad: 0 }
  bySection[r.section][r.ok ? 'ok' : 'bad']++
}
console.log('\n' + '═'.repeat(70))
for (const [s, v] of Object.entries(bySection)) {
  console.log(`${v.bad ? '✗' : '✓'} ${s}  ${v.ok} 通过${v.bad ? ` / ${v.bad} 失败` : ''}`)
}
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length) {
  console.log('\n失败清单：')
  for (const f of failed) console.log(`  ✗ [${f.section}] ${f.name}\n      ${f.err}`)
}
console.log('═'.repeat(70))
// ⚠️ 别用 process.exit()：见 AGENTS.md 规矩 22 —— 退出时和 undici 关 socket 抢时序会撞 libuv 断言。
process.exitCode = failed.length ? 1 : 0
