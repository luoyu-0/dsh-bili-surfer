// B 站 HTTP 底座：cookie 罐、wbi 签名、统一 UA/Referer、可读错误。
// 只依赖 node 内置能力（全局 fetch / node:crypto），没有任何第三方包。
import { createHash } from 'node:crypto';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** 业务码 + 可读消息的异常，调用方不必再判 code。 */
export class BiliError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = 'BiliError';
        this.code = code;
    }
}
// wbi 混淆表，来自 b 站前端 img_key/sub_key → w_rid 的固定置换。
const MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
    9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26,
    17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
    44, 52,
];
const md5 = (s) => createHash('md5').update(s).digest('hex');
/**
 * 每个请求都要有上限。没有它，一个黑洞连接（TCP 建上了但不回）能把整轮永久挂住：
 * 工具不带 timeoutMs、`/run` 又是后台跑的，用户只会看到设置页永远显示「正在跑」，
 * 唯一出路是重启 dsh。有它最坏也只是「这一条读失败」，其余照跑。
 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** wbi 只接受这些字符原样，其余必须 encodeURIComponent（b 站前端同款规则）。 */
function enc(v) {
    return encodeURIComponent(String(v).replace(/[!'()*]/g, ''));
}
export function mixinKey(imgKey, subKey) {
    return MIXIN_TAB.map((n) => (imgKey + subKey)[n]).join('').slice(0, 32);
}
export function signWbi(params, imgKey, subKey) {
    const wts = Math.round(Date.now() / 1000);
    // ⚠️ 必须滤掉 undefined/null：`enc()` 会把它们变成字符串 "undefined"，
    // 于是 `up_mid=undefined` 这种参数被发出去，接口按「非法参数」处理，
    // 症状是「有的视频就是读不到 AI 摘要」，而不是报错。
    const query = Object.keys(params)
        .filter((k) => params[k] !== undefined && params[k] !== null)
        .sort()
        .map((k) => `${enc(k)}=${enc(params[k])}`)
        .join('&');
    return `${query}&wts=${wts}&w_rid=${md5(query + mixinKey(imgKey, subKey))}`;
}
/**
 * 凭证文件里存的是小写键，而 B 站只认官方名（`SESSDATA` 不认 `sessdata`）。
 * 存盘 / 回填两个方向都走这一张表 —— 否则会出现「扫码说成功，读字幕却仍是游客」，
 * 而且全程不报错，极难排查。
 */
const COOKIE_ALIAS = new Map(Object.entries({
    sessdata: 'SESSDATA',
    bili_jct: 'bili_jct',
    buvid3: 'buvid3',
    dedeuserid: 'DedeUserID',
}));
/**
 * 有状态的 B 站客户端。同一实例复用一个 cookie 罐，wbi 密钥按天缓存。
 * 所有方法要么返回数据，要么抛 BiliError（带 b 站业务码），调用方不必再判 code。
 */
export class BiliClient {
    #jar = new Map();
    #wbi = null; // { imgKey, subKey, day }
    #log;
    /** `wbiKeys()` 成功之后才有值。 */
    navInfo = null;
    constructor({ cookies, logger } = {}) {
        this.#log = typeof logger === 'function' ? logger : () => { };
        if (cookies && typeof cookies === 'object')
            this.setCookies(cookies);
    }
    get cookieHeader() {
        return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    /** 只保留 b 站真正用得上的四个凭证键（小写），其余（如 b_nut）不进凭证文件。 */
    static pickCredentials(cookies) {
        const out = {};
        for (const [key, name] of COOKIE_ALIAS) {
            const v = cookies?.[key] ?? cookies?.[name];
            if (v)
                out[key] = String(v);
        }
        // 没有 sessdata 就等于没有登录态。返回 undefined 而不是 `{}` —— `{}` 是真值，
        // 会让调用方的 `if (credentials)` 误判成「拿到凭证了、登录成功」。
        return out.sessdata ? out : undefined;
    }
    /**
     * ⚠️ cookie 名在 B 站那边是**大小写敏感**的：`SESSDATA` 不认 `sessdata`。
     * 而凭证文件里存的是小写键（pickCredentials 的输出），所以进来时必须映射回官方名，
     * 否则「扫码成功 → 读字幕/评论仍然像游客」——而且一路不报错，特别难查。
     */
    setCookies(cookies) {
        const alias = COOKIE_ALIAS;
        for (const [k, v] of Object.entries(cookies || {})) {
            if (v == null || v === '')
                continue;
            this.#jar.set(alias.get(String(k).toLowerCase()) || String(k), String(v));
        }
    }
    get cookies() {
        return Object.fromEntries(this.#jar);
    }
    get csrf() {
        return this.#jar.get('bili_jct') || '';
    }
    get loggedIn() {
        return Boolean(this.#jar.get('SESSDATA'));
    }
    #absorb(res) {
        const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        for (const c of list) {
            const pair = c.split(';')[0];
            const i = pair.indexOf('=');
            if (i > 0) {
                const k = pair.slice(0, i).trim();
                const v = pair.slice(i + 1).trim();
                // b 站用 `key=deleted` + Max-Age=0 表示登出，别把它当成新值存下来。
                if (!v || v === 'deleted')
                    this.#jar.delete(k);
                else
                    this.#jar.set(k, v);
            }
        }
        return res;
    }
    async raw(url, opts = {}) {
        const { method = 'GET', headers, body, redirect, timeoutMs } = opts;
        // 凭证只发给 bilibili.com。字幕正文在 aisubtitle.hdslb.com 这个 CDN 上，
        // 浏览器也不会把 bilibili.com 的 cookie 发到 *.hdslb.com，我们照做。
        // （解析不出域名时按 api.bilibili.com 处理：所有调用点给的都是绝对 URL。）
        let host = 'api.bilibili.com';
        try {
            host = new URL(url, 'https://api.bilibili.com').hostname;
        }
        catch {
            /* 保持兜底 */
        }
        const withCookies = this.#jar.size > 0 && /(^|\.)bilibili\.com$/i.test(host);
        const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
        const res = await fetch(url, {
            method,
            body,
            redirect,
            // 超时到点 fetch 直接 reject（TimeoutError），由调用方的 try/catch 收成「这条读失败」。
            signal: AbortSignal.timeout(limit),
            headers: {
                'User-Agent': UA,
                Referer: 'https://www.bilibili.com/',
                Origin: 'https://www.bilibili.com',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                ...(withCookies ? { Cookie: this.cookieHeader } : {}),
                ...(headers || {}),
            },
        });
        return this.#absorb(res);
    }
    async getJson(url, params, opts) {
        const q = params ? `?${new URLSearchParams(params)}` : '';
        const { tolerate, ...rest } = opts || {};
        return this.#json(await this.raw(url + q, { method: 'GET', ...rest }), url, tolerate);
    }
    async getWbi(url, params, opts) {
        const { imgKey, subKey } = await this.wbiKeys();
        const q = signWbi(params || {}, imgKey, subKey);
        const { tolerate, ...rest } = opts || {};
        return this.#json(await this.raw(`${url}?${q}`, { method: 'GET', ...rest }), url, tolerate);
    }
    async postForm(url, data, opts) {
        const body = new URLSearchParams({ ...data, csrf: this.csrf });
        // ⚠️ headers 要从 opts 里单独摘出来再合并：写成 `...rest` 会整个顶掉 Content-Type，
        // 表单就发成了无类型的 body（B 站按空表单处理，症状是「评论发出去但没内容」）。
        const { tolerate, headers, ...rest } = opts || {};
        return this.#json(await this.raw(url, {
            method: 'POST',
            body,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(headers || {}) },
            ...rest,
        }), url, tolerate);
    }
    async #json(res, url, tolerate) {
        const text = await res.text();
        let env;
        try {
            env = JSON.parse(text);
        }
        catch {
            if (tolerate)
                return { ok: false, code: res.status, message: 'non-json', data: null, raw: text.slice(0, 300) };
            throw new BiliError(`${url} 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, res.status);
        }
        const code = typeof env.code === 'number' ? env.code : null;
        if (tolerate) {
            return { ok: code === 0, code, message: env.message || '', data: env.data ?? env.result ?? null };
        }
        if (code !== 0)
            throw new BiliError(`${code} ${env.message || ''} @ ${url}`, code);
        return env.data ?? env.result ?? null;
    }
    /**
     * nav 一次拿到 wbi 密钥；密钥每天凌晨换，缓存到「北京日期」变化为止。
     * 注意：未登录时 nav 的业务码是 -101，但 wbi_img 照样在 data 里 —— 所以必须 tolerate。
     */
    async wbiKeys(force = false) {
        const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
        if (!force && this.#wbi?.day === day)
            return this.#wbi;
        const env = await this.getJson('https://api.bilibili.com/x/web-interface/nav', undefined, { tolerate: true });
        const nav = env.data;
        const pick = (u) => String(u || '').slice(String(u || '').lastIndexOf('/') + 1).split('.')[0];
        const imgKey = pick(nav?.wbi_img?.img_url);
        const subKey = pick(nav?.wbi_img?.sub_url);
        if (!imgKey || !subKey) {
            throw new BiliError(`拿不到 wbi 密钥（nav ${env.code} ${env.message}）`);
        }
        this.navInfo = {
            loggedIn: Boolean(nav?.isLogin),
            uname: nav?.uname || '',
            mid: nav?.mid || 0,
            code: env.code,
        };
        this.#wbi = { imgKey, subKey, day };
        return this.#wbi;
    }
    /** 无 cookie 时补一个 buvid3，能显著降低风控概率。 */
    async ensureBuvid() {
        if (this.#jar.get('buvid3'))
            return this.#jar.get('buvid3');
        const d = await this.getJson('https://api.bilibili.com/x/frontend/finger/spi', undefined);
        if (d?.b_3)
            this.#jar.set('buvid3', d.b_3);
        if (d?.b_4)
            this.#jar.set('buvid4', d.b_4);
        return this.#jar.get('buvid3') || '';
    }
}
