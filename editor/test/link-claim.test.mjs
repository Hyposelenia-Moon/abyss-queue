/**
 * 链接认领：**一条链接只由第一台打开它的设备用**，其余设备只能看
 *
 * 机器人每 5 分钟换一批链接，链接一次只该被一个人用。三层一起管这件事：
 *   1. **时间窗**（`model/identity.js` 的 `w/ws`）：只认当前窗口与上一窗口，旧链拒收（410）；
 *   2. **认领**（`editor/claims.js`）：链接首次打开由那台设备认领，别人打开降级成只读访客；
 *   3. **cookie**：认领过的设备 24 小时（管理员）不必再带链接，群友只到本次会话。
 *
 * 所以这套要钉住五类行为：
 *   - 认领后同设备身份与角色正确；**别人带同一条链接 ⇒ 只读**（写接口 403）；
 *   - 管理员 cookie `Max-Age=86400`、群友**会话 cookie**（没有 `Max-Age`）；24 小时到期按"未认领"处理；
 *   - 旧窗口链接 ⇒ 410；当前与上一窗口 ⇒ 照常；
 *   - **没带 `w/ws` 的老链**：换一台设备一律 410 + 可读页（口子已关），
 *     而认领过这条链接的那台设备不带窗口照旧放行（编辑器页面自己就是那么发的）；
 *   - 认领文件损坏 / 条目过期 ⇒ 不崩、当未认领。
 *
 * 用法：node editor/test/link-claim.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import path from "node:path"
import { shared } from "./plugin.mjs"
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（缺真实表时也有样本可跑） */
import { SOURCE as SRC } from "./source.mjs"
import { wait, makeWorkspace, signIdentity, signWindow, startEditor, WINDOW_MS } from "./harness.mjs"

const { signTicket, SHORT_PATH } = await shared("model/identity.js")
const { CLAIM_TTL_MS, DEVICE_COOKIE } = await import("../claims.js")

const TOKEN = "link-claim-token"
const SIGN_KEY = "link-claim-sign-key"
/** 主人（也是白名单管理员）：它拿到的链接就是"管理链接" */
const ADMIN = { qq: "1000000001", nick: "缄月" }
/** 白名单管理员（不是主人）：验证"管理员及以上"都按管理员口径种 24 小时 cookie */
const ADMIN2 = { qq: "1000000002", nick: "听雨" }
/** 普通群友（不在白名单里）：只种会话 cookie */
const MEMBER_QQ = "1000000003"
/** 与这条链接无关的另一个人：用它验证"别人换台设备拿同一条链接也只有 403" */
const OTHER = { qq: "1000000004", nick: "路过的" }

const ws = makeWorkspace("link-claim", { source: SRC })
fs.writeFileSync(ws.file("admins.json"), JSON.stringify({ owner: [ADMIN.qq], admins: [ADMIN.qq, ADMIN2.qq] }), "utf8")
const ROSTER = ws.file("roster.json")
/** 群名单：链接里只带 QQ，群昵称由编辑器从这份名单补（与短链那条路一致） */
fs.writeFileSync(ROSTER, JSON.stringify({ group: "100000002", updatedAt: Date.now(), members: [] }), "utf8")

let seq = 0
/**
 * 一个**还没认领过任何链接**的人
 *
 * 认领是一次性的（一条链接认领一次），所以每一段要用"新链接"就必须换一个身份——
 * 拿同一个人再要一条链接，等于同一份身份重新认领，验不出"别人只能看"。
 */
const freshPerson = () => {
  seq++
  return { qq: String(7000000000 + seq), nick: `群友${seq}` }
}

/** 群名单：链接里只带 QQ，群昵称由编辑器从这份名单补（与短链那条路一致） */
const rosterFor = (...people) =>
  fs.writeFileSync(ROSTER, JSON.stringify({ group: "100000002", updatedAt: Date.now(), members: people.map(p => ({ qq: p.qq, nick: p.nick })) }), "utf8")

let failed = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`)
  }
}
const checkEq = (name, got, want) => check(name, got === want, `实际 ${JSON.stringify(got)}，应当 ${JSON.stringify(want)}`)

const editor = await startEditor({
  label: "link-claim",
  token: TOKEN,
  signKey: SIGN_KEY,
  adminsFile: ws.file("admins.json"),
  args: ["--file", ws.fixture],
  env: { ABYSS_QUEUE_CONFIG: ws.cfg, ABYSS_EDITOR_ROSTER_FILE: ROSTER, ABYSS_EDITOR_TEST_PATHS: "1" },
})

/** 一台新"设备"：与 `editor` 各自一个 cookie 罐（同一个端口、同一张表） */
const device = () => {
  const jar = new Map()
  const client = {
    jar,
    request: async (p, opts = {}) => {
      const init = { method: opts.method ?? (opts.body ? "POST" : "GET"), redirect: opts.redirect ?? "manual" }
      const headers = { ...(opts.headers ?? {}) }
      /** `sendCookies: false` = 这台设备**不带**已有 cookie（换设备 / 浏览器清过），但收到的 cookie 照存 */
      if (opts.sendCookies !== false && jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
      if (opts.body) {
        headers["content-type"] = "application/json"
        init.body = JSON.stringify(opts.body)
      }
      init.headers = headers
      const qs = new URLSearchParams({ k: TOKEN, ...(opts.params ?? {}) })
      if (opts.who) {
        const id = signIdentity(opts.who, SIGN_KEY)
        qs.set("u", id.u)
        qs.set("s", id.s)
      }
      const res = await fetch(`${editor.base}${p}${p.includes("?") ? "&" : "?"}${qs}`, init)
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const pair = String(line).split(";")[0].trim()
        const at = pair.indexOf("=")
        if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
      }
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = { __raw: text.slice(0, 300) }
      }
      return { status: res.status, json, text, headers: res.headers, location: res.headers.get("location"), setCookie: res.headers.getSetCookie?.() ?? [] }
    },
    cookieOf: name => {
      for (const [k, v] of jar) if (k === name) return v
      return ""
    },
  }
  return client
}

/**
 * 一条"带时间窗的身份链接"的请求参数
 *
 * `now` 用来造**旧链**：签一个更早窗口的 `w/ws`，编辑器应当拒收。
 * 返回的 `{ params, who }` 直接喂给 `device().request()`（`who` 决定 `u/s`，`params` 是 `w/ws`）。
 */
const link = (who, now = Date.now()) => {
  const win = signWindow(who, SIGN_KEY, now)
  return { params: { w: win.w, ws: win.ws }, who }
}

/** 认领文件里那条记录（直接读文件断言"记了什么"） */
const claimEntry = key => {
  const raw = JSON.parse(fs.readFileSync(ws.file("abyss-editor-claims.json"), "utf8"))
  return raw.entries?.[key] ?? null
}

/** 认领文件里这条链接的键（`<qq>:<用途>:ep:<窗口>`；键里的窗口由插件自己算，套件从文件里读回来） */
const claimKeyFor = (qq, purpose = "member") => {
  const raw = JSON.parse(fs.readFileSync(ws.file("abyss-editor-claims.json"), "utf8"))
  return Object.keys(raw.entries ?? {}).find(k => k.startsWith(`${qq}:${purpose}:ep:`)) ?? ""
}

try {
  /* ------------------------- ① 管理员：认领 → 同设备是管理员，别人只读 ------------------------- */

  const adminDevice = device()
  const adminLink = link(ADMIN)
  const page = await adminDevice.request("/queue/", adminLink)
  check("带时间窗的管理员链接能打开页面", page.status === 200, `HTTP ${page.status}`)
  const deviceCookie = adminDevice.cookieOf(DEVICE_COOKIE)
  check("认领成功 ⇒ 种下设备 cookie（HttpOnly + SameSite=Lax）", /^[0-9a-f]{32}\.[A-Za-z0-9_-]+$/.test(deviceCookie), deviceCookie)
  const adminSetCookie = page.setCookie.find(line => line.startsWith(`${DEVICE_COOKIE}=`)) ?? ""
  check(
    "管理员 cookie 是 24 小时（Max-Age=86400）",
    /Max-Age=86400(;|$)/.test(adminSetCookie) && CLAIM_TTL_MS / 1000 === 86400,
    `${adminSetCookie}；CLAIM_TTL_MS=${CLAIM_TTL_MS}`,
  )
  check("cookie 是 HttpOnly + SameSite=Lax、本机 http 下不写死 Secure", /HttpOnly/.test(adminSetCookie) && /SameSite=Lax/.test(adminSetCookie) && !/Secure/.test(adminSetCookie), adminSetCookie)

  /** 同设备再来一次：不带 `u/s`（模拟"页面把地址栏清干净、之后只带 cookie"） */
  const again = await adminDevice.request("/queue/api/data")
  checkEq("带 cookie 再来（不再带 u/s）仍认出管理员", again.status, 200)
  check("认出的是链接身份那个角色（admin + 主人）", again.json?.perm?.role === "admin" && again.json?.perm?.owner === true, JSON.stringify(again.json?.perm))

  /** 认领记录本身：键 = 身份 + 用途 + 30 天签发窗口，值是设备号 + 认领时间 + 过期时间 */
  const key = claimKeyFor(ADMIN.qq, "admin")
  const entry = claimEntry(key)
  check("认领记录的键是「身份 + 用途 + 30 天签发窗口」", /^\d+:admin:ep:\d+$/.test(key), key)
  check("认领记录能按这个键查到", Boolean(entry), `键 ${key} 不在文件里：${fs.readFileSync(ws.file("abyss-editor-claims.json"), "utf8").slice(0, 200)}`)
  check(
    "认领记录存设备号 + 认领时间 + 24 小时后的过期时间",
    entry?.device === deviceCookie.split(".")[0] && Math.abs(entry.expiresAt - entry.claimedAt - CLAIM_TTL_MS) < 1000,
    JSON.stringify(entry),
  )
  check("认领文件里**没有**链接身份（只有随机设备号）", !JSON.stringify(claimEntry(key)).includes(ADMIN.qq), JSON.stringify(entry))

  /** 别人：同一条链接、没有 cookie（另一台设备 / 别人转发去点） */
  const stranger = device()
  const strangerData = await stranger.request("/queue/api/data", adminLink)
  checkEq("别人带同一条链接能看（口令有效）", strangerData.status, 200)
  check("但身份被降级成只读访客（不是链接主人）", strangerData.json?.perm?.role === "guest" && strangerData.json?.perm?.readonly === true, JSON.stringify(strangerData.json?.perm))
  const strangerWrite = await stranger.request("/queue/api/anchors", { ...adminLink, body: { sheet: "", rows: [] } })
  checkEq("别人写接口一律 403", strangerWrite.status, 403)

  /** 别人（另一个有身份的人）拿同一条链接：被挡的是**设备**，不是「这个 QQ 没权限」 */
  const otherDevice = device()
  checkEq("另一个人（别的设备）拿同一条链接也只有 403", (await otherDevice.request("/queue/api/anchors", { ...adminLink, body: { sheet: "", rows: [] } })).status, 403)

  /* ------------------------- ② 时间窗：当期 + 上一期可用，更旧的一律拒绝 ------------------------- */

  const now = Date.now()
  /** 窗口起点（再各减一个窗口就是"上一窗口"，减两个就是"旧链"） */
  const epoch = offset => Math.floor(now / WINDOW_MS) * WINDOW_MS - offset + 60 * 1000
  checkEq("当前窗口的链接照常", (await device().request("/queue/", link(ADMIN, epoch(0)))).status, 200)
  checkEq("上一窗口的链接照常（边界抖动）", (await device().request("/queue/", link(ADMIN, epoch(WINDOW_MS)))).status, 200)
  checkEq("两个窗口之前的链接 ⇒ 410", (await device().request("/queue/", link(ADMIN, epoch(2 * WINDOW_MS)))).status, 410)
  const stale = await device().request("/queue/api/data", link(ADMIN, epoch(2 * WINDOW_MS)))
  check("旧链给的是可读的失效页（不是一句 forbidden）", stale.status === 410 && stale.text.includes("链接已经失效"), `HTTP ${stale.status}`)
  const tampered = link(ADMIN)
  checkEq("被改过的时间窗签名 ⇒ 410", (await device().request("/queue/", { ...tampered, params: { ...tampered.params, ws: "AAAA" } })).status, 410)
  const stolen = link(ADMIN)
  checkEq("时间窗是给别人的身份签的 ⇒ 410", (await device().request("/queue/", { ...stolen, who: OTHER })).status, 410)
  checkEq("未来的窗口 ⇒ 410（只认当期与上一期）", (await device().request("/queue/", link(ADMIN, epoch(-WINDOW_MS)))).status, 410)

  /**
   * 没带 `w/ws` 的身份链接（老链）：上一阶段为兼容放过"首次仍可认领"，本阶段起默认关闭
   *
   * 两条一起看才说明问题：
   *   - **换一台设备**拿这条链（= 转发出去被点开）⇒ 410 + 可读页，且认领记录里不会多出它；
   *   - **认领过这条链接的那台设备**不带窗口再来 ⇒ 照旧放行（编辑器页面自己就是不带窗口发的，
   *     见 `editor.html` 的 `withToken()` 与 `http/pages.js` 的 `denialPage`）——这一条要是在，
   *     说明"关掉老链"没有顺手把正常刷新也关掉。
   */
  const legacyPerson = freshPerson()
  rosterFor(legacyPerson)
  const legacyOwner = device()
  checkEq("（前置）这台设备带窗口打开并认领", (await legacyOwner.request("/queue/", link(legacyPerson))).status, 200)
  const legacyClaimKey = claimKeyFor(legacyPerson.qq, "member")
  const legacyClaimsFile = ws.file("abyss-editor-claims.json")

  const noWindow = await legacyOwner.request("/queue/", { who: legacyPerson })
  checkEq("认领过的设备不带 w/ws 再来 ⇒ 照旧放行（页面自己发的就是这种）", noWindow.status, 200)
  const noWindowApi = await legacyOwner.request("/queue/api/data", { who: legacyPerson })
  checkEq("（同上）接口也一样放行", noWindowApi.status, 200)

  /** 认领记录：**收件人还是原来那台设备**（`expiresAt` 会随每次回来续期，所以只比设备与首次认领时间） */
  const claimedBy = () => {
    const entry = JSON.parse(fs.readFileSync(legacyClaimsFile, "utf8")).entries?.[legacyClaimKey] ?? null
    return entry ? { device: entry.device, claimedAt: entry.claimedAt } : null
  }
  const claimBefore = JSON.stringify(claimedBy())

  const stolenLegacy = await device().request("/queue/", { who: legacyPerson })
  checkEq("换一台设备拿这条无窗口老链 ⇒ 410", stolenLegacy.status, 410)
  check(
    "老链给的是可读页：回群里重新发 #排队",
    stolenLegacy.text.includes("链接已经失效") && stolenLegacy.text.includes("重新发") && stolenLegacy.text.includes("#排队"),
    stolenLegacy.text.slice(0, 300),
  )
  const stolenLegacyApi = await device().request("/queue/api/data", { who: legacyPerson })
  checkEq("老链走接口也进不来（不是只挡页面）", stolenLegacyApi.status, 410)
  const claimAfter = JSON.stringify(claimedBy())
  check(
    "老链没有被认领（认领记录还指着原来那台设备）",
    Boolean(claimBefore) && claimAfter === claimBefore,
    `${claimBefore} → ${claimAfter}`,
  )

  /* ------------------------- ③ 群友：会话 cookie，且群昵称按 QQ 从群名单补 ------------------------- */

  /** 表里真实存在的一行：拿它的群昵称当"这个群友在表里的名字" */
  const all = (await adminDevice.request("/queue/api/data")).json
  const sample = (() => {
    for (const s of all?.sheets ?? []) for (const r of s.rows ?? []) if (String(r.nickname ?? "").trim()) return { sheet: s.name, row: r.row, nick: String(r.nickname).trim() }
    return null
  })()
  if (!sample) throw new Error("表里没有一行带群昵称的数据，无法验证群友认领")

  const member = { qq: MEMBER_QQ, nick: sample.nick }
  rosterFor(member)
  const memberDevice = device()
  const memberLink = link(member)
  const memberPage = await memberDevice.request("/queue/", memberLink)
  checkEq("群友的链接也能打开", memberPage.status, 200)
  const memberSetCookie = memberPage.setCookie.find(line => line.startsWith(`${DEVICE_COOKIE}=`)) ?? ""
  check("群友认领 ⇒ 只种**会话 cookie**（没有 Max-Age / Expires）", Boolean(memberSetCookie) && !/Max-Age|Expires/.test(memberSetCookie), memberSetCookie)
  const memberData = await memberDevice.request("/queue/api/data")
  check("群友带 cookie 再来认得出是他本人（昵称按 QQ 从群名单补）", memberData.json?.perm?.role === "self" && memberData.json?.perm?.nick === sample.nick, JSON.stringify(memberData.json?.perm))
  /** 同一昵称在三个榜里可能各有一行：认人按群名片兜底，命中几行就该给几行 */
  const expectedRows = (all?.sheets ?? []).flatMap(s =>
    (s.rows ?? []).filter(r => String(r.nickname ?? "").trim() === sample.nick).map(r => ({ sheet: s.name, row: r.row })),
  )
  const memberRows = (memberData.json?.sheets ?? []).flatMap(s => (s.rows ?? []).map(r => ({ sheet: s.name, row: r.row })))
  const rowKey = list => JSON.stringify([...list].sort((a, b) => `${a.sheet}${a.row}`.localeCompare(`${b.sheet}${b.row}`)))
  check("本人只拿到自己那些行", memberRows.length > 0 && rowKey(memberRows) === rowKey(expectedRows), `拿到 ${JSON.stringify(memberRows)}，应当 ${JSON.stringify(expectedRows)}`)
  checkEq("群友用别人的设备 cookie 也只会被降级（不认成链接主人）", (await device().request("/queue/api/data", memberLink)).json?.perm?.role, "guest")

  /* ------------------------- ④ 短链：编辑器自己签当期窗口，展开出来的链接当前可用 ------------------------- */

  const shortPerson = freshPerson()
  rosterFor(shortPerson)
  const shortRes = await device().request(`/queue/${SHORT_PATH}/${signTicket({ qq: shortPerson.qq }, SIGN_KEY)}`, { sendCookies: false })
  check("短链仍 302 到长地址", shortRes.status === 302, `HTTP ${shortRes.status}`)
  const target = new URL(shortRes.location ?? "/", editor.base)
  check("展开出来的地址带上了时间窗（w/ws）", target.searchParams.has("w") && target.searchParams.has("ws"), target.search)
  const followed = await device().request(`${target.pathname}${target.search}`, { sendCookies: false })
  checkEq("顺着短链展开的地址能打开（当期窗口）", followed.status, 200)
  checkEq(
    "把展开地址的窗口改旧 ⇒ 410",
    (await device().request(`${target.pathname}${target.search.replace(/w=\d+/, "w=1")}`, { sendCookies: false })).status,
    410,
  )

  /* ------------------------- ⑤ 认领文件损坏 / 条目过期 ⇒ 不崩、当未认领 ------------------------- */

  const CLAIMS = ws.file("abyss-editor-claims.json")
  const goodFile = fs.readFileSync(CLAIMS, "utf8")

  const brokenPerson = freshPerson()
  rosterFor(brokenPerson)
  fs.writeFileSync(CLAIMS, "{ 这不是 JSON", "utf8")
  const brokenDevice = device()
  const brokenPage = await brokenDevice.request("/queue/", link(brokenPerson))
  check("认领文件损坏：服务照旧（不崩）", brokenPage.status === 200, `HTTP ${brokenPage.status}`)
  check(
    "认领文件损坏：按未认领处理（第一台设备重新认领，仍是链接身份那个角色）",
    Boolean(brokenDevice.cookieOf(DEVICE_COOKIE)) && (await brokenDevice.request("/queue/api/data")).json?.perm?.role === "self",
    JSON.stringify((await brokenDevice.request("/queue/api/data")).json?.perm),
  )
  fs.writeFileSync(CLAIMS, goodFile, "utf8")

  /** 条目过期（往文件里写一条**已过期**的记录造 24 小时到期，不用等真时间） */
  const expiryPerson = freshPerson()
  rosterFor(expiryPerson)
  await device().request("/queue/", link(expiryPerson))
  const expiredKey = claimKeyFor(expiryPerson.qq, "member")
  const asExpired = JSON.parse(fs.readFileSync(CLAIMS, "utf8"))
  asExpired.entries[expiredKey] = { device: "0".repeat(32), claimedAt: Date.now() - CLAIM_TTL_MS - 1000, expiresAt: Date.now() - 1000 }
  fs.writeFileSync(CLAIMS, JSON.stringify(asExpired), "utf8")
  const afterExpiry = device()
  const expiryPage = await afterExpiry.request("/queue/", link(expiryPerson))
  const newEntry = (() => {
    try {
      return JSON.parse(fs.readFileSync(CLAIMS, "utf8")).entries?.[expiredKey] ?? null
    } catch {
      return null
    }
  })()
  check("过期条目按未认领处理：新设备重新认领（不再指向旧设备号）", expiryPage.status === 200 && Boolean(newEntry?.device) && newEntry.device !== "0".repeat(32), JSON.stringify(newEntry))
  check("重新认领后过期时间已经推到 24 小时之后", Boolean(newEntry) && newEntry.expiresAt - newEntry.claimedAt === CLAIM_TTL_MS, JSON.stringify(newEntry))

  /* ------------------------- ⑥ 反例：认领记录指向别的设备 ⇒ 降级（这条能失败） ------------------------- */

  const alonePerson = freshPerson()
  rosterFor(alonePerson)
  const aloneDevice = device()
  const aloneLink = link(alonePerson)
  await aloneDevice.request("/queue/", aloneLink)
  const aloneKey = claimKeyFor(alonePerson.qq, "member")
  const aloneEntry = JSON.parse(fs.readFileSync(CLAIMS, "utf8")).entries[aloneKey]
  check("认领者就是这台设备", aloneEntry.device === aloneDevice.cookieOf(DEVICE_COOKIE).split(".")[0], JSON.stringify(aloneEntry))
  /** 把认领记录的设备号换成别人（模拟"链接被别人先认领了"）：同一台设备随即失去写权限 */
  const others = JSON.parse(fs.readFileSync(CLAIMS, "utf8"))
  others.entries[aloneKey] = { ...aloneEntry, device: "f".repeat(32) }
  fs.writeFileSync(CLAIMS, JSON.stringify(others), "utf8")
  const afterSteal = await aloneDevice.request("/queue/api/data", aloneLink)
  check("认领记录指向别的设备 ⇒ 立刻降级只读", afterSteal.json?.perm?.role === "guest", JSON.stringify(afterSteal.json?.perm))
  checkEq("（同上）写接口 403", (await aloneDevice.request("/queue/api/save", { ...aloneLink, body: { sheet: "", rows: [] } })).status, 403)

  /* ------------------------- ⑦ x-forwarded-proto: https ⇒ cookie 带 Secure ------------------------- */

  const httpsPerson = freshPerson()
  rosterFor(httpsPerson)
  const httpsDevice = device()
  const httpsLink = { ...link(httpsPerson), headers: { "x-forwarded-proto": "https" } }
  const httpsPage = await httpsDevice.request("/queue/", httpsLink)
  const secureCookie = httpsDevice.cookieOf(DEVICE_COOKIE)
  check("请求是 https（反代）时才带 Secure", /Secure/.test(httpsPage.setCookie.find(l => l.startsWith(`${DEVICE_COOKIE}=`)) ?? ""), httpsPage.setCookie.join(" | "))
  check("组出来的 cookie 值本身与 http 一致（Secure 只是属性）", /^[0-9a-f]{32}\.[A-Za-z0-9_-]+$/.test(secureCookie), secureCookie)
  /* ------------- ⑨ 无 cookie 的设备：靠页面里注入的设备令牌（请求头） ------------- */

  /**
   * 现场（维护者报的）：手机 / QQ 内置浏览器点主人链接，页面能打开、数据全读不到，
   * 报 `Unexpected token '<', "<!doctype "…`——页面自己发的 `/api/*` 不带时间窗，
   * 只认 cookie 那一份设备凭据；内置浏览器把 cookie 挡掉之后，那一发就撞上 410 的失效页（HTML）。
   *
   * 这一组用"服务端注入页面的设备令牌 + `x-abyss-device` 请求头"把这条路补上：
   * 令牌与 cookie 同构、同样绑"哪条链接 + 哪个身份"，所以换个身份 / 换条链接都验不过。
   */
  {
    const phonePerson = freshPerson()
    rosterFor(phonePerson)
    const phone = device()
    const phoneLink = link(phonePerson)

    const phonePage = await phone.request("/queue/", { ...phoneLink, sendCookies: false })
    const injected = String(phonePage.headers?.get?.("x-abyss-device") ?? "")
    check(
      "无 cookie 的设备打开链接：响应头里给出设备令牌",
      phonePage.status === 200 && /^[0-9a-f]{32}\.[A-Za-z0-9_-]+$/.test(injected),
      `HTTP ${phonePage.status}，令牌=${JSON.stringify(injected)}`,
    )
    check("同一个令牌也注进了页面（页面自己存下来用）", phonePage.text.includes(injected), "页面里没有这段令牌")

    /**
     * 页面自己发的就是"带 `u/s`、不带窗口"那种请求（`withToken()` 会把身份拼回去），
     * 所以这几条都按这个形状发：**带身份、不带 cookie**。
     */
    const bare = await phone.request("/queue/api/data", { who: phonePerson, sendCookies: false })
    check(
      "有身份、没 cookie、没令牌：接口给的是失效页 HTML（现场那个报错的来源就是这个）",
      bare.status === 410 && /<!doctype/i.test(bare.text),
      `HTTP ${bare.status}，body=${JSON.stringify(bare.text.slice(0, 60))}`,
    )

    const withToken = await phone.request("/queue/api/data", {
      who: phonePerson,
      sendCookies: false,
      headers: { "x-abyss-device": injected },
    })
    checkEq("带上页面里的令牌：照旧认得链接身份（cookie 被挡也能用）", withToken.status, 200)
    check("认出的是链接身份那个角色", withToken.json?.perm?.role === "self", JSON.stringify(withToken.json?.perm))

    /** 换一条链接、拿同一个令牌去用：签名里绑了"哪条链接 + 哪个身份"，必须验不过 */
    const otherPhone = device()
    const otherPage = await otherPhone.request("/queue/", { ...link(freshPerson()), sendCookies: false })
    const otherToken = String(otherPage.headers?.get?.("x-abyss-device") ?? "")
    const crossed = await phone.request("/queue/api/data", {
      who: phonePerson,
      sendCookies: false,
      headers: { "x-abyss-device": otherToken },
    })
    check("别的链接的令牌用在这条链接上：不认（410）", crossed.status === 410, `HTTP ${crossed.status}`)
    const forged = await phone.request("/queue/api/data", {
      who: phonePerson,
      sendCookies: false,
      headers: { "x-abyss-device": `${injected.split(".")[0]}.AAAA` },
    })
    check("令牌签名被改过：不认（410）", forged.status === 410, `HTTP ${forged.status}`)
  }
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err?.message ?? err}\n${String(editor.log?.() ?? "").slice(-600)}`)
} finally {
  await editor.stop()
  await wait(200)
  ws.cleanup()
}

console.log(failed ? `\n❌ 链接认领验证失败 ${failed} 项` : "\n✅ 链接认领验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：子进程已 kill、临时目录已清，让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
