// 离线跑一轮：不经过 DSH，直接在临时目录里生成一份日报，验证编排逻辑。
// 用法：node selfcheck.round.mjs [关键词...]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRound } from './lib/surf.mjs'
import { DEFAULTS } from './lib/state.mjs'

const dir = join(tmpdir(), 'bili-surfer-round')
const kws = process.argv.slice(2)
const cfg = {
  ...DEFAULTS,
  keywords: kws.length ? kws : ['DeepSeek Harness', 'dsh 插件'],
  perDay: 2,
  maxAgeDays: 365,
  danmakuNum: 300,
  commentNum: 10,
  reportLevel: 'full',
  autoComment: false,
  dryRun: true,
}

const t0 = Date.now()
const r = await runRound({
  dir,
  cfg,
  log: (m) => console.log('  ·', m),
})
console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s  报告：${r.reportPath}\n`)
console.log('='.repeat(72))
console.log(r.report.slice(0, 4000))
console.log('='.repeat(72))
console.log(`统计：${JSON.stringify(r.stats)}`)
