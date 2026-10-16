// B 站 HTTP 底座：cookie 罐、wbi 签名、统一 UA/Referer、可读错误。
// 只依赖 node 内置能力（全局 fetch / node:crypto），没有任何第三方包。
import { createHash } from 'node:crypto'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// wbi 混淆表，来自 b 站前端 img_key/sub_key → w_rid 的固定置换。
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26,
  17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]

const md5 = (s) => createHash('md5').update(s).digest('hex')

/** wbi 只接受这些字符原样，其余必须 encodeURIComponent（b 站前端同款规则）。 */
function enc(v) {
  return encodeURIComponent(String(v).replace(/[!'()*]/g, ''))
}

export function mixinKey(imgKey, subKey) {
  return MIXIN_TAB.map((n) => (imgKey + subKey)[n]).join('').slice(0, 32)
}

export function signWbi(params, imgKey, subKey) {
  const wts = Math.round(Date.now() / 1000)
  const query = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&')
  return `${query}&wts=${wts}&w_rid=${md5(query + mixinKey(imgKey, subKey))}`
}

export class BiliError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BiliError'
    this.code = code
  }
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
}))

/**
 * 有状态的 B 站客户端。同一实例复用一个 cookie 罐，wbi 密钥按天缓存。
 * 所有方法要么返回数据，要么抛 BiliError（带 b 站业务码），调用方不必再判 code。
 */
export class BiliClient {
  #jar = new Map()
  #wbi = null // { imgKey, subKey, day }
  #log

  constructor({ cookies, logger } = {}) {
    this.#log = typeof logger === 'function' ? logger : () => {}
    if (cookies && typeof cookies === 'object') this.setCookies(cookies)
  }

  get cookieHeader() {
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** 只保留 b 站真正用得上的四个凭证键（小写），其余（如 b_nut）不进凭证文件。 */
  static pickCredentials(cookies) {
    const out = {}
    for (const [key, name] of COOKIE_ALIAS) {
      const v = cookies?.[key] ?? cookies?.[name]
      if (v) out[key] = String(v)
    }
    return out
  }

  /**
   * ⚠️ cookie 名在 B 站那边是**大小写敏感**的：`SESSDATA` 不认 `sessdata`。
   * 而凭证文件里存的是小写键（pickCredentials 的输出），所以进来时必须映射回官方名，
   * 否则「扫码成功 → 读字幕/评论仍然像游客」——而且一路不报错，特别难查。
   */
  setCookies(cookies) {
    const alias = COOKIE_ALIAS
    for (const [k, v] of Object.entries(cookies || {})) {
      if (v == null || v === '') continue
      this.#jar.set(alias.get(String(k).toLowerCase()) || String(k), String(v))
    }
  }


  get cookies() {
    return Object.fromEntries(this.#jar)
  }

  get csrf() {
    return this.#jar.get('bili_jct') || ''
  }

  get loggedIn() {
    return Boolean(this.#jar.get('SESSDATA'))
  }

  #absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const c of list) {
      const pair = c.split(';')[0]
      const i = pair.indexOf('=')
      if (i > 0) {
        const k = pair.slice(0, i).trim()
        const v = pair.slice(i + 1).trim()
        // b 站用 `key=deleted` + Max-Age=0 表示登出，别把它当成新值存下来。
        if (!v || v === 'deleted') this.#jar.delete(k)
        else this.#jar.set(k, v)
      }
    }
    return res
  }

  async raw(url, { method = 'GET', headers, body, redirect } = {}) {
    const res = await fetch(url, {
      method,
      body,
      redirect,
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(this.#jar.size ? { Cookie: this.cookieHeader } : {}),
        ...(headers || {}),
      },
    })
    return this.#absorb(res)
  }

  /** 无 wbi 的 JSON 接口（GET）。opts.tolerate=true 时返回信封而不是抛错。 */
  async getJson(url, params, opts) {
    const q = params ? `?${new URLSearchParams(params)}` : ''
    const { tolerate, ...rest } = opts || {}
    return this.#json(await this.raw(url + q, { method: 'GET', ...rest }), url, tolerate)
  }

  /** 需要 wbi 签名的 GET。 */
  async getWbi(url, params, opts) {
    const { imgKey, subKey } = await this.wbiKeys()
    const q = signWbi(params || {}, imgKey, subKey)
    const { tolerate, ...rest } = opts || {}
    return this.#json(await this.raw(`${url}?${q}`, { method: 'GET', ...rest }), url, tolerate)
  }

  /** 表单 POST（b 站写操作一律带 csrf=bili_jct）。 */
  async postForm(url, data, opts) {
    const body = new URLSearchParams({ ...data, csrf: this.csrf })
    const { tolerate, ...rest } = opts || {}
    return this.#json(
      await this.raw(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        ...rest,
      }),
      url,
      tolerate,
    )
  }

  async #json(res, url, tolerate) {
    const text = await res.text()
    let env
    try {
      env = JSON.parse(text)
    } catch {
      if (tolerate) return { ok: false, code: res.status, message: 'non-json', data: null, raw: text.slice(0, 300) }
      throw new BiliError(`${url} 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, res.status)
    }
    const code = env.code
    if (tolerate) {
      return { ok: code === 0, code, message: env.message || '', data: env.data ?? env.result ?? null }
    }
    if (code !== 0) throw new BiliError(`${code} ${env.message || ''} @ ${url}`, code)
    return env.data ?? env.result ?? null
  }

  /**
   * nav 一次拿到 wbi 密钥；密钥每天凌晨换，缓存到「北京日期」变化为止。
   * 注意：未登录时 nav 的业务码是 -101，但 wbi_img 照样在 data 里 —— 所以必须 tolerate。
   */
  async wbiKeys(force = false) {
    const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    if (!force && this.#wbi?.day === day) return this.#wbi
    const env = await this.getJson('https://api.bilibili.com/x/web-interface/nav', undefined, { tolerate: true })
    const nav = env?.data
    const pick = (u) => String(u || '').slice(String(u || '').lastIndexOf('/') + 1).split('.')[0]
    const imgKey = pick(nav?.wbi_img?.img_url)
    const subKey = pick(nav?.wbi_img?.sub_url)
    if (!imgKey || !subKey) {
      throw new BiliError(`拿不到 wbi 密钥（nav ${env?.code} ${env?.message}）`)
    }
    this.nav = {
      loggedIn: Boolean(nav?.isLogin),
      uname: nav?.uname || '',
      mid: nav?.mid || 0,
      code: env.code,
    }
    this.#wbi = { imgKey, subKey, day }
    return this.#wbi
  }

  /** 无 cookie 时补一个 buvid3，能显著降低风控概率。 */
  async ensureBuvid() {
    if (this.#jar.get('buvid3')) return this.#jar.get('buvid3')
    const d = await this.getJson('https://api.bilibili.com/x/frontend/finger/spi')
    if (d?.b_3) this.#jar.set('buvid3', d.b_3)
    if (d?.b_4) this.#jar.set('buvid4', d.b_4)
    return this.#jar.get('buvid3') || ''
  }
}
