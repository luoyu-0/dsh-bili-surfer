// 联网冒烟测试：直接打 b 站真接口，验证 lib/ 三个模块。
// 用法：node selfcheck.live.mjs [关键词]
import { newClient, whoami, searchVideos, videoInfo, fetchSubtitle, fetchDanmaku, fetchComments, tags, popular, recommend, qrStart, fmtCount, fmtTime } from './lib/bili.mjs'

const kw = process.argv[2] || 'DeepSeek Harness'
const cli = newClient()
let fail = 0
const ok = (name, cond, extra = '') => {
  if (!cond) fail += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

const me = await whoami(cli)
ok('whoami', typeof me.loggedIn === 'boolean', JSON.stringify(me))
await cli.ensureBuvid()
ok('buvid3', Boolean(cli.cookies.buvid3))

const found = await searchVideos(cli, kw, { num: 6, order: 'totalrank' })
ok('searchVideos', found.length > 0, `${found.length} 条，首条=${found[0]?.title?.slice(0, 30)}`)
// 搜索接口的 duration 是 "16:33" 字符串，映射后必须是**秒**，否则日报与工具输出全是 00:00
ok(
  'searchVideos.duration 已统一成秒',
  found.every((x) => typeof x.duration === 'number' && Number.isFinite(x.duration)),
  `前三条=${found.slice(0, 3).map((x) => `${x.bvid}:${x.duration}s→${fmtTime(x.duration)}`).join(' ')}`,
)

let v = found[0]
if (process.argv[3]) {
  v = await videoInfo(cli, process.argv[3])
} else {
  v = await videoInfo(cli, v.bvid)
}
ok('videoInfo', Boolean(v.cid), `${v.bvid} cid=${v.cid} 时长=${fmtTime(v.duration)} 播放=${fmtCount(v.stat.view)}`)
ok('详情接口的 duration 是秒且与格式化自洽', typeof v.duration === 'number' && v.duration > 0 && fmtTime(v.duration) !== '00:00', `${v.duration}s → ${fmtTime(v.duration)}`)

const sub = await fetchSubtitle(cli, v.bvid, v.cid)
console.log(`INFO  subtitle: ${sub ? `${sub.lan} ${sub.lines.length} 行` : 'null（无字幕或未登录）'}`)

const dm = await fetchDanmaku(cli, v.cid, { num: 200 })
ok('fetchDanmaku', dm.length > 0, `${dm.length} 条，例如「${dm[0]}」`)

const cs = await fetchComments(cli, v.bvid, v.aid, { num: 10 })
console.log(`INFO  comments: ${cs.length} 条${cs[0] ? `，首条 ${cs[0].user}：${cs[0].message.slice(0, 30)}` : ''}`)

const tg = await tags(cli, v.bvid)
ok('tags', Array.isArray(tg), tg.join('/'))

const pop = await popular(cli, { num: 5 })
ok('popular', pop.length > 0, `${pop.length} 条`)

const rec = await recommend(cli, { num: 5 })
ok('recommend', rec.length > 0, `${rec.length} 条`)

const qr = await qrStart(cli)
ok('qrStart', qr.url.startsWith('https://'), qr.url.slice(0, 60))

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
