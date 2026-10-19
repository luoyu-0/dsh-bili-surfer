// B 站领域层：搜索 / 视频信息 / 字幕 / 弹幕 / 评论 / 登录 / 发评论。
// 只做「一个函数 = 一个业务动作」，不关心 DSH，也不碰磁盘。
import { BiliClient, BiliError } from './net.js';
const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 把搜索接口返回的 <em class="keyword">…</em> 标签去掉。 */
export const stripHtml = (s) => String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
export function newClient(opts) {
    return new BiliClient(opts);
}
/** 登录态探测：未登录也能拿到 wbi 密钥，返回 {loggedIn, uname, mid}。 */
export async function whoami(cli) {
    // nav 未登录时 code=-101，这里走 tolerate 分支拿 data。
    const env = await cli.getJson(`${API}/x/web-interface/nav`, undefined, { tolerate: true });
    const nav = env.data;
    return {
        loggedIn: Boolean(nav?.isLogin),
        uname: nav?.uname || '',
        mid: nav?.mid || 0,
        code: env.code,
        message: env.message || '',
    };
}
const ORDERS = new Set([
    'totalrank',
    'click',
    'pubdate',
    'dm',
    'stow',
    'scores',
    'attention',
]);
/** 关键词搜索视频。 */
export async function searchVideos(cli, keyword, { num = 10, order = 'totalrank', page = 1 } = {}) {
    await cli.ensureBuvid();
    const n = Math.max(1, Math.min(50, Number(num) || 10));
    const o = ORDERS.has(order) ? order : 'totalrank';
    const per = 20;
    const out = [];
    for (let p = page; out.length < n; p += 1) {
        const d = await cli.getJson(`${API}/x/web-interface/search/type`, {
            search_type: 'video',
            keyword,
            page: p,
            order: o,
        });
        const list = Array.isArray(d?.result) ? d.result : [];
        if (!list.length)
            break;
        for (const v of list) {
            out.push({
                bvid: v.bvid,
                aid: v.aid,
                title: stripHtml(v.title),
                author: v.author,
                mid: v.mid,
                play: v.play,
                danmaku: v.video_review,
                reply: v.review,
                duration: parseDuration(v.duration), // 搜索接口给的是 "16:33" 字符串，统一成秒
                pubdate: v.pubdate,
                desc: stripHtml(v.description),
                tag: stripHtml(v.tag),
                pic: v.pic?.startsWith('//') ? `https:${v.pic}` : v.pic,
            });
        }
        if (list.length < per)
            break;
        await sleep(400); // 搜索接口翻页别打太急
    }
    return out.slice(0, n);
}
/** 视频详情。多 P 视频返回第一 P 的 cid。 */
export async function videoInfo(cli, bvid) {
    const d = await cli.getJson(`${API}/x/web-interface/view`, { bvid });
    if (!d)
        throw new BiliError(`拿不到视频信息：${bvid}`);
    return {
        bvid: d.bvid,
        aid: d.aid,
        cid: d.cid,
        title: d.title,
        desc: d.desc || '',
        duration: d.duration,
        pubdate: d.pubdate,
        tname: d.tname,
        pic: d.pic,
        pages: (d.pages || []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
        owner: { mid: d.owner?.mid, name: d.owner?.name },
        stat: {
            view: d.stat?.view,
            danmaku: d.stat?.danmaku,
            reply: d.stat?.reply,
            like: d.stat?.like,
            coin: d.stat?.coin,
            favorite: d.stat?.favorite,
            share: d.stat?.share,
        },
    };
}
export const SUBTITLE_PRIORITY = ['zh-CN', 'zh-Hans', 'zh-Hant', 'ai-zh', 'zh', 'ai-en', 'en'];
/**
 * 取字幕正文。b 站把「人工字幕」和「AI 字幕」混在同一个列表里，
 * 未登录时通常一个都不返回（所以读不到字幕不一定是视频没字幕）。
 */
export async function fetchSubtitle(cli, bvid, cid) {
    const d = await cli.getWbi(`${API}/x/player/wbi/v2`, { bvid, cid });
    const subs = d?.subtitle?.subtitles || [];
    if (!subs.length)
        return null;
    const rank = (lan) => {
        const i = SUBTITLE_PRIORITY.indexOf(String(lan));
        return i === -1 ? 99 : i;
    };
    const ranked = [...subs].sort((a, b) => rank(a.lan) - rank(b.lan));
    const pick = ranked[0];
    const rawUrl = String(pick.subtitle_url || '').trim();
    const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
    if (!url)
        return null;
    // 正文在 aisubtitle.hdslb.com 这个 CDN 上：auth_key 分钟级有效，**URL 尾部不能截断**
    // （截了就是 403），而且要带视频页 Referer。
    // ⚠️ 这个响应是**裸 JSON**（`{"body":[{from,to,location,content}]}`），没有 code/message 信封，
    // 所以不能走 getJson（它按 code===0 判定，会拿 undefined 当错误抛）——和弹幕 XML 一样直接读 body。
    const res = await cli.raw(url, { headers: { Referer: `https://www.bilibili.com/video/${bvid}` } });
    const raw = await res.text();
    let body;
    try {
        body = JSON.parse(raw);
    }
    catch {
        throw new BiliError(`字幕正文不是 JSON（HTTP ${res.status}）：${raw.slice(0, 120)}`, res.status);
    }
    // 文档里的形状是裸 JSON；万一哪天套上了信封，也认 data.body。
    const arr = Array.isArray(body?.body) ? body.body : body?.data?.body;
    if (!Array.isArray(arr)) {
        throw new BiliError(`字幕正文格式不对（HTTP ${res.status}）：${raw.slice(0, 120)}`, res.status);
    }
    const lines = (body?.body || []).map((l) => ({ from: l.from, to: l.to, text: String(l.content || '').trim() }));
    return {
        lan: String(pick.lan || ''),
        lanDoc: String(pick.lan_doc || ''),
        ai: Boolean(pick.ai_status) || /^ai-/.test(String(pick.lan)),
        lines,
        text: joinLines(lines),
    };
}
/** 字幕/弹幕/ASR 文本清洗：去重复行、去纯符号行、压掉时间戳噪音。 */
export function joinLines(lines) {
    const seen = new Set();
    const out = [];
    for (const l of lines) {
        const t = String(l.text || '').trim();
        if (!t || /^[\s.,!?，。！？、~～…—-]+$/.test(t))
            continue;
        if (seen.has(t))
            continue;
        seen.add(t);
        out.push(t);
    }
    // 相邻短句合并成段落，方便读；每段 ~200 字。
    const paras = [];
    let buf = '';
    for (const t of out) {
        if (buf && (buf + t).length > 200) {
            paras.push(buf);
            buf = '';
        }
        buf += t;
        if (/[。！？!?]$/.test(t) && buf.length > 60) {
            paras.push(buf);
            buf = '';
        }
    }
    if (buf)
        paras.push(buf);
    return paras.join('\n');
}
/** AI 视频摘要（需登录，未登录返回 -403）。拿不到就返回 null，别当失败。 */
export async function fetchAiSummary(cli, bvid, cid, upMid) {
    try {
        const d = await cli.getWbi(`${API}/x/web-interface/view/conclusion/get`, {
            bvid,
            cid,
            up_mid: upMid || 0,
        });
        const mr = d?.model_result;
        const s = mr?.summary;
        if (!s)
            return null;
        return {
            summary: s,
            outline: (mr?.outline || []).map((o) => `${o.title}：${(o.part_outline || []).join('；')}`),
        };
    }
    catch {
        return null;
    }
}
/** 弹幕（无需登录）。返回按时间排序的文本数组。 */
export async function fetchDanmaku(cli, cid, { num = 300 } = {}) {
    const res = await cli.raw(`${API}/x/v1/dm/list.so?oid=${cid}`, { redirect: 'follow' });
    const xml = await res.text();
    const texts = [];
    for (const m of xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
        const t = stripHtml(m[2]).trim();
        if (t)
            texts.push(t);
    }
    return texts.slice(0, Math.max(1, Math.min(2000, num)));
}
const REPLY_SORT = { hot: 2, time: 0 };
const normReply = (r) => ({
    rpid: r.rpid_str || String(r.rpid),
    root: r.root_str || String(r.root || 0),
    user: r.member?.uname || '',
    mid: r.mid,
    message: r.content?.message || '',
    like: r.like,
    ctime: r.ctime,
    replies: (r.replies || []).map((x) => ({
        rpid: x.rpid_str || String(x.rpid),
        user: x.member?.uname || '',
        message: x.content?.message || '',
        like: x.like,
        ctime: x.ctime,
    })),
});
/**
 * 读评论。优先新接口（需登录），失败回退老接口（游客可读）。
 */
export async function fetchComments(cli, bvid, aid, { num = 30, sort = 'hot' } = {}) {
    const n = Math.max(1, Math.min(100, Number(num) || 30));
    const out = [];
    try {
        let next = 0;
        while (out.length < n) {
            const d = await cli.getWbi(`${API}/x/v2/reply/wbi/main`, {
                oid: aid,
                type: 1,
                mode: sort === 'time' ? 2 : 3,
                next,
                ps: 20,
            });
            const replies = d?.replies || [];
            if (!replies.length)
                break;
            for (const r of replies)
                out.push(normReply(r));
            next = d?.cursor?.next ?? 0;
            if (!next)
                break;
            await sleep(500);
        }
    }
    catch {
        out.length = 0;
    }
    if (!out.length) {
        // 游客兜底：老接口 + sort=2（热度）
        const d = await cli.getJson(`${API}/x/v2/reply`, {
            type: 1,
            oid: aid,
            sort: REPLY_SORT[sort] ?? 2,
            ps: Math.min(20, n),
            pn: 1,
        });
        for (const r of d?.replies || [])
            out.push(normReply(r));
    }
    return out.slice(0, n);
}
/** 发一条评论（或回复）。root/parent 都为 0 时是主楼评论。 */
export async function sendComment(cli, { aid, text, root = 0, parent = 0 }) {
    if (!cli.loggedIn)
        throw new BiliError('没有登录，发不了评论');
    const msg = String(text || '').trim();
    if (!msg)
        throw new BiliError('评论内容为空');
    if (msg.length > 1000)
        throw new BiliError(`评论太长（${msg.length} > 1000）`);
    const d = await cli.postForm(`${API}/x/v2/reply/add`, {
        oid: aid,
        type: 1,
        message: msg,
        root: root || 0,
        parent: parent || 0,
        plat: 1,
        ordering: 'heat',
    });
    const r = d?.reply;
    return {
        rpid: r?.rpid_str || String(r?.rpid || ''),
        message: r?.content?.message || msg,
        ctime: r?.ctime || Math.floor(Date.now() / 1000),
    };
}
/**
 * 比对一个 rpid：b 站同时给 `rpid`（数字）与 `rpid_str`（字符串）。
 * 数字在大数上会被 JSON.parse 丢精度（rpid 是 int64），所以**优先用字符串**比对，
 * 否则「刚发的评论明明在列表里，却被判成不可见」。
 */
const sameRpid = (x, rpid) => {
    const a = x?.rpid_str != null ? String(x.rpid_str) : String(x?.rpid ?? '');
    return a !== '' && a === String(rpid);
};
/** 新评论是否真的对公众可见（api 说成功 ≠ 别人看得见）。null = 不确定。 */
export async function isCommentVisible(cli, aid, rpid, { root = 0 } = {}) {
    try {
        if (root) {
            const d = await cli.getJson(`${API}/x/v2/reply/reply`, { type: 1, oid: aid, root, ps: 20, pn: 1 });
            return (d?.replies || []).some((x) => sameRpid(x, rpid));
        }
        const d = await cli.getWbi(`${API}/x/v2/reply/wbi/main`, { oid: aid, type: 1, mode: 3, next: 0, ps: 20 });
        const all = [...(d?.replies || []), ...((d?.top_replies || []) || [])];
        return all.some((x) => sameRpid(x, rpid));
    }
    catch {
        return null; // 不确定 ≠ 没发出去
    }
}
export async function popular(cli, { num = 20 } = {}) {
    const d = await cli.getJson(`${API}/x/web-interface/popular`, { ps: Math.min(50, num), pn: 1 });
    return (d?.list || []).map((v) => ({
        bvid: v.bvid,
        aid: v.aid,
        title: String(v.title ?? ''),
        author: v.owner?.name,
        mid: v.owner?.mid,
        play: v.stat?.view,
        danmaku: v.stat?.danmaku,
        reply: v.stat?.reply,
        duration: parseDuration(v.duration),
        pubdate: v.pubdate,
        desc: v.desc,
        pic: v.pic,
    }));
}
export async function recommend(cli, { num = 12 } = {}) {
    await cli.ensureBuvid();
    const d = await cli.getWbi(`${API}/x/web-interface/wbi/index/top/feed/rcmd`, {
        fresh_type: 3,
        ps: Math.min(30, num),
        fresh_idx: 1,
        feed_version: 'V8',
        homepage_ver: 1,
        ps_ver: 'V8',
    });
    return (d?.item || [])
        .filter((v) => v.bvid)
        .map((v) => ({
        bvid: v.bvid,
        aid: v.aid,
        title: String(v.title ?? ''),
        author: v.owner?.name,
        mid: v.owner?.mid,
        play: v.stat?.view,
        danmaku: v.stat?.danmaku,
        reply: v.stat?.reply,
        duration: parseDuration(v.duration),
        pubdate: v.pubdate,
        desc: v.desc,
        pic: v.pic,
    }));
}
export async function tags(cli, bvid) {
    try {
        const d = await cli.getJson(`${API}/x/tag/archive/tags`, { bvid });
        return (d || []).map((t) => String(t.tag_name ?? ''));
    }
    catch {
        return [];
    }
}
const QR_STATE = {
    86101: { status: 'waiting', text: '等待扫码' },
    86090: { status: 'scanned', text: '已扫码，请在手机上确认' },
    86038: { status: 'expired', text: '二维码已过期' },
    0: { status: 'ok', text: '登录成功' },
};
export async function qrStart(cli) {
    const d = await cli.getJson(`${PASSPORT}/x/passport-login/web/qrcode/generate`, { source: 'main-fe-header' });
    if (!d?.url || !d?.qrcode_key)
        throw new BiliError('拿不到登录二维码');
    return { url: d.url, key: d.qrcode_key };
}
/** 轮询扫码结果。凭证只从 Set-Cookie 里取（data.url 里的参数不全）。 */
export async function qrPoll(cli, key) {
    const res = await cli.raw(`${PASSPORT}/x/passport-login/web/qrcode/poll?${new URLSearchParams({ qrcode_key: key, source: 'main-fe-header' })}`, {
        redirect: 'manual',
    });
    const text = await res.text();
    let env = {};
    try {
        env = JSON.parse(text);
    }
    catch {
        /* 未扫码时偶尔返回空 body */
    }
    // ⚠️ passport 的回包有两层 code：外层恒为 0（"OK" = 这次请求本身没问题），
    // 真正的扫码状态在内层 `data.code`（86101 未扫 / 86090 已扫待确认 / 86038 过期 / 0 成功）。
    // 读外层就会**还没扫就说「登录成功」**——实测踩过（对着活着的进程打真实 passport 抓到的）。
    const inner = env?.data && typeof env.data === 'object' ? env.data.code : undefined;
    const code = inner === undefined ? env?.code ?? null : inner;
    const state = (code !== null ? QR_STATE[code] : undefined) || {
        status: 'unknown',
        text: env?.data?.message || env?.message || `未知状态 ${code}`,
    };
    const cred = BiliClient.pickCredentials(cli.cookies);
    if (state.status === 'ok' && !cred?.sessdata) {
        // 状态说成功、但响应里没有 Set-Cookie：不能装作登录成功（否则设置页会显示已登录、
        // 而后面每一次读字幕/评论都静默降级成游客）。
        return { status: 'error', code, text: '登录接口说成功了，但没拿到凭证（响应里没有 Set-Cookie）', credentials: undefined };
    }
    return { ...state, code, credentials: cred };
}
// ---------------------------------------------------------------- 文本工具
/** 秒 → mm:ss（超过一小时 → h:mm:ss）。也容忍已经是 "16:33" 的字符串（原样返回）。 */
export function fmtTime(sec) {
    let v = sec;
    if (typeof v === 'string') {
        const t = v.trim();
        if (/^\d+(:\d{1,2}){1,2}$/.test(t))
            return t; // 搜索接口那种 "16:33"，别再算成 00:00
        if (t === '')
            return '—';
        v = Number(t);
    }
    const n = Number(v);
    if (!Number.isFinite(n))
        return '—';
    const s = Math.max(0, Math.floor(n));
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    if (s >= 3600)
        return `${Math.floor(s / 3600)}:${mm}:${ss}`;
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${ss}`;
}
/**
 * 时长统一成**秒**。
 * ⚠️ 两个接口给的形状不一样：搜索接口是字符串 `"16:33"`，详情接口是秒 `993`。
 * 不统一的话，凡是按秒格式化的地方（日报的「时长」、`bili_surf_search` 的输出）
 * 都会把它算成 NaN → 全部显示 `00:00`。踩过一次，是靠真调用工具看出来的。
 */
export function parseDuration(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
    const t = String(v ?? '').trim();
    if (!t)
        return 0;
    const parts = t.split(':');
    if (parts.length > 3)
        return 0;
    const nums = parts.map((x) => Number(x));
    if (nums.some((n) => !Number.isFinite(n) || n < 0))
        return 0;
    return nums.reduce((acc, n) => acc * 60 + n, 0);
}
/** 播放量/弹幕数 → 1.2万 */
export function fmtCount(n) {
    const v = Number(n) || 0;
    if (v >= 100_000_000)
        return `${(v / 100_000_000).toFixed(1)}亿`;
    if (v >= 10_000)
        return `${(v / 10_000).toFixed(1)}万`;
    return String(v);
}
