/**
 * 链接认领：**一条链接只由第一台打开它的设备用**，其余设备只能看
 *
 * ## 为什么要有这一层
 *
 * 身份签名（`model/identity.js` 的 `u/s`）只回答"这个链接是谁的"，它拦不住**转发**：
 * 把链接发到别的群、或截个图，拿到的人就被编辑器当成链接主人。所以再加一层服务器侧状态：
 * 链接首次打开时由那台设备**认领**，认领记录（`<数据目录>/abyss-editor-claims.json`）里
 * 写着"这条链接归哪台设备"，之后：
 *   - 认领的那台设备（带 cookie）→ 照常是链接身份那个角色（管理员 24 小时、群友本次会话）；
 *   - 别人 / 别的设备再点同一条链接 → **降级成只读访客**（能看，不能写）；
 *   - 同一个人换一条新链接（下一个 30 天窗口）→ 是另一条链接，重新认领。
 *
 * ## 三个关键口径
 *
 * 1. **认领键 = 链接的身份 + 用途 + 签发窗口**（`qq:1000000001:admin:ep:2026`）。
 *    只用 QQ 会把"同一个人的上一条链接"和"这一条"混在一起（换链等于没换）；
 *    只用窗口号则每次机器人换链都能重新认领一遍（等于没有认领）。所以是"身份 + 窗口"。
 *    用途（`admin` / `member`）分开是为了**升级不顺手**：群里拿到的普通链接认得是 member，
 *    换成管理员链接时那条链接自己会再认领一次并升权，反过来别人拿到管理员链接也认不出 member 的身份。
 * 2. **设备标识放 cookie，不碰 IP / UA**。随机串，`HttpOnly` + `SameSite=Lax`；
 *    是 https 请求才带 `Secure`（按请求判，不写死）。IP 会因为手机换基站、公司出口 NAT 而误伤，
 *    UA 会因为浏览器升级而变，两者都**不是**"同一台设备"的可靠标识。
 * 3. **cookie 里不放身份**：cookie 只有随机设备号 + 签名，身份由服务器按设备号从认领记录里查。
 *    所以改 cookie 只会得到"另一个设备"，伪造不出别人的身份。签名把**身份与用途**绑进去，
 *    换身份（拿别人的 cookie 配自己的链接）在验签时就被拒。
 *
 * ## 时间与失效
 *
 * - **链接的 5 分钟时间窗**由 `editor.mjs` 在路由层判（`model/identity.js` 的 `verifyWindow`），
 *   本模块只管"谁认领了"；认领本身按**身份证**（见第 1 条）记账，不随 5 分钟窗口滚动——
 *   否则每换一次窗口就等于重新开一次抢认领的机会。
 * - 认领记录 24 小时过期（`CLAIM_TTL_MS`）：过期后是"未认领"，链接窗口还在就重新认领。
 * - 认领文件损坏 / 缺失 / 条目残破，一律**当未认领**处理（不崩、不因此放开写权限）。
 */
import crypto from "node:crypto"

import { aclQq } from "./acl.js"
import { readJson, writeJson } from "./util.js"

/** 认领记录的有效期：24 小时（与管理员 cookie 的 `Max-Age` 同一个口径） */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 认领键里那个"签发窗口"的宽度：30 天，与 `model/identity.js` 的 `TICKET_WINDOW_MS` 同一个量
 *
 * 两边是**同一个约定**（键里存的就是短码签名用的那个窗口号），但这里不 import 那边——
 * 编辑器按插件根加载共享模块（`editor.mjs` 的 `shared()`），本模块只被编辑器侧用到，
 * 引一份相对路径会把"编辑器单独放"的部署形态弄坏。数值对不上时键会对不上，
 * 表现是"同一台设备要重新认领一次"，不会放行不该放行的人。
 */
const EPOCH_MS = 30 * 24 * 60 * 60 * 1000

/** 设备 cookie 名（不进页面脚本：`HttpOnly`） */
export const DEVICE_COOKIE = "abyss_editor_device"

/** 随机设备号：16 字节 */
const newDeviceId = () => crypto.randomBytes(16).toString("hex")

/** 认领键：`<qq>:<用途>:ep:<签发窗口>`；拿不到稳定 QQ 就没有认领这回事（返回空串） */
export const claimKeyOf = ({ qq = "", purpose = "member", epoch = 0 } = {}) => {
  const id = aclQq(qq)
  return id ? `${id}:${purpose === "admin" ? "admin" : "member"}:ep:${Number(epoch) || 0}` : ""
}

/** 认领记录的序列化形态：只留用得上的字段（文件是表旁的旁路状态，不堆无用信息） */
const pack = entries =>
  Object.fromEntries(Object.entries(entries).map(([key, e]) => [key, { device: e.device, claimedAt: e.claimedAt, expiresAt: e.expiresAt }]))

/**
 * 组装认领存储与判定
 *
 * @param {object} deps
 * @param {string} deps.file 认领文件（生产固定 `<插件根>/data/abyss-editor-claims.json`）
 * @param {string} deps.signKey 身份签名密钥（cookie 里的设备号用它签）
 * @param {() => number} [deps.now] 当前时间（测试用；缺省取系统时间）
 */
export function createClaims({ file, signKey, now = () => Date.now() }) {
  const secret = String(signKey ?? "").trim()

  /** 读一份认领记录：读不出来 / 结构不对 / 条目残破 → 当空（**不崩**，也不因此放开写权限） */
  const load = () => {
    const raw = readJson(file)
    const entries = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.entries : null
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { entries: {} }
    const at = Number(now()) || 0
    const out = {}
    for (const [key, e] of Object.entries(entries)) {
      const device = String(e?.device ?? "").trim()
      const expiresAt = Number(e?.expiresAt) || 0
      /**
       * 过期的条目**读的时候就当没有**：表旁状态不能因为"上次谁认领过"而挡住新链接，
       * 也不能让一条坏条目（缺 device）变成"这台设备认领了"。
       */
      if (!key || !device || expiresAt <= at) continue
      out[key] = { device, claimedAt: Number(e?.claimedAt) || 0, expiresAt }
    }
    return { entries: out }
  }

  const save = entries => {
    try {
      writeJson(file, { updatedAt: Number(now()) || 0, entries: pack(entries) })
    } catch (err) {
      /** 写不进去只影响"下次还认不认得出这台设备"，不能连累本次请求 */
      console.warn(`[editor] 认领记录写不进去（${file}）：${err?.message ?? err}`)
    }
  }

  /** 该设备号在这条链接上是否就是认领者 */
  const heldBy = (key, device) => {
    if (!key || !device) return null
    const entry = load().entries[key]
    return entry && entry.device === device ? entry : null
  }

  /** 写入 / 续期一条认领记录（同一个设备重复认领只续期，不重置 `claimedAt`） */
  const hold = (key, device) => {
    if (!key || !device) return null
    const at = Number(now()) || 0
    const entries = load().entries
    const previous = entries[key]
    entries[key] = {
      device,
      claimedAt: previous && previous.device === device ? previous.claimedAt : at,
      expiresAt: at + CLAIM_TTL_MS,
    }
    save(entries)
    return entries[key]
  }

  /* ------------------------------ 设备 cookie ------------------------------ */

  /** 设备号的自证：`<设备号>.<签名>`——签名把**身份 + 用途 + 窗口**一起绑进去 */
  const signDevice = (device, realm) => {
    if (!secret) return ""
    return crypto.createHmac("sha256", secret).update(`abyss-claim.${realm}.${device}`).digest("base64url")
  }

  /**
   * 认领键对应的"服务器怎么认这台设备"：签名过的设备号
   *
   * 把身份与用途绑进签名是**必须的**：cookie 只是随机串，若不绑，
   * 拿着 A 的设备 cookie 去开 B 的链接，服务器就会把 A 认成 B。
   */
  const realmOf = (key, qq) => `${key}|${aclQq(qq)}`

  /**
   * 从 cookie 头里挑出设备号
   *
   * cookie 头可能有很多条、同名 cookie 也可能重复（路径不同），取**最后一个**——
   * 与浏览器一致：后写的覆盖先写的。
   */
  const deviceOf = req => {
    const header = String(req?.headers?.cookie ?? "")
    const parts = header.split(";").map(s => s.trim())
    const prefix = `${DEVICE_COOKIE}=`
    let value = ""
    for (const part of parts) if (part.startsWith(prefix)) value = part.slice(prefix.length)
    if (!value) return ""
    const at = value.lastIndexOf(".")
    if (at <= 0) return ""
    const device = value.slice(0, at)
    if (!/^[0-9a-f]{32}$/.test(device)) return ""
    return { device, mac: value.slice(at + 1) }
  }

  /** 这个 cookie 声称的设备是不是真的（签名对得上、且是对这条链接的签名） */
  const deviceOk = (raw, key, qq) => {
    if (!raw?.device || !raw?.mac || !key) return ""
    const want = signDevice(raw.device, realmOf(key, qq))
    if (!want) return ""
    const got = Buffer.from(String(raw.mac))
    const expected = Buffer.from(want)
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return ""
    return raw.device
  }

  /**
   * **反查**：这台设备认领过哪些链接
   *
   * 为什么需要它：认领之后主人 24 小时内再来时，地址栏已经被页面清干净了——
   * 请求里**没有** `u/s`（那正是"不必再带链接"的意思），所以只能反过来从设备 cookie 找身份。
   * 找法是把 cookie 对着每条认领记录的签名域验一遍：签名里绑了"哪条链接"，
   * 所以只有**当初领了这条链接的那台设备**能验过，别的设备拿同一个 cookie 验不过。
   *
   * @returns {{key: string, entry: object, qq: string, purpose: string, epoch: number}|null}
   */
  const holderOf = req => {
    const raw = deviceOf(req)
    if (!raw) return null
    for (const [key, entry] of Object.entries(load().entries)) {
      /** 认领键是 `<qq>:<用途>:ep:<窗口>`：反查出来的身份与用途就是它自己 */
      const [qq, purpose = "member", , epoch = "0"] = String(key).split(":")
      if (!qq) continue
      if (deviceOk(raw, key, qq) !== entry.device) continue
      return { key, entry, qq, purpose, epoch: Number(epoch) || 0 }
    }
    return null
  }

  /**
   * 给这个响应种 / 续期设备 cookie
   *
   * `Max-Age` 由调用方按角色给：管理员及以上 **24 小时**（`86400`），普通群友**会话 cookie**
   * （不带 `Max-Age`，浏览器关掉就没了——群友的长期身份仍然是"群里重新取链接"，
   * 这一层不该变成第二张长期通行证）。
   *
   * `Secure` 按**这次请求**是不是 https 决定：外网部署（nginx + https）要带，
   * 本机 http 调试带上就等于 cookie 根本种不下去。判据取 `req.socket.encrypted`
   * 与反代常见的 `x-forwarded-proto`，不写死。
   */
  const setDevice = (req, res, device, { key, qq, maxAge }) => {
    const mac = signDevice(device, realmOf(key, qq))
    if (!mac) return
    const https = Boolean(req?.socket?.encrypted) || String(req?.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https"
    const attrs = [`${DEVICE_COOKIE}=${device}.${mac}`, "Path=/", "HttpOnly", "SameSite=Lax"]
    if (https) attrs.push("Secure")
    if (Number(maxAge) > 0) attrs.push(`Max-Age=${Math.floor(Number(maxAge))}`, `Expires=${new Date(Number(now()) + Number(maxAge) * 1000).toUTCString()}`)
    const previous = res.getHeader("set-cookie")
    const list = Array.isArray(previous) ? previous : previous ? [previous] : []
    res.setHeader("set-cookie", [...list, attrs.join("; ")])
  }

  /**
   * 按认领状态判定"这次请求算谁"
   *
   * 三种情形：
   *   1. 设备 cookie 有效且这条链接就是它认领的 → 身份与角色照旧（**不必再带链接**，24 小时内）；
   *   2. 链接的身份签名验得过、且这条链接还没人认领 → 这台设备认领并种 cookie；
   *   3. 其余（链接是别人的 / 没带 cookie 的别人）→ **降级为只读访客**。
   *
   * @param {object} opts
   * @param {import("node:http").IncomingMessage} opts.req
   * @param {import("node:http").ServerResponse} opts.res
   * @param {object} opts.caller `editor/http/auth.js` 判出来的调用者（可能有链接身份）
   * @param {string} opts.key 本次链接的认领键（`claimKeyOf`；没有链接身份时是空串）
   * @param {(identity: object) => {role: string, owner: boolean, adminTokenOk: boolean}} [opts.roleOf]
   *        按身份算当前角色（白名单随时可改，所以认领记录里**不存角色**，每次现算）
   * @param {(qq: string) => string} [opts.nickOf]
   *        按 QQ 现取群昵称（与身份签名那条路同一份来源：认领记录里也不存昵称——
   *        群名片随时能改，存下来的旧名会让"本人只拿到自己那些行"认错行）
   * @returns {{caller: object, device: string, issued: boolean, holder: object|null}}
   *   `caller` 可能是**降级后的访客**（`identity: null` / `role: "guest"` / `downgraded: true`）
   */
  const resolve = ({ req, res, caller, key, roleOf = null, nickOf = () => "" }) => {
    const qq = String(caller?.identity?.qq ?? "")
    /** 不是靠链接身份进来的（没带 `u/s`、或只是管理口令）→ 看看是不是认领过的设备回来了 */
    if (!qq || !key) {
      const holder = holderOf(req)
      if (!holder || !roleOf) return { caller, device: "", issued: false, holder: null }
      const { role, owner, adminTokenOk } = roleOf({ qq: holder.qq, nick: "" })
      const identity = { qq: holder.qq, nick: String(nickOf(holder.qq) ?? ""), issuedAt: holder.epoch * EPOCH_MS }
      setDevice(req, res, holder.entry.device, { key: holder.key, qq: holder.qq, maxAge: role === "admin" ? CLAIM_TTL_MS / 1000 : 0 })
      return { caller: { ...caller, identity, role, owner, adminTokenOk }, device: holder.entry.device, issued: false, holder }
    }

    const raw = deviceOf(req)
    const bound = deviceOk(raw, key, qq)
    /** 拿着**这条链接**的有效设备 cookie = 认领者本人回来（不用重新过时间窗，也不必等链接刷新） */
    if (bound && heldBy(key, bound)) {
      hold(key, bound)
      setDevice(req, res, bound, { key, qq, maxAge: caller.role === "admin" ? CLAIM_TTL_MS / 1000 : 0 })
      return { caller, device: bound, issued: false, holder: { key, entry: heldBy(key, bound), qq, purpose: "", epoch: 0 } }
    }

    /**
     * 链接可用（身份签名验得过）且这条链接还没人认领 → 这台设备就是认领者
     *
     * 走到这里的请求**已经过了路由层的时间窗那一关**：带 `w/ws` 的按窗口判，
     * 没带 `w/ws` 的只有"认领过这条链接的那台设备"才放得过来（见 `editor.mjs` 的「链接的时间窗」）。
     * 所以这里不必再判窗口——它只回答"这条链接归哪台设备"，不回答"这条链接还能不能用"。
     */
    const entry = load().entries[key]
    if (!entry) {
      const device = newDeviceId()
      const held = hold(key, device)
      setDevice(req, res, device, { key, qq, maxAge: caller.role === "admin" ? CLAIM_TTL_MS / 1000 : 0 })
      return { caller, device, issued: true, holder: { key, entry: held, qq, purpose: "", epoch: 0 } }
    }

    /**
     * 认领者是**别的设备**（或这次请求没带 cookie / 带的是别人的 cookie）→ 只看不改
     *
     * 口令仍然有效（能打开服务），但身份不再是链接主人：`role` 降成 `guest`，
     * `identity` 一起清掉——后端的写接口一律先看角色，清理身份是为了不让"降级"只停留在界面上。
     */
    return { caller: { ...caller, identity: null, role: "guest", downgraded: true }, device: "", issued: false, holder: null }
  }

  return {
    file,
    load,
    resolve,
    /** 反查这台设备认领过的链接（认领块先用它算键，再交给 `resolve` 走同一条判定） */
    holderOf,
    /** 续期设备 cookie（认领过一次之后每次带 cookie 回来都续，管理员才谈得上"24 小时内一直有效"） */
    touch: (req, res, { key, qq, role }) =>
      setDevice(req, res, deviceOf(req)?.device ?? "", { key, qq, maxAge: role === "admin" ? CLAIM_TTL_MS / 1000 : 0 }),
  }
}
