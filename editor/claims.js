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
import fs from "node:fs"

import { aclQq } from "./acl.js"
import { readJson, writeJson } from "./util.js"

/** 认领记录的有效期：24 小时（与管理员 cookie 的 `Max-Age` 同一个口径） */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 「新鲜链接可以接管认领」的宽限：**签发后 10 分钟内**的链接才有接管能力
 *
 * 现场：一条成员链接先被**别人**点开 ⇒ 那台设备就成了链接主人，真正的主人再点只能只读；
 * 而且认领键里是 30 天窗口，主人重新发 `#排队` 拿到的短码**字节完全一样**，抢不回来
 * （要等认领记录 24 小时过期）。所以给链接加一段**机器人签发的签发时刻**（`?t=&ts=`），
 * 认领层按"新来这条更新 + 够新"允许接管。
 *
 * 为什么两个条件都要：只看"更新"的话，一条几天前的转发副本也能顶掉正当使用者；
 * 只看"够新"的话，同一份链接的第二台设备（窗口内）也能顶掉——那就等于没有认领了。
 * 10 分钟的口径：窗口是 5 分钟，够覆盖"主人看到被抢、回群里重发一次"的往返。
 */
export const TAKEOVER_GRACE_MS = 10 * 60 * 1000

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

/**
 * 设备令牌的**请求头名**：cookie 之外的第二条路
 *
 * 为什么要有它：页面自己发的 `/api/*` 不带时间窗（地址栏那串 `w/ws` 打开时就被清掉了），
 * 服务端对这类请求只认"认领过这条链接的那台设备"，而唯一凭据原来是 cookie。QQ / 微信的内置浏览器
 * 常把 cookie 当第三方挡掉、或无痕模式不落盘——那样页面能打开、数据却一条都读不到（`/api/*` 拿回
 * 失效页，前端报 "Unexpected token '<'"）。所以认领时把同一个令牌**注入页面**，
 * 之后每次请求用这个头带上；服务端优先读头、没有再读 cookie。
 *
 * 令牌本身与 cookie **同构**（`<设备号>.<HMAC>`，签名把"哪条链接 + 哪个身份"绑进去），
 * 所以换个身份 / 换条链接都验不过——它只证明"这台设备认领过这条链接"，不含身份。
 */
export const DEVICE_HEADER = "x-abyss-device"

/** 随机设备号：16 字节 */
const newDeviceId = () => crypto.randomBytes(16).toString("hex")

/** 认领键：`<qq>:<用途>:ep:<签发窗口>`；拿不到稳定 QQ 就没有认领这回事（返回空串） */
export const claimKeyOf = ({ qq = "", purpose = "member", epoch = 0 } = {}) => {
  const id = aclQq(qq)
  return id ? `${id}:${purpose === "admin" ? "admin" : "member"}:ep:${Number(epoch) || 0}` : ""
}

/** 认领记录的序列化形态：只留用得上的字段（文件是表旁的旁路状态，不堆无用信息） */
const pack = entries =>
  Object.fromEntries(
    Object.entries(entries).map(([key, e]) => [
      key,
      { device: e.device, claimedAt: e.claimedAt, expiresAt: e.expiresAt, issuedAt: Number(e.issuedAt) || 0 },
    ]),
  )

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

  /**
   * 认领记录的**内存镜像**：按文件的 `(mtimeMs, size)` 认版本，文件没被外部改过就直接用它
   *
   * 为什么要有它（2026-10-08 复审报告 §2-#3）：`holderOf` / `heldBy` 每个请求都要读一次认领文件，
   * 而 `readJson` 是**同步读 + JSON.parse**——实测 2000 条（278 KB）时单次 ≈0.76 ms，
   * 一个请求要读好几次（闸里一次反查 + 认领块里一次 + `resolve` 里几次），全压在主线程上。
   * 这里换成：`statSync`（微秒级）先看文件变没变，没变就用内存里那份解析结果。
   *
   * **可见性与"每次都读盘"完全一致**：外部（另一个进程、手工编辑）改了这个文件，`mtime/size`
   * 一定变 ⇒ 立刻重新读。`fileKey()` 拿不到（文件不存在 / 读不到）时**不用缓存**，与
   * `readJson` 读不出来当空的既有口径一致。
   */
  let cache = null

  /** 文件的版本指纹：`mtime:size`；读不到就返回空串（= 不用缓存） */
  const fileKey = () => {
    try {
      const st = fs.statSync(file)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return ""
    }
  }

  /** 设备号 → 认领键[]：`holderOf` 的反查从"扫全表逐条验签"变成"只看同设备号的那几条" */
  const indexOf = entries => {
    const byDevice = new Map()
    for (const [key, entry] of Object.entries(entries)) {
      const list = byDevice.get(entry.device)
      if (list) list.push(key)
      else byDevice.set(entry.device, [key])
    }
    return byDevice
  }

  /**
   * 读一份认领记录：读不出来 / 结构不对 / 条目残破 → 当空（**不崩**，也不因此放开写权限）
   *
   * 过期条目**读的时候就当没有**：表旁状态不能因为"上次谁认领过"而挡住新链接，
   * 也不能让一条坏条目（缺 device）变成"这台设备认领了"。
   */
  const readEntries = () => {
    const key = fileKey()
    if (key && cache && cache.key === key) return cache
    const raw = readJson(file)
    const rawEntries = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.entries : null
    const entries = {}
    if (rawEntries && typeof rawEntries === "object" && !Array.isArray(rawEntries)) {
      const at = Number(now()) || 0
      for (const [k, e] of Object.entries(rawEntries)) {
        const device = String(e?.device ?? "").trim()
        const expiresAt = Number(e?.expiresAt) || 0
        if (!k || !device || expiresAt <= at) continue
        entries[k] = { device, claimedAt: Number(e?.claimedAt) || 0, expiresAt, issuedAt: Number(e?.issuedAt) || 0 }
      }
    }
    cache = { key, entries, byDevice: indexOf(entries) }
    return cache
  }

  /** 旧口径的读法（返回 `{ entries }`）：认领块的调用方只认这个形状 */
  const load = () => ({ entries: readEntries().entries })

  const save = entries => {
    try {
      writeJson(file, { updatedAt: Number(now()) || 0, entries: pack(entries) })
      /** 自己写的这份直接当缓存：`entries` 已经是过完 `load()` 那一道筛的形状 */
      cache = { key: fileKey(), entries, byDevice: indexOf(entries) }
    } catch (err) {
      /** 写不进去只影响"下次还认不认得出这台设备"，不能连累本次请求 */
      console.warn(`[editor] 认领记录写不进去（${file}）：${err?.message ?? err}`)
    }
  }

  /** 该设备号在这条链接上是否就是认领者 */
  const heldBy = (key, device) => {
    if (!key || !device) return null
    const entry = readEntries().entries[key]
    return entry && entry.device === device ? entry : null
  }

  /**
   * 续期的**粒度**：记录还剩这么多有效期时，同一个设备再回来就**不重写文件**
   *
   * 复审 §2-#3 的另一半是写：认领设备**每个请求**都会 `hold(key, bound)` 一次，
   * 于是每个请求都同步写一遍整个认领文件。24 小时的窗口"晚续一分钟"没有任何实际差别，
   * 所以这里按分钟粒度续期 ⇒ 每个设备最多一分钟写一次盘。
   */
  const RENEW_GRANULARITY_MS = 60 * 1000

  /** 写入 / 续期一条认领记录（同一个设备重复认领只续期，不重置 `claimedAt`；够新就不写盘） */
  const hold = (key, device, issuedAt = 0) => {
    if (!key || !device) return null
    const at = Number(now()) || 0
    const entries = readEntries().entries
    const previous = entries[key]
    /**
     * 签发时刻**没带就沿用原值**：认领设备每次回来都会走到这里（`hold(key, bound)` 不带签发时刻），
     * 若把它当 0 写回去，记录里就变成"这条链接没有签发时刻"——紧接着**任何**一条链接都算"更新的一条"，
     * 接管判据会形同虚设（同一份链接的第二台设备也能顶掉主人）。
     */
    const issued = Number(issuedAt) || (previous && previous.device === device ? Number(previous.issuedAt) || 0 : 0)
    /** 同一个设备、记录还够新 ⇒ 不写盘（`expiresAt` 最多晚一分钟才往后推，语义不变） */
    if (previous && previous.device === device && previous.expiresAt - at > RENEW_GRANULARITY_MS) return previous
    entries[key] = {
      device,
      claimedAt: previous && previous.device === device ? previous.claimedAt : at,
      expiresAt: at + CLAIM_TTL_MS,
      issuedAt: issued,
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
   * 解析一个设备令牌（`<设备号>.<签名>`）：cookie 与请求头共用这一份
   *
   * 设备号固定 32 位十六进制（16 字节随机）；格式不对一律当"没带"。
   */
  const parseToken = value => {
    const s = String(value ?? "").trim()
    if (!s) return null
    const at = s.lastIndexOf(".")
    if (at <= 0) return null
    const device = s.slice(0, at)
    if (!/^[0-9a-f]{32}$/.test(device)) return null
    return { device, mac: s.slice(at + 1) }
  }

  /**
   * 从请求里取设备令牌：**请求头优先，其次 cookie**
   *
   * cookie 头可能有很多条、同名 cookie 也可能重复（路径不同），取**最后一个**——
   * 与浏览器一致：后写的覆盖先写的。
   */
  const deviceOf = req => {
    const fromHeader = parseToken(req?.headers?.[DEVICE_HEADER])
    if (fromHeader) return fromHeader
    const header = String(req?.headers?.cookie ?? "")
    const parts = header.split(";").map(s => s.trim())
    const prefix = `${DEVICE_COOKIE}=`
    let value = ""
    for (const part of parts) if (part.startsWith(prefix)) value = part.slice(prefix.length)
    return parseToken(value)
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
    /**
     * 只看**同设备号**的那几条（`byDevice`）：令牌里的设备号必须与记录里的设备号一字不差才可能验过
     * （`deviceOk` 的最后一行就是拿它比的），所以从全表逐条验签缩到"通常只有一条"。
     * 顺序仍按认领键的插入顺序，与从前扫全表时的候选顺序一致。
     */
    const { entries, byDevice } = readEntries()
    for (const key of byDevice.get(raw.device) ?? []) {
      const entry = entries[key]
      if (!entry) continue
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
    /**
     * 同一个令牌也回一份**响应头**：页面（同源脚本）读得到它，存下来之后用 `DEVICE_HEADER` 带上。
     * cookie 被浏览器挡掉时，这是"这台设备认领过这条链接"的唯一证明；cookie 正常时它只是冗余的一份。
     */
    res.setHeader(DEVICE_HEADER, `${device}.${mac}`)
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
   * @param {number} [opts.issuedAt] 这条链接的**签发时刻**（ms；0 = 老链接没有这段信息）
   *        只有"更新且够新"（`TAKEOVER_GRACE_MS`）的链接才谈得上**接管**，见下面的第 4 种情形
   * @returns {{caller: object, device: string, issued: boolean, holder: object|null}}
   *   `caller` 可能是**降级后的访客**（`identity: null` / `role: "guest"` / `downgraded: true`）
   */
  const resolve = ({ req, res, caller, key, roleOf = null, nickOf = () => "", issuedAt = 0 }) => {
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
      const held = hold(key, device, issuedAt)
      setDevice(req, res, device, { key, qq, maxAge: caller.role === "admin" ? CLAIM_TTL_MS / 1000 : 0 })
      return { caller, device, issued: true, holder: { key, entry: held, qq, purpose: "", epoch: 0 } }
    }

    /**
     * 4. **新鲜链接可以接管认领**（现场：先点进来的人抢走了主人的写权限）
     *
     * 两个条件缺一不可：
     *   - `issuedAt > entry.issuedAt`：这条链接比当初那条**更新**（同一份链接的第二台设备签发的时刻相同，
     *     顶不掉——"一条链接一台设备"这条防线还在）；
     *   - `now - issuedAt <= TAKEOVER_GRACE_MS`：新归新，还得**够新**（几天前的转发副本签得早，
     *     但它更新不过主人刚重发的那条，也不必给它接管能力）。
     *
     * 于是主人**重新发一次 `#排队`**（短链带着机器人刚签的 `?t&ts=`）就能立刻拿回写权限；
     * 老链接（没有那两段）一律退回"先到先得"，行为与以前一字不差。
     */
    const at = Number(now()) || 0
    const fresh = Number(issuedAt) || 0
    if (fresh && fresh > Number(entry.issuedAt) && fresh <= at && at - fresh <= TAKEOVER_GRACE_MS) {
      const device = newDeviceId()
      const held = hold(key, device, fresh)
      setDevice(req, res, device, { key, qq, maxAge: caller.role === "admin" ? CLAIM_TTL_MS / 1000 : 0 })
      return { caller, device, issued: true, takenOver: true, holder: { key, entry: held, qq, purpose: "", epoch: 0 } }
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
    /**
     * 这台设备在这条链接上的令牌（`<设备号>.<HMAC>`）：注入页面用
     *
     * 与 cookie 里那个值**一字不差**；拼不出来（没配签名密钥）给空串——那就不注入，
     * 页面照旧只靠 cookie（与这一层落地之前的行为一致）。
     */
    tokenOf: (device, key, qq) => {
      const mac = signDevice(String(device ?? ""), realmOf(key, qq))
      return mac ? `${device}.${mac}` : ""
    },
    /** 续期设备 cookie（认领过一次之后每次带 cookie 回来都续，管理员才谈得上"24 小时内一直有效"） */
    touch: (req, res, { key, qq, role }) =>
      setDevice(req, res, deviceOf(req)?.device ?? "", { key, qq, maxAge: role === "admin" ? CLAIM_TTL_MS / 1000 : 0 }),
  }
}
