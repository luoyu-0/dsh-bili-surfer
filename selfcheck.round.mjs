// 真联网跑一轮：不经过 DSH，直接在临时目录里生成一份日报，验证编排逻辑。
//
// 用法：
//   node selfcheck.round.mjs                                  # 默认关键词搜一轮
//   node selfcheck.round.mjs 关键词一 关键词二
//   node selfcheck.round.mjs --source=popular --per=2         # 换来源：search / popular / recommend
//   node selfcheck.round.mjs --source=recommend --level=brief
//   node selfcheck.round.mjs --auto --mention=某某 --comment="{title} 这期挺清楚"   # 演练评论（dryRun 默认开）
//   node selfcheck.round.mjs --send --mention=某某 --comment="…"                    # 真发，需要已登录
//   node selfcheck.round.mjs --dir=D:\tmp\bili --per=1        # 固定目录，跑两遍可验去重
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readText, DEFAULTS } from './lib/state.js'
import { runRound } from './lib/surf.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
/** `--k=v` → 'v'；`--k` → true；没给 → def */
const flag = (name, def = undefined) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return def
  const i = hit.indexOf('=')
  return i < 0 ? true : hit.slice(i + 1)
}
const kws = argv.filter((a) => !a.startsWith('--'))
// 空 --dir（比如 shell 把 `--dir=X` 拆成了 `--dir=` + X）必须落到默认临时目录，
// 否则一轮的 out/seen.md/state.json 会写进当前工作目录，也就是插件仓库本身。
const dirArg = String(flag('dir', '') || '')
const dir = dirArg ? resolve(dirArg) : join(tmpdir(), 'bili-surfer-round')
if (dir === HERE || dir.startsWith(HERE + sep)) {
  console.error(`--dir 不能落在插件包目录里（会把 out/seen.md/state.json 写进仓库）：${dir}`)
  process.exit(2)
}
const mention = String(flag('mention', '') || '')
const body = String(flag('comment', '') || '')
const send = flag('send', false) === true
const auto = flag('auto', false) === true || send

if (auto && !mention) {
  console.error('要演练/发评论就得给 --mention=名字（@ 的对象）')
  process.exit(2)
}
if (send && !body) {
  console.error('--send 必须配 --comment=文本')
  process.exit(2)
}

const cfg = {
  ...DEFAULTS,
  keywords: kws.length ? kws : DEFAULTS.keywords,
  source: String(flag('source', DEFAULTS.source)),
  order: String(flag('order', DEFAULTS.order)),
  perDay: Number(flag('per', 2)),
  maxAgeDays: Number(flag('age', 365)),
  danmakuNum: 300,
  commentNum: 10,
  reportLevel: String(flag('level', 'full')),
  autoComment: auto,
  mentionName: mention,
  dryRun: !send,
}
console.log(`来源 ${cfg.source} ｜ 关键词 ${cfg.keywords.join('、')} ｜ 挑 ${cfg.perDay} 条 ｜ 评论 ${auto ? (send ? '真发' : '演练') : '关'} ｜ 目录 ${dir}`)

const t0 = Date.now()
const r = await runRound({
  dir,
  cfg,
  log: (m) => console.log('  ·', m),
  commentWriter: auto ? (it) => (body ? body.replaceAll('{title}', it.title) : '') : undefined,
})
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`\n用时 ${secs}s  报告：${r.reportPath}\n`)
console.log('='.repeat(72))
console.log(r.report.slice(0, 4000))
console.log('='.repeat(72))
console.log(`统计：${JSON.stringify(r.stats)}`)
const commented = r.items.filter((it) => it.comment)
if (auto) {
  console.log(`评论记录 ${commented.length} 条：${commented.map((it) => `${it.bvid}${it.comment.dryRun ? '(演练)' : `(rpid ${it.comment.rpid})`}`).join(' ') || '（评论闸没过：autoComment/mentionName/dryRun/正文为空）'}`)
}
if (r.loginHint) console.log(r.loginHint)
console.log('— 台账末尾 —')
console.log(readText(join(dir, 'seen.md'), '(空)').trim().split(/\r?\n/).slice(-4).join('\n'))
