/**
 * lib/qr.mjs —— 纯 JS 二维码编码器（字节模式，ECC 等级 M，版本 1–20）
 * ============================================================================
 * 为什么要自己写：扫码登录必须在本机画二维码。参考实现是 spawn 一个装了
 * `qrcode[pil]` 的 venv 让 Python 画 —— 那正是「第一次用要先装几分钟环境」的来源。
 * 把登录 URL 交给第三方 QR 服务（api.qrserver.com 之类）也不行：那串 URL 里带着
 * 登录 token，等于把凭证递出去 ✗。
 *
 * 所以：**只实现登录 URL 真正需要的那一小条路**（字节模式 + ECC M + v1–v20），
 * 完整按 ISO/IEC 18004 写：GF(256) 里德-所罗门纠错、掩码择优、格式/版本信息 BCH。
 * 输出是一张 0/1 矩阵，交给浏览器画在 <canvas> 上。
 * ============================================================================
 */

// ------------------------------------------------------------------ GF(256)

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d // QR 用的本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** 生成多项式 g(x) = ∏(x - α^i)，i=0..deg-1 */
function genPoly(deg) {
  let g = [1]
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]
      next[j + 1] ^= gfMul(g[j], EXP[i])
    }
    g = next
  }
  return g
}

/** 多项式除法取余：得到 ecLen 个纠错码字 */
function rsEC(data, ecLen) {
  const g = genPoly(ecLen)
  const rem = new Array(ecLen).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(g[i + 1], factor)
    }
  }
  return rem
}

// ------------------------------------------------------------------ 版本表

/**
 * ECC 等级 M 的 RS 分块表（版本 1–20）。
 * [总数据码字数, 每块纠错码字数, [ [块数, 每块数据码字数], ... ]]
 */
const ECC_M = [
  null,
  [16, 10, [[1, 16]]],
  [28, 16, [[1, 28]]],
  [44, 26, [[1, 44]]],
  [64, 18, [[2, 32]]],
  [86, 24, [[2, 43]]],
  [108, 16, [[4, 27]]],
  [124, 18, [[4, 31]]],
  [154, 22, [[2, 38], [2, 39]]],
  [182, 22, [[3, 36], [2, 37]]],
  [216, 26, [[4, 43], [1, 44]]],
  [254, 30, [[1, 50], [4, 51]]],
  [290, 22, [[6, 36], [2, 37]]],
  [334, 22, [[8, 37], [1, 38]]],
  [365, 24, [[4, 40], [5, 41]]],
  [415, 24, [[5, 41], [5, 42]]],
  [453, 28, [[7, 45], [3, 46]]],
  [507, 28, [[10, 46], [1, 47]]],
  [563, 26, [[9, 43], [4, 44]]],
  [627, 26, [[3, 44], [11, 45]]],
  [669, 26, [[3, 41], [13, 42]]],
]

/** 校准图案中心坐标 */
const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90],
]

/** 末尾补位比特（放完码字后还空着的模块数） */
const REMAINDER = [
  0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0,
  3, 3, 3, 3, 3, 3, 3,
]

// ------------------------------------------------------------------ BCH

/** 版本信息（v≥7）：6 位版本 + 12 位 BCH(18,6)，生成多项式 0x1F25 */
function versionBits(version) {
  let d = version << 12
  for (let i = 17; i >= 12; i--) if (d & (1 << i)) d ^= 0x1f25 << (i - 12)
  return ((version << 12) | d) & 0x3ffff
}

/** 格式信息：2 位 ECC 等级 + 3 位掩码 + 10 位 BCH(15,5)，再异或 0x5412 */
function formatBits(mask) {
  const ecc = 0b00 // M
  const data = (ecc << 3) | mask
  let d = data << 10
  for (let i = 14; i >= 10; i--) if (d & (1 << i)) d ^= 0x537 << (i - 10)
  return (((data << 10) | d) ^ 0x5412) & 0x7fff
}

// ------------------------------------------------------------------ 编码

function pickVersion(byteLen) {
  for (let v = 1; v <= 20; v++) {
    const [dataWords] = ECC_M[v]
    const countBits = v < 10 ? 8 : 16
    const need = Math.ceil((4 + countBits + byteLen * 8) / 8)
    if (need <= dataWords) return v
  }
  return 0
}

/** 文本 → 数据码字（模式指示符 + 长度 + 内容 + 终止符 + 填充） */
function encodeData(text, version) {
  const bytes = new TextEncoder().encode(text)
  const [dataWords] = ECC_M[version]
  const bits = []
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1) }
  push(0b0100, 4) // 字节模式
  push(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  // 终止符最多 4 位，然后补齐到字节边界
  for (let i = 0; i < 4 && bits.length < dataWords * 8; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const words = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    words.push(b)
  }
  // 填充字节 0xEC / 0x11 交替
  let pad = 0
  while (words.length < dataWords) words.push(pad++ % 2 === 0 ? 0xec : 0x11)
  return words
}

/** 按分块表拆数据 → 各自算纠错 → 交错成一个码字序列 */
function interleave(words, version) {
  const [, ecLen, groups] = ECC_M[version]
  const blocks = []
  let at = 0
  for (const [count, per] of groups) {
    for (let i = 0; i < count; i++) {
      const data = words.slice(at, at + per)
      at += per
      blocks.push({ data, ec: rsEC(data, ecLen) })
    }
  }
  const out = []
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i])
  return out
}

// ------------------------------------------------------------------ 画矩阵

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
]

function makeMatrix(version) {
  const size = version * 4 + 17
  const m = Array.from({ length: size }, () => new Array(size).fill(-1)) // -1 = 空
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return
    m[r][c] = v
    fixed[r][c] = true
  }

  // 三个定位图案 + 分隔带
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        set(row + r, col + c, dark ? 1 : 0)
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0
    set(6, i, v)
    set(i, 6, v)
  }

  // 校准图案（跳过与定位图案重叠的三个角）
  const centers = ALIGN[version]
  for (const r of centers) {
    for (const c of centers) {
      const corner = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)
      if (corner) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          set(r + dr, c + dc, dark ? 1 : 0)
        }
      }
    }
  }

  // 格式信息区占位（先填 0，选好掩码后再写真值）——
  // 占位的意义是把这些格子标成"功能模块"，这样掩码和数据填充都会跳过它们。
  for (let i = 0; i <= 8; i++) {
    if (!fixed[8][i]) set(8, i, 0)
    if (!fixed[i][8]) set(i, 8, 0)
  }
  for (let i = 0; i < 7; i++) set(size - 1 - i, 8, 0) // 左下 7 格（第 8 格是深色模块）
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, 0)  // 右上 8 格
  // 版本信息区（v≥7）
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        set(size - 11 + j, i, 0)
        set(i, size - 11 + j, 0)
      }
    }
  }
  // ⚠️ 深色模块必须最后置 —— 它和左下格式区的最后一格是同一个位置，
  //    写在前面会被上面那个循环覆盖成 0（规范里它恒为深色）。
  set(size - 8, 8, 1)
  return { size, m, fixed }
}

/** 把码字比特按之字形填进矩阵 */
function placeData(m, fixed, words, version) {
  const size = m.length
  const bits = []
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1)
  for (let i = 0; i < REMAINDER[version]; i++) bits.push(0)
  let at = 0
  let up = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col-- // 让开定时列
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k
      for (const c of [col, col - 1]) {
        if (fixed[row][c]) continue
        m[row][c] = at < bits.length ? bits[at++] : 0
      }
    }
    up = !up
  }
}

/** 四条罚分规则，选最低分的掩码 */
function penalty(m) {
  const size = m.length
  let score = 0
  const runScore = (line) => {
    let s = 0
    let run = 1
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++
      else { if (run >= 5) s += 3 + (run - 5); run = 1 }
    }
    if (run >= 5) s += 3 + (run - 5)
    return s
  }
  for (let i = 0; i < size; i++) {
    score += runScore(m[i])
    score += runScore(m.map((row) => row[i]))
  }
  // 2×2 同色块
  for (let r = 1; r < size; r++) {
    for (let c = 1; c < size; c++) {
      const v = m[r][c]
      if (v === m[r - 1][c] && v === m[r][c - 1] && v === m[r - 1][c - 1]) score += 3
    }
  }
  // 1011101 0000 / 0000 1011101
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  const hit = (line, at, pat) => pat.every((p, k) => line[at + k] === p)
  for (let i = 0; i < size; i++) {
    const row = m[i]
    const col = m.map((r) => r[i])
    for (let j = 0; j + 11 <= size; j++) {
      if (hit(row, j, pat1) || hit(row, j, pat2)) score += 40
      if (hit(col, j, pat1) || hit(col, j, pat2)) score += 40
    }
  }
  // 深色比例偏离 50%
  let dark = 0
  for (const row of m) for (const v of row) if (v === 1) dark++
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

/**
 * 文本 → 二维码矩阵。
 * @param {string} text 要编码的内容（登录 URL 都是 ASCII）
 * @returns {{size:number, modules:number[][], version:number}}
 */
export function qrMatrix(text) {
  const s = String(text ?? '')
  const version = pickVersion(new TextEncoder().encode(s).length)
  if (!version) throw new Error(`内容太长（${s.length} 字符），二维码版本 1–20 装不下`)
  const words = interleave(encodeData(s, version), version)
  const { size, m } = makeMatrix(version)
  placeData(m, makeMatrixFixed(version, m), words, version)

  // 逐个掩码试，取罚分最低的那个（同分取序号小的）
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const cand = m.map((row) => row.slice())
    applyMask(cand, version, mask)
    writeFormats(cand, version, mask)
    const score = penalty(cand)
    if (!best || score < best.score) best = { score, mask, matrix: cand }
  }
  return { size, modules: best.matrix, version, mask: best.mask }
}

/** 重新算一遍"哪些格子是功能图案"——placeData 需要它，独立算比带状态更省心 */
function makeMatrixFixed(version, m) {
  const probe = makeMatrix(version)
  return probe.fixed
}

function applyMask(m, version, mask) {
  const size = m.length
  const fixed = makeMatrixFixed(version, m)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (fixed[r][c]) continue
      if (MASKS[mask](r, c)) m[r][c] ^= 1
    }
  }
}

/** 填格式信息（两份）与版本信息（两份） */
function writeFormats(m, version, mask) {
  const size = m.length
  const fmt = formatBits(mask)
  const bit = (i) => (fmt >> i) & 1
  // 左上竖向 + 横向
  for (let i = 0; i <= 5; i++) m[8][i] = bit(i)
  m[8][7] = bit(6)
  m[8][8] = bit(7)
  m[7][8] = bit(8)
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i)
  // 右上 + 左下
  for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i)
  for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bit(i)
  // 版本信息
  if (version >= 7) {
    const vb = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const b = (vb >> i) & 1
      const r = Math.floor(i / 3)
      const c = i % 3
      m[size - 11 + c][r] = b
      m[r][size - 11 + c] = b
    }
  }
}

// __test 只服务于 selfcheck.mjs 的离线校验（格式信息真值、RS 综合校验、数据模块往返解码）。
export const __test = { genPoly, rsEC, formatBits, versionBits, gfMul, LOG, EXP, makeMatrix }
