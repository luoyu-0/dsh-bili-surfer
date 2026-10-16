# AGENTS.md — dsh-bili-surfer

给在这个仓库里干活的 agent（也包括未来的我）。

## 这个插件是什么

DSH 的一个 bundle 插件：手动触发一轮「刷 B 站」——搜索/挑片/读字幕或弹幕/写 Markdown 日报，可选发一条评论并 @ 用户。**纯 JS，零安装，无 Python/venv/MCP/定时器。**

## 目录约定

```
index.js            宿主插件（cordis）：Config、工具注册、HTTP 路由、注入客户端
client.js           设置页（非 ESM，window.__ModuleLoader__.load 自注册）
cordis.patch.yml    bundle 插入 profile 配置树；id 必须叫 bili-surfer
lib/net.mjs         HTTP 底座：cookie 罐 / wbi 签名 / 业务码 → 异常
lib/bili.mjs        B 站领域动作（不碰磁盘）
lib/state.mjs       家目录、配置白名单化、JSON 读写、日期
lib/surf.mjs        一轮编排（不碰 DSH）
lib/report.mjs      报告与台账格式化（纯函数）
prompts/surfer.md   冲浪章程（纪律/边界/评论文风/底线产出）
selfcheck.mjs       离线预检（假 ctx + 假 DOM + 源码不变式）
selfcheck.live.mjs  联网冒烟（真打接口）
selfcheck.round.mjs 联网跑一整轮（临时目录）
```

**命名必须统一为 `bili-surfer`**：插件 id、设置命名空间、状态目录名、客户端 slot id。参考实现 dsh-bili-scroll 在这三处有三个不同的名字（`bili-scroll`/`bili-duty`/`bili-duty`），设置页因此对不上 entry —— 别复制这个坑。

## 硬规矩（每条都对应一次真实事故，改动前先看这里）

1. **不要裸 import `@deepseek-ai/*`。** 桌面 profile 用 `autoInstallPeers: false`，optional peer 根本不会装；一旦顶层 import 失败，**整条插件都不激活**（设置页直接不出现，日志只有一句 `1 entry did not activate`）。所以：宿主依赖要么从宿主树里解析，要么不用（本插件不需要 schemastery 也能跑，`Config` 拿不到就退化成 `undefined`）。
2. **`apply(ctx, config)` 里的 config 不可信。** 字段可能是对象、函数、`null`。一律过 `normalize()` 按默认值类型过滤，否则一个类型不符的值会在使用时抛异常；**在定时器/回调里抛异常会带走整个 dsh 进程**。
3. **`ctx.get('dshHomePath')` 是函数不是字符串**（`p()` 返回路径）。当字符串用会得到「函数源码」拼出来的路径 → `mkdir ENOENT` → 插件不激活。两种形状都要兼容，见 `lib/state.mjs:resolveHome`。
4. **工具返回值必须是 lossless JSON**（不能有 class 实例/函数/循环引用），**每个 `type:'object'` 的 schema 节点必须写 `additionalProperties`**。两条都是硬失败。
5. **长活儿不许 await 在请求路径上。** 但本插件没有长活儿：一轮 5 条视频大约 5–30 秒，属于可等待范围。**如果以后加了转写/下载，必须改成 spawn + 日志 + 轮询**。
6. **落盘只写 `<DSH_HOME>/bili-surfer/`。** 插件包目录可能是只读的（也是发布目录）。
7. **一轮里的任何异常都不能逃逸到宿主。** `runRound` 的每一步都单独 try/catch，最外层再兜一次；失败也要留下报告与台账（章程「底线产出」）。
8. **`settings.register` 的 entry id 必须等于命名空间名**，且至少要有一个字段带 `volatile`，否则 `settings.update()` 会抛 `has no volatile fields`。
9. **改完必须重启 dsh。** bundle 的 patch 只在启动时读，profile 层不热重载。
10. **凭证只在 `<home>/credential.json`**，永远不进日志、不进报告、不进 HTTP 响应。工具结果也不许带 cookie（`bili_surf_login` 的 poll 分支只回 `saved/loggedIn`）。
11. **cookie 名大小写敏感。** 盘上存小写（`sessdata`/`bili_jct`/`buvid3`/`dedeuserid`），发给 B 站必须用官方名 `SESSDATA`/`bili_jct`/`buvid3`/`DedeUserID`。`lib/net.mjs` 的 `COOKIE_ALIAS` 负责双向映射，**读写都要过它**（`setCookies` 进罐子、`pickCredentials` 从二维码响应的 Set-Cookie 出来）。踩过一次：小写直接进罐子 → `cli.loggedIn` 永远 false、Cookie 头里的名字 B 站不认 → **扫码登录成功，但字幕/热评/发评论全部静默降级成游客**。参考实现也因此手拼 Cookie 头（`D:\everything\dsh\_ref\dsh-bili-scroll\lib\verify.mjs:56`）。
12. **`saveCredential(dir, null)` 是删文件，不是写一个 `null`。** 退出登录要真把 cookie 从盘上抹掉。
13. **别在轮询路由里直连网络。** 设置页每 5 秒打一次 `GET /status`，而 `/status` 要显示登录名 → `whoami` 必须带 TTL 缓存（`index.js` 的 `ME_TTL = 60_000` + `forgetMe()`，登录/退出时作废）。否则用户开着设置页就等于每分钟打 12 次 B 站。
14. **设置页读的是 `/status` 的顶层字段**（`st.enabled`、`st.config`、`st.logTail`、`st.login`…）。开关只放进 `config.enabled` 会让徽标永远显示「已停用」——两处都要有。
15. **测试脚本不许把运行时状态写进仓库。** `selfcheck.round.mjs` 的 `--dir` 为空（shell 把 `--dir=X` 拆成 `--dir=` + X 时就会）或指向插件包目录时**直接拒绝**；`.gitignore` 覆盖 `out/ seen.md state.json surf.log config.json credential.json`。踩过一次：空 `--dir` 让一轮的 `out/`、`seen.md` 落进仓库，被 `git add -A` 顺手提交了。
16. **`dryRun` 是「真演练」，不是「跳过」。** 评论照样让助手写、照样过 `normalizeComment`、照样记进报告（**本轮评论**：演练）与台账（备注「演练（没真发）」），只压住最后那次 `sendComment`。如果 dryRun 直接跳过整段，设置页开了 `autoComment` 也看不出任何差别，用户就没法在不发帖的前提下验这条链。

## B 站接口的真实行为（实测，别再踩）

| 接口 | 游客 | 登录 |
|---|---|---|
| `/x/web-interface/search/type` | ✅ 可用（先补 `buvid3`） | ✅ |
| `/x/web-interface/view` | ✅ | ✅ |
| `/x/v1/dm/list.so`（弹幕 XML） | ✅ 可用 —— **最稳的内容信号** | ✅ |
| `/x/tag/archive/tags` | ✅ | ✅ |
| `/x/web-interface/popular` | ✅ | ✅ |
| `/x/web-interface/wbi/index/top/feed/rcmd` | ✅ 可用 | ✅ |
| `/x/v2/reply`（老接口） | ⚠️ 只能拿到少量 | ✅ |
| `/x/v2/reply/wbi/main` | ❌ | ✅ |
| `/x/player/wbi/v2`（字幕列表） | ❌ 返回空列表 | ✅（且很多视频本来就没字幕） |
| `/x/web-interface/view/conclusion/get`（AI 摘要） | ❌ `-403` | ✅ |
| `/x/v2/reply/add`（发评论） | ❌ | ✅ |
| `/x/web-interface/ranking/v2` | ❌ `-352` 风控 | 未知 |

- `nav` 未登录时业务码是 `-101`，**但 `wbi_img` 照样在 `data` 里** —— 拿 wbi 密钥时必须容忍非 0 码（`getJson(..., {tolerate:true})`）。
- wbi 密钥按**北京日期**缓存，跨天要重新取。
- 字幕是「人工 + AI」混在一个列表里；排序优先级 `zh-CN → zh-Hans → zh-Hant → ai-zh → zh → en`。
- **字幕正文那个 URL（`aisubtitle.hdslb.com/...json`）返回的是裸 JSON**：`{"body":[{from,to,location,content}]}`，**没有 `code`/`message` 信封**。所以它不能走 `getJson()`（那条路按 `code===0` 判定，`undefined !== 0` 会直接抛），要像弹幕 XML 一样用 `cli.raw()` + `res.text()` + `JSON.parse`。踩过一次：登录后**每一条视频的字幕都会「失败」**，而日志只会写一句 `字幕失败：undefined @ https://…`，很容易被当成「这个视频没字幕」。判定用 `Array.isArray(body?.body) ? body.body : body?.data?.body`（留一个信封的余地）。
- **cookie 只发给 `*.bilibili.com`**：字幕正文在 `*.hdslb.com` 上，浏览器也不会把 b 站 cookie 发过去，`raw()` 里按 host 判断（凭证少外发一个域是一个域）。要断言这件事，`selfcheck.mjs` 的「字幕链」用例里有 `ok(!cdn.cookie, …)`。
- 弹幕 90% 是「哈哈哈哈」和复读，`pickDanmaku()` 会先挑长且不重复的。

## 二维码是怎么验的（三层，别只信第一层）

手写 QR 编码器是这个插件里最容易「看起来对、扫不出来」的东西，所以验三层：

1. **编码器内部**（`selfcheck.mjs` A 段）：格式信息真值（ECC=M + mask0 必须是 `0x5412`）、版本信息真值（v7 = `0x07C94`）、RS 纠错的综合校验、数据模块往返解码。
2. **宿主 → 浏览器**（C/C2 段，两边都逐格比字符串，不是「有没有 canvas」）：`POST /login/start` 返回的 `rows` 必须逐格等于 `qrMatrix(登录 URL)`；`client.js` 画到 canvas 的矩形还原成矩阵后也必须逐格等于同一个矩阵。
3. **第三方解码器**（唯一真正独立的验证；不进仓库，保持插件零依赖）：在插件目录之外的临时目录 `pnpm add jsqr`，把矩阵按 scale 3 与 8 画成 RGBA 交给 jsQR，比对解出的字符串。已过：v1 / v4 / v8（真实 passport URL）/ v12 / v20。

## 已知取舍（刻意不做的事，别当成漏做）

- **工具不声明 `timeoutMs`。** `packages/guard/timeout-policy` 只对**声明了** `timeoutMs` 的工具武装截止时间，没声明的原样委派（该包 README「a tool without a limit delegates untouched」）。一轮 5–30 秒，声明一个上限只会多一个「跑到一半被 `TOOL_TIMEOUT` 打断」的失败面，所以刻意不声明。
- **没观测 `exec.signal`。** 取消一次工具调用不会立刻掐断正在跑的那一轮（每个 HTTP 请求自带超时，整轮有界）。真要在意，在 `runRound` 的条目循环入口加一次 `signal.aborted` 检查就够。
- **不用 DSH 的 settings 服务、不导出 `Config`。** 用它得同时满足 schemastery 依赖 + entry id 对齐 + 至少一个 `volatile` 字段，三个失败点只换来「配置能写进 profile 的 cordis.patch.yml」；我们用 `<home>/bili-surfer/config.json` + 自己的设置页。
- **不做定时。** 用户明确要求只在设置页手动跑（参考实现的 60s `setInterval` 是它最危险的一段）。

## 评审清单（提交前自查）

- [ ] `node selfcheck.mjs` 全绿
- [ ] `node selfcheck.live.mjs` 全绿（需要联网）
- [ ] 新增的每个 `type:'object'` schema 都有 `additionalProperties`
- [ ] 没有顶层 `@deepseek-ai/*` import
- [ ] 没有 setInterval / setTimeout 常驻定时器
- [ ] 新增的落盘路径都在 `stateDir` 下
- [ ] `autoComment` 相关的写操作都过 `dryRun` 与 `mentionName` 双闸
- [ ] 真正发出去的只有 `sendComment` 一处；`dryRun` 下永远不经过它
- [ ] 新写文件都落在 `stateDir`（或预检脚本 `--dir` 指定的目录）里，不在插件包目录
- [ ] **只有登录后才走得通的链条要有 stub fetch 的自检用例**（字幕链、发评论）：游客态验不了它们，靠人肉试就是等用户重启后才发现。形状照真响应造（尤其是「有没有 `code` 信封」这种一眼看不出的事）。
