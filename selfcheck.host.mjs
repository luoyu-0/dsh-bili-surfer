// 对着「正在跑的那个 DSH」验设置页契约 —— 和 selfcheck.live.mjs（打 B 站接口）不是一回事。
//
//   node selfcheck.host.mjs                 # 只读检查（默认）
//   node selfcheck.host.mjs --login         # 外加真打一次扫码链（start → 逐格比对 → poll → logout）
//   node selfcheck.host.mjs --run           # 外加拿一轮（会真写报告与台账）
//   node selfcheck.host.mjs --port 19387
//
// 为什么要有这个：设置页脚本 client.js 只认识 /status 里的几个字段，而插件的路由
// 只有「重启 dsh 后」才会换成新代码（模块缓存）—— 于是最容易出现的失效是
// 「用户重启前看到的旧契约」和「我改完的源码」对不上，而两边各自都「看不出问题」。
// 这里把 client.js 真正读的字段从源码里反推出来，再逐个到活的 /status 里对账。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, HOME_SUBDIR, buildStamp, normalize, readJson, readText, resolveHome } from './lib/state.mjs'
import { countSeen, parseSeen } from './lib/report.mjs'
import { loadCredential } from './lib/surf.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = Number(argOf('--port', process.env.DSH_WEB_PORT || 19387))
const BASE = `http://127.0.0.1:${PORT}/api/bili-surfer`
const WITH_RUN = argv.includes('--run')
const WITH_LOGIN = argv.includes('--login')

const results = []
const ok = (cond, msg) => results.push({ pass: Boolean(cond), msg })
const eq = (got, want, msg) => ok(got === want, `${msg ?? ''}（期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}）`)

async function req(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { __nonJson: text.slice(0, 200) }
  }
  return { code: res.status, json, text }
}

// 从 client.js 反推「设置页真正会读的顶层字段」（st.xxx）。
function panelFields() {
  const src = readFileSync(ROOT + 'client.js', 'utf8')
  const keys = new Set()
  for (const m of src.matchAll(/\bst\.([A-Za-z_$][\w$]*)/g)) keys.add(m[1])
  // error 是面板自己包出来的（api() 的失败分支），不是 /status 给的
  keys.delete('error')
  // 这两个只在「正在跑」时才有：由 runningInfo() 决定
  const conditional = new Set(['seconds', 'startedAt'])
  return { required: [...keys].filter((k) => !conditional.has(k)).sort(), conditional: [...keys].filter((k) => conditional.has(k)).sort() }
}

let hostMissing = false // 拿不到活进程的 /status 时，结尾不能报「契约一致」

function printSummary() {
  const bad = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.msg}`)
  console.log('─'.repeat(64))
  console.log(`共 ${results.length} 项，通过 ${results.length - bad.length}${bad.length ? `，失败 ${bad.length}` : ''}`)
  if (bad.length) {
    console.log('\n✗ 上面失败的那些就是重启后第一眼会看到的问题，按提示改源码再重启。')
    process.exitCode = 1
  } else if (hostMissing) {
    console.log('✗ 活进程那一半没验成（原因见上）—— 本机状态目录那几项是过的。')
  } else {
    console.log('✓ 契约一致（本机状态目录 + 活着的 DSH）')
  }
}

// 0) 本机状态目录 × 本地代码 —— 不需要活的 dsh，也不需要联网，所以放在最前面。
//    动机：离线用例用的是临时目录，真实那一份可能带着上个版本留下的键、
//    或者形状已经和现在的读法对不上（升级时才暴露的问题）。这些都不是「重启就好」，
//    而是「重启后第一眼就错」。
{
  const S = '[本机状态] '
  const home = join(resolveHome(null), HOME_SUBDIR)
  console.log(`\n── 本机状态目录 × 本地代码（${home}）${'─'.repeat(10)}`)
  ok(existsSync(home), `${S}状态目录要存在：${home}`)
  if (existsSync(home)) {
    const rawCfg = readJson(join(home, 'config.json'), null)
    if (rawCfg) {
      const cfg = normalize(rawCfg, { ...DEFAULTS })
      const unknown = Object.keys(rawCfg).filter((k) => !(k in DEFAULTS))
      const missing = Object.keys(DEFAULTS).filter((k) => !(k in cfg))
      ok(missing.length === 0, `${S}配置里 DEFAULTS 的键一个都不能少（缺 ${JSON.stringify(missing)}）`)
      if (unknown.length) console.log(`  · 这几个键现在的代码不认了、只被忽略（下次保存时清掉）：${unknown.join(', ')}`)
    } else {
      console.log('  · 还没有 config.json（第一次挂载时会铺一份默认的）')
    }

    const credFile = join(home, 'credential.json')
    const cred = loadCredential(home)
    ok(!existsSync(credFile) || Boolean(cred), `${S}credential.json 要么不存在、要么读得出 sessdata（有文件却读不出＝形状坏了）`)

    const seenText = readText(join(home, 'seen.md'))
    eq(parseSeen(seenText).size, countSeen(seenText), `${S}台账口径：parseSeen 与 countSeen 必须一样（三个入口都靠它）`)

    const stt = readJson(join(home, 'state.json'), null)
    if (stt) {
      const known = new Set(['lastRunAt', 'lastWhy', 'lastCount', 'lastCandidates', 'lastReport', 'day', 'runsToday', 'seenTotal'])
      const alien = Object.keys(stt).filter((k) => !known.has(k))
      if (alien.length) console.log(`  · state.json 里有现在不用的键（不影响，只是留着）：${alien.join(', ')}`)
    }
    console.log(`  · 磁盘源码指纹 buildStamp=${buildStamp(ROOT)}（重启后 /status.build 应该等于它）`)
  }
}

console.log(`\n── 活着的 DSH 上的 bili-surfer 契约（${BASE}）${'─'.repeat(12)}`)

// 1) 插件在不在
let st
try {
  const r = await req('/status')
  st = r.json
  ok(r.code === 200 && st?.ok === true, `GET /status 要 200 且 ok:true（实际 HTTP ${r.code}${st?.__nonJson ? `，返回的不是 JSON：${st.__nonJson}` : ''}）`)
  if (!(r.code === 200 && st?.ok === true)) {
    console.log('\n✗ 拿不到 /status：插件没挂在这个进程上。')
    console.log('  常见原因：profile 里没列 bundle / 包没装 / 改完代码没重启 dsh（模块缓存）。')
    st = undefined
  }
} catch (e) {
  console.log(`\n✗ 连不上 http://127.0.0.1:${PORT}：${e?.message || e}`)
  console.log('  DSH 没在跑，或者端口不对（用 --port 指定）。')
}

// ⚠️ 这里不许 process.exit()：这个 Node/Windows 组合下，一边退一边关 undici 的 keep-alive socket
// 会撞 libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），退出码变成
// -1073740791，把「33 项过了、6 项没过」这种人话淹进崩溃信息里（实测 process.exit 4 次崩 3 次，
// 只设 exitCode 让事件循环自己排空 4 次干净）。见 AGENTS.md 硬规矩 22。
if (!st) {
  hostMissing = true
  process.exitCode = 1
  printSummary()
} else {
  // 2) 设置页读的字段一个都不能少（client.js ↔ /status 对账）
  const { required, conditional } = panelFields()
  for (const k of required) ok(k in st, `设置页要读 st.${k}，/status 必须给`)
  for (const k of conditional) ok(!st.running || k in st, `正在跑的时候 st.${k} 必须给（client.js 会渲染它）`)

  // 3) 契约细节
  eq(typeof st.enabled, 'boolean', 'st.enabled 必须是布尔（false/undefined 会让徽标永远显示「已停用」）')
  eq(st.enabled, st.config?.enabled, 'config.enabled 与顶层 enabled 要一致')
  ok(typeof st.version === 'string' && st.version.length > 0, 'st.version 要有值')
  // 指纹对不上 = 这个进程里跑的不是磁盘上这份代码（dsh 会热挂 bundle，但 Node 模块缓存不会跟着文件变）
  {
    const disk = buildStamp(ROOT)
    ok(
      disk && st.build === disk,
      `跑的是不是磁盘上这份代码：活的 build=${JSON.stringify(st.build)}，磁盘 ${JSON.stringify(disk)}` +
        (st.build === undefined ? ' —— 旧构建连 build 字段都没有，重启 dsh' : ' —— 不一致：宿主代码改了，要重启 dsh（只改了 client.js 的话刷新页面就够）'),
    )
  }
  ok(Array.isArray(st.fields) && st.fields.length >= 10, `st.fields 要是一张够全的表（实际 ${st.fields?.length}）`)
  ok((st.fields || []).every((f) => f.key && f.type && f.label), '每个字段都要有 key/type/label')
  const cfgKeys = Object.keys(st.config || {}).sort().join(',')
  const fldKeys = (st.fields || []).map((f) => f.key).sort().join(',')
  eq(cfgKeys, fldKeys, 'config 与 fields 的键必须逐一对齐（少了＝那个开关在设置页看不见）')
  ok(typeof st.home === 'string' && st.home.length > 0, `st.home 要指向状态目录（实际 ${JSON.stringify(st.home)}）`)
  ok(typeof st.logTail === 'string', 'st.logTail 要是字符串')
  ok(st.login && typeof st.login === 'object', 'st.login 要给个对象（哪怕只是 {pending:false}）')

  // 4) 其余只读路由
  const rep = await req('/report')
  ok(rep.code === 200 && rep.json.ok === true, `GET /report 要 200（实际 ${rep.code}）`)
  ok(typeof rep.json.text === 'string' && Array.isArray(rep.json.reports), '报告路由要回 text 与 reports[]')
  const seen = await req('/seen')
  ok(seen.code === 200 && seen.json.ok === true && typeof seen.json.text === 'string', `GET /seen 要回台账文本（实际 ${seen.code}）`)
  const nope = await req('/nope')
  eq(nope.code, 404, '未知路径要 404')
  ok(nope.json.ok === false, '404 也要是 JSON 而且 ok:false')

  // 5) 无副作用的一次 POST：空 patch 不该改任何东西
  const before = JSON.stringify(st.config)
  const cfg = await req('/config', { method: 'POST', body: { patch: {} } })
  ok(cfg.code === 200 && cfg.json.ok === true, `POST /config 空 patch 要成功（实际 ${cfg.code}）`)
  eq(JSON.stringify(cfg.json.config), before, '空 patch 不许改动配置')

  // 6) 没有扫码会话时，poll 要是软失败（不是 500）
  if (!st.login.pending) {
    const poll = await req('/login/poll', { method: 'POST', body: {} })
    ok(poll.code === 200 && poll.json.ok === false, `没有会话时 /login/poll 要软失败（实际 HTTP ${poll.code}）`)
    ok(/扫码/.test(String(poll.json.error || '')), `失败原因要说人话（实际 ${JSON.stringify(poll.json.error)}）`)
  } else {
    console.log('  · 跳过 /login/poll 用例：你正开着一个扫码会话')
  }

  // 7) 可选：真打一次扫码链（不真登录——没有手机扫，轮询必须停在「未扫」）
  if (WITH_LOGIN) {
    console.log('\n── 活着进程里的扫码链（--login）──')
    const start = await req('/login/start', { method: 'POST', body: {} })
    ok(start.code === 200 && start.json.ok === true, `POST /login/start 要成功（实际 HTTP ${start.code}）`)
    const { key, url, size, rows } = start.json
    ok(typeof url === 'string' && /^https:\/\//.test(url), `要给 https 扫码 URL（实际 ${JSON.stringify(url)}）`)
    ok(typeof key === 'string' && key.length > 8, '要给 qrcode_key')
    ok(Array.isArray(rows) && rows.length === size && size >= 21, `rows 要是 ${size}×${size} 的矩阵`)
    ok(
      (rows || []).every((r) => typeof r === 'string' && r.length === size && /^[01]+$/.test(r)),
      '每行必须是等长 0/1 **字符串**（数字数组会让 canvas 全白）',
    )
    ok(!/sessdata|SESSDATA/i.test(start.text), '启动响应里不许出现凭证')
    const { qrMatrix } = await import(new URL('./lib/qr.mjs', import.meta.url).href)
    const m = qrMatrix(url)
    eq(m.size, size, '矩阵尺寸要和插件自己算的一致')
    let diff = 0
    for (let y = 0; y < size; y += 1) {
      if (m.modules[y].map((v) => (v ? '1' : '0')).join('') !== rows[y]) diff += 1
    }
    eq(diff, 0, '每一格都要相同（用户手机扫的就是这些像素）')

    const poll = await req('/login/poll', { method: 'POST', body: { key } })
    ok(poll.code === 200 && poll.json.ok === true, `POST /login/poll 要成功（实际 HTTP ${poll.code}）`)
    ok(
      poll.json.status !== 'ok',
      `没人扫 → 绝不能说登录成功（实际 status=${JSON.stringify(poll.json.status)} text=${JSON.stringify(poll.json.text)}）`,
    )
    ok(!/sessdata|SESSDATA/i.test(poll.text), '轮询响应里也不许出现凭证')
    console.log(`  · 真实回话：${JSON.stringify(poll.json)}`)

    const out = await req('/logout', { method: 'POST', body: {} })
    ok(out.code === 200 && out.json.ok === true, '收尾的 /logout 要成功')
  }

  // 8) 可选：真跑一轮
  if (WITH_RUN) {
    const run = await req('/run', { method: 'POST', body: {} })
    if (run.json.ok === false && run.json.busy) {
      console.log('  · 已经有一轮在跑，等它跑完')
    } else {
      ok(run.json.ok === true && run.json.started === true, `POST /run 要么 started，要么 busy（实际 ${JSON.stringify(run.json)}）`)
      const t0 = Date.now()
      let last = ''
      while (Date.now() - t0 < 180000) {
        await new Promise((r) => setTimeout(r, 2000))
        const s = await req('/status')
        last = s.json.logTail || ''
        if (!s.json.running) break
      }
      const s = await req('/status')
      ok(!s.json.running, '一轮要在 180 秒内结束')
      const rep2 = await req('/report')
      ok(rep2.json.text.length > 0, '跑完要能在 /report 里读到今天的日报')
      ok(rep2.json.text.includes('# B 站冲浪日报'), '日报要有标题')
      ok(/https:\/\/www\.bilibili\.com\/video\/BV/.test(rep2.json.text), '日报里要有可点的链接')
      // 这几条是靠哪条链读到的：字幕 > AI 摘要 > 弹幕 > 简介（逐级降级）
      const src = [...last.matchAll(/读毕 (BV\w+)（([^）]+)）/g)].map((m) => `${m[1]}:${m[2]}`)
      console.log(`  · 这几条是怎么读到的：${src.length ? src.join('  ') : '（日志尾部里没有「读毕」行）'}`)
      if (s.json.loggedIn) {
        // 「字幕失败」是「登录了却读不到字幕」的指纹（踩过一次：CDN 返回裸 JSON，被 getJson 判成业务码非 0）。
        // 「没有字幕轨」是正常的 —— 很多视频本来就没有字幕。
        const fails = (last.match(/字幕失败/g) || []).length
        ok(fails === 0, `登录态下字幕链不许报失败（实际 ${fails} 条「字幕失败」）`)
        if (!src.some((x) => x.includes('字幕'))) {
          console.log('  · 提醒：这一轮没有一条是靠字幕读到的。先看上面有没有「字幕失败」；都没有就只是这批视频本来没字幕。')
        }
      }
      console.log(`  · 本轮日志尾部：\n${(last.split('\n').slice(-6).join('\n'))}`)
    }
  }

  printSummary()
}