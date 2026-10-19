#!/usr/bin/env node
// 一条命令跑完「能自动跑的自检」，按阶段打一张表。人眼才能判的那几项看 README 的手工验收清单。
//
//   node verify.mjs               # 类型 + 离线 + 联网 + 整轮 + 活进程契约
//   node verify.mjs --offline     # 不联网：类型 + 离线 + 活进程契约
//   node verify.mjs --no-host     # 跳过活进程（DSH 没起来时）
//   node verify.mjs --with-login  # 额外打一次扫码链 —— ⚠️ 结尾会「退出登录」，本来登录着就别加
//
// 退出码：全过 0，有任何一段没过 1。每段都打印它自己那行结论，失败时多打末尾几行。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const OFFLINE = argv.includes('--offline')
const NO_HOST = argv.includes('--no-host')
const WITH_LOGIN = argv.includes('--with-login')

const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

function run(cmd, args, timeout = 300_000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { out += String(d) })
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeout)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${e?.message || e}`, ms: Date.now() - t0 }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, ms: Date.now() - t0 }) })
  })
}

// 每段从输出里挑一句「人话」当结论；挑不到就退回最后一行非空文本。
const PICK = [
  /共 (\d+) 项，通过 (\d+)，失败 (\d+)/,
  /全部通过/,
  /(\d+) 通过/,
  /入选 (\d+) 条/,
  /^✓.*$/m,
]
function headline(out, code) {
  for (const re of PICK) {
    const m = out.match(re)
    if (m) return m[0]
  }
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : (code === 0 ? '（没有输出）' : `退出码 ${code}`)
}

const stages = []
if (existsSync(TSC)) stages.push({ name: '类型检查', cmd: process.execPath, args: [TSC, '-p', 'tsconfig.json', '--noEmit'] })
else stages.push({ name: '类型检查', skip: '没装 devDependencies（先 pnpm install）' })
stages.push({ name: '离线自检', cmd: process.execPath, args: [join(ROOT, 'selfcheck.mjs')] })
if (!OFFLINE) {
  stages.push({ name: '联网冒烟', cmd: process.execPath, args: [join(ROOT, 'selfcheck.live.mjs')] })
  const dir = mkdtempSync(join(tmpdir(), 'bsr-verify-'))
  stages.push({ name: '跑一整轮', cmd: process.execPath, args: [join(ROOT, 'selfcheck.round.mjs'), `--dir=${dir}`], cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} } })
} else {
  stages.push({ name: '联网冒烟', skip: '--offline' })
  stages.push({ name: '跑一整轮', skip: '--offline' })
}
if (!NO_HOST) stages.push({ name: '活进程契约', cmd: process.execPath, args: [join(ROOT, 'selfcheck.host.mjs'), ...(WITH_LOGIN ? ['--login'] : [])] })
else stages.push({ name: '活进程契约', skip: '--no-host' })

const rows = []
let failed = 0
for (const st of stages) {
  if (st.skip) {
    rows.push({ name: st.name, mark: '—', head: st.skip, ms: 0 })
    continue
  }
  const r = await run(st.cmd, st.args)
  st.cleanup?.()
  const pass = r.code === 0
  if (!pass) failed += 1
  rows.push({ name: st.name, mark: pass ? '✓' : '✗', head: headline(r.out, r.code), ms: r.ms, out: r.out, code: r.code })
}

const pad = (s, n) => {
  const w = [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return s + ' '.repeat(Math.max(1, n - w))
}
console.log('\n═══ 自检总表 ═══')
for (const r of rows) console.log(`${r.mark} ${pad(r.name, 12)} ${pad(`${(r.ms / 1000).toFixed(1)}s`, 7)} ${r.head}`)
const bad = rows.filter((r) => r.mark === '✗')
if (bad.length) {
  console.log('\n── 失败的那几段末尾 ──')
  for (const r of bad) {
    console.log(`\n▸ ${r.name}（退出码 ${r.code}）`)
    for (const line of r.out.split(/\r?\n/).filter((s) => s.trim()).slice(-14)) console.log('  ' + line)
  }
  const stale = bad.some((r) => /要重启 dsh|不一致/.test(r.out))
  console.log('\n下一步：' + (stale
    ? '活进程跑的还是旧代码 —— 重启 DSH 再跑一次；只改了 client.js 的话刷新页面就够。'
    : '按上面每段的提示改源码，改完 pnpm run build（改了 src/ 才需要）再跑一次。'))
} else {
  console.log('\n全部通过。还剩下人眼/人手才判得了的几项：见 README「手工验收」。')
}
process.exitCode = failed ? 1 : 0
