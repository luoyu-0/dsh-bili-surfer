# dsh-bili-surfer

给 DeepSeek Harness 的「自主刷 B 站」插件。**纯 JS、零安装**：没有 Python、没有 venv、没有 MCP 子进程、不占端口。

它做四件事：

1. **搜**：按关键词搜索（或取热门/推荐），按「相关 + 新鲜 + 有内容」挑出 `perDay` 条；
2. **读**：字幕原文 → AI 摘要 → 弹幕 → 简介，逐级降级，读到什么算什么；
3. **写**：生成一份 Markdown 日报到 `<DSH_HOME>/bili-surfer/out/<日期>.md`，并把看过的记进台账；
4. **说**（默认关）：对特别值得的一条发评论并 @ 你，发完还会回头核实是否真的可见。

全程**只在你点「现在刷一轮」时跑**，不起定时器、不在后台偷跑。

## 和 dsh-bili-scroll 的关系

它照着 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) 的思路写，但把最重的三层去掉了：

| | dsh-bili-scroll | dsh-bili-surfer |
|---|---|---|
| 依赖 | Python + venv + uv + 自建 MCP stdio 服务 | 无，纯 `node:fetch` |
| 首次可用 | 先装几分钟环境 | 装完就能跑 |
| 登录 | Python qrcode 渲染 | 纯 JS 扫码，浏览器里直接出二维码 |
| 内容来源 | 字幕（读不到就本地 Whisper 转写） | 字幕 → AI 摘要 → 弹幕 → 简介 |
| 定时 | `setInterval` 60s + 峰谷窗口 | 无定时器，只有手动触发 |

## 安装

用 DSH 自带的插件管理器（或 CLI）：

```bash
dsh plugin --profile desktop add file:D:/everything/dsh/dsh-bili-surfer
```

本机没有全局 `dsh` CLI，所以是直接在 profile 目录里挂的软链（改代码后重启即生效，不用重装）：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:D:/everything/dsh/dsh-bili-surfer"
# profile 的 package.json 里 dsh.profile.bundles 要加上 "dsh-bili-surfer"
```

**装完必须重启 DSH**（bundle 的 patch 只在启动时读，profile 层不热重载）。重启后：**设置 → 刷B站**。

## 设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `source` | `search` | `search` / `popular` / `recommend` |
| `keywords` | DSH 相关三个词 | `source=search` 时用；最多取前 5 个 |
| `order` | `pubdate` | 搜索排序：`totalrank`/`click`/`pubdate`/`dm`/`stow` |
| `perDay` | `5` | 一轮挑几条（1–20） |
| `maxAgeDays` | `30` | 超过这个天数的不看 |
| `readDanmaku` / `danmakuNum` | `true` / `200` | 读弹幕（游客可用，是最稳的内容信号） |
| `readComments` / `commentNum` | `true` / `20` | 读热评（登录后更全） |
| `autoComment` | `false` | **默认关**。开启后对最值得的 1–3 条发评论 |
| `mentionName` | 空 | 要 @ 的名字（不带 @）。为空则即使开了 `autoComment` 也不发 |
| `commentMax` | `150` | 评论长度上限 |
| `reportLevel` | `full` | `full` 摘录正文 / `brief` 只列条目 / `off` 不写正文（台账照记） |
| `dryRun` | `true` | 安全阀：为真时即使 `autoComment` 开着也**不发**任何东西 |

## 落盘位置

全部在 `<DSH_HOME>/bili-surfer/`，**不写插件包目录**：

| 文件 | 内容 |
|---|---|
| `config.json` | 归一化后的配置（比 DSH settings 更权威，文件优先） |
| `state.json` | 上一轮时间/数量/报告路径、今日轮数 |
| `seen.md` | 看过的台账（Markdown 表格，可手改） |
| `out/<日期>.md` | 每日报告 |
| `surf.log` | 逐行日志（设置页只显示尾部 2KB） |
| `credential.json` | 扫码登录得到的 `sessdata/bili_jct/buvid3/dedeuserid` |

## 能力边界（诚实版）

- **未登录**：搜索、弹幕、简介、标签、热门、推荐都能用；**字幕和 AI 摘要读不到**（b 站只在登录后下发），评论也发不出去。此时报告按「弹幕 + 简介」降级。
- **字幕本来就不多**：B 站 UGC 视频大部分没有 CC 字幕，即使登录也可能为空。这不是 bug，报告里会写明「无字幕」。
- **`/x/player/wbi/v2`、`conclusion/get`、`reply/add` 都需要登录**（未登录分别返回 `-101` / `-403`）。
- **发评论后不一定立刻公开**：新号/低频号会先审后放，插件会在 90 秒后回头查一次并在报告里写「可见 / 暂时不可见 / 没查到」——措辞永远是「没查到」，不说「没发出去」。

## 开发

```bash
node selfcheck.mjs        # 离线预检：假 ctx 挂载宿主、假 DOM 挂载设置页、源码不变式断言
node selfcheck.live.mjs   # 联网冒烟：真打 b 站接口，验证 lib/
node selfcheck.round.mjs  # 联网跑一轮，报告打到临时目录
node selfcheck.host.mjs   # 对着**正在跑的** dsh 验设置页契约（重启后跑这个）
```

`selfcheck.host.mjs` 只读，默认不打 B 站、不改配置、不跑轮（`--run` 才跑一轮）。它会从
`client.js` 源码里反推设置页真正读的字段名，再逐个到活着的 `/status` 里对账 —— 这样
「源码改了但进程还是旧代码」不会伪装成「设置页莫名为空」。

⚠️ **改完代码必须重启 dsh。** bundle 的 patch 只在启动时读；profile 变化时 DSH 会热挂
新 bundle（所以「设置页出现了刷B站」不等于「跑的是你刚改的代码」——Node 的模块缓存不会
跟着文件走）。判断依据：`node selfcheck.host.mjs` 的第一条就会告诉你了。

`lib/` 分层：

| 文件 | 职责 |
|---|---|
| `lib/net.mjs` | cookie 罐、wbi 签名、统一 UA/Referer、业务码 → 异常 |
| `lib/bili.mjs` | 领域动作：搜索/详情/字幕/摘要/弹幕/评论/登录/发评论/可见性核查 |
| `lib/state.mjs` | 家目录解析、配置白名单化、JSON 读写、日期 |
| `lib/surf.mjs` | 一轮的编排：候选打分 → 读内容 → 出报告 → 可选评论 |
| `lib/report.mjs` | 报告与台账的纯格式化 |

## 许可

MIT
