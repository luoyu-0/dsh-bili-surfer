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
10. **凭证只在 `<home>/credential.json`**，永远不进日志、不进报告、不进 HTTP 响应。

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
- 弹幕 90% 是「哈哈哈哈」和复读，`pickDanmaku()` 会先挑长且不重复的。

## 评审清单（提交前自查）

- [ ] `node selfcheck.mjs` 全绿
- [ ] `node selfcheck.live.mjs` 全绿（需要联网）
- [ ] 新增的每个 `type:'object'` schema 都有 `additionalProperties`
- [ ] 没有顶层 `@deepseek-ai/*` import
- [ ] 没有 setInterval / setTimeout 常驻定时器
- [ ] 新增的落盘路径都在 `stateDir` 下
- [ ] `autoComment` 相关的写操作都过 `dryRun` 与 `mentionName` 双闸
