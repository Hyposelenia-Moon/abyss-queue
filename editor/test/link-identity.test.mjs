/**
 * 链接身份：**身份只来自链接签名里的 QQ，权限只问这个 QQ 在不在群成员名单里**
 *
 * 机器人给谁发的链接，链接里签的就是谁（`u/s`，30 天）。编辑器拿这个 QQ 去问群成员名单
 * （`editor/roster.js` 的 `isMember`）决定能写多少：
 *   - `true`（名单可信 + 他在名单里）⇒ 可写，整张排队区都按额度与红线放行；
 *   - `false`（名单可信 + 他不在名单里）⇒ 只读，写接口直接拒；
 *   - `null`（名单还没收到 / 过期 / 空）⇒ **不放权也不拒人**：退回"只能改自己那一行"。
 *
 * 没有设备认领、没有 `#v=` 新旧标记、没有认领文件——这些在 2026-11-25 的重写里整块删掉了，
 * 这套钉的就是"删干净了、并且新口径真的按名单判"。
 *
 * 另有两条与身份无关但必须一起钉的：
 *   - **时间窗**（`w/ws`）：只认当期与上一期，旧链 410；
 *   - **管理员 24 小时会话 cookie**：窗口刚验过那一刻种下，之后不带 `u/s` 也能进门（只对管理员）。
 *
 * 用法：node editor/test/link-identity.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（缺真实表时也有样本可跑） */
import { SOURCE as SRC } from "./source.mjs"
import { wait, makeWorkspace, signIdentity, signWindow, startEditor, WINDOW_MS } from "./harness.mjs"

const TOKEN = "link-identity-token"
const SIGN_KEY = "link-identity-sign-key"
/** 主人（也是白名单管理员）：它拿到的链接就是"管理链接" */
const ADMIN = { qq: "1000000001", nick: "缄月" }
/** 白名单管理员（不是主人）：验证"管理员及以上"都按管理员口径种 24 小时 cookie */
const ADMIN2 = { qq: "1000000002", nick: "听雨" }
/** 普通群友（不在白名单里） */
const MEMBER_QQ = "1000000003"
/** 与这条链接无关的另一个人 */
const OTHER = { qq: "1000000004", nick: "路过的" }

const ws = makeWorkspace("link-identity", { source: SRC })
fs.writeFileSync(ws.file("admins.json"), JSON.stringify({ owner: [ADMIN.qq], admins: [ADMIN.qq, ADMIN2.qq] }), "utf8")
const ROSTER = ws.file("roster.json")
/** 名单：链接里只带 QQ，群昵称由编辑器从这份名单补 */
const rosterFor = (...people) =>
  fs.writeFileSync(ROSTER, JSON.stringify({ group: "100000002", updatedAt: Date.now(), members: people.map(p => ({ qq: p.qq, nick: p.nick })) }), "utf8")
rosterFor()

let seq = 0
/** 一个还没出现在名单里的人（避免各段互相干扰） */
const freshPerson = () => {
  seq++
  return { qq: String(7000000000 + seq), nick: `群友${seq}` }
}

let failed = 0
/**
 * 断言：`ok` 收**布尔**或**回调 / async 回调**（抛错或返回 `false` 都算失败）
 *
 * 回调那种写法必须真的执行（AGENTS.md §3.7：写成 `if (ok)` 的话回调永远是"真值"，
 * 断言一条都没跑还印 ✅）。
 */
const check = (name, ok, detail = "") => {
  const pass = () => console.log(`  ✅ ${name}`)
  const fail = why => {
    failed++
    console.log(`  ❌ ${name}${detail || why ? `\n     ${detail || why}` : ""}`)
  }
  if (typeof ok !== "function") return ok ? pass() : fail("")
  let out
  try {
    out = ok()
  } catch (err) {
    return fail(err?.message ?? String(err))
  }
  if (out && typeof out.then === "function") {
    return out.then(
      value => (value === false ? fail("回调返回 false") : pass()),
      err => fail(err?.message ?? String(err)),
    )
  }
  if (out === false) return fail("回调返回 false")
  return pass()
}
const checkEq = (name, got, want) => check(name, got === want, `实际 ${JSON.stringify(got)}，应当 ${JSON.stringify(want)}`)

/**
 * 管理员会话 cookie 只有 `QQ.过期.MAC` 三段式一种写法。
 *
 * 2026-11-26 把「兼容旧版 `过期.MAC`」那条分支删了：旧格式没有 QQ，只能在"已知 QQ"时校验，
 * 等于把签名从"这个浏览器登录过谁"退化成"谁带着谁都行"。当前版本只发三段式，
 * 24 小时内没进过门的旧 cookie 本来就该回链接重新验一次窗口。
 */
{
  const { createSession } = await import("../http/session.js")
  const session = createSession({ signKey: SIGN_KEY })
  const token = session.adminSessionToken(ADMIN.qq)
  const [qq, exp, mac] = token.split(".")
  const withCookie = value => ({ headers: { cookie: `${"abyss_admin_ok"}=${value}` } })
  check("管理员会话：三段式 cookie 照旧放行", session.adminSessionOk(withCookie(token), ADMIN.qq) === true)
  check(
    "管理员会话：旧版两段式 cookie（没有 QQ）不再放行",
    session.adminSessionOk(withCookie(`${exp}.${mac}`), ADMIN.qq) === false,
    `qq=${qq} token=${token}`,
  )
}

const editor = await startEditor({
  label: "link-identity",
  token: TOKEN,
  signKey: SIGN_KEY,
  adminsFile: ws.file("admins.json"),
  args: ["--file", ws.fixture],
  env: { ABYSS_QUEUE_CONFIG: ws.cfg, ABYSS_EDITOR_ROSTER_FILE: ROSTER, ABYSS_EDITOR_TEST_PATHS: "1" },
})

/** 一台"设备"：自带一个 cookie 罐（同一个端口、同一张表） */
const device = () => {
  const jar = new Map()
  return {
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
        const id = signIdentity(opts.who, SIGN_KEY, Number(opts.at) || Date.now())
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
}

/**
 * 一条"带时间窗的身份链接"的请求参数
 *
 * `now` 用来造**旧链**：签一个更早窗口的 `w/ws`，编辑器应当拒收。
 */
const link = (who, now = Date.now()) => {
  const win = signWindow(who, SIGN_KEY, now)
  return { params: { w: win.w, ws: win.ws }, who, at: now }
}

try {
  /* --------------------- ① 身份只来自链接：访客 / 在名单 / 不在名单 --------------------- */

  const guest = await device().request("/api/data")
  check("没有身份链接 ⇒ 访客 + 只读", guest.json?.perm?.role === "guest" && guest.json?.perm?.readonly === true, JSON.stringify(guest.json?.perm))

  {
    const person = freshPerson()
    rosterFor(person)
    const own = await device().request("/api/data", link(person))
    check("链接里的 QQ 在名单里 ⇒ 本人 + 可写", own.json?.perm?.role === "self" && own.json?.perm?.readonly === false, JSON.stringify(own.json?.perm))
    check("（同上）拿到「能改整表」那一位标记", own.json?.perm?.roam === true, JSON.stringify(own.json?.perm))
    check("（同上）不在群外", own.json?.perm?.outOfGroup === false, JSON.stringify(own.json?.perm))
  }

  {
    const person = freshPerson()
    rosterFor(OTHER)
    const outside = await device().request("/api/data", link(person))
    check("链接里的 QQ 不在名单里 ⇒ 只读", outside.json?.perm?.role === "self" && outside.json?.perm?.readonly === true, JSON.stringify(outside.json?.perm))
    check("（同上）标出「不在本群」", outside.json?.perm?.outOfGroup === true, JSON.stringify(outside.json?.perm))
    const sheet = outside.json?.sheets?.[0]
    const save = await device().request("/api/save", {
      ...link(person),
      method: "POST",
      body: { sheet: sheet?.name ?? "", rows: [{ row: sheet?.rows?.[0]?.row ?? 1, values: { ...(sheet?.rows?.[0] ?? {}), note: "群外的人写的" } }] },
    })
    check("群外的人写表被拒，并说清「不在本群成员名单」", save.status === 400 && String(save.json?.error ?? "").includes("不在本群成员名单"), JSON.stringify(save.json))
  }

  /* --------------------- ①b 左下角头像与群昵称候选 --------------------- */

  {
    /**
     * 头像代理：`<img src>` 带不了 `x-abyss-*` 请求头（口令在 localStorage），
     * 所以这条排在 `authorized()` 之前、裸请求也到得了；但只认 5–12 位纯数字 QQ。
     */
    const bad = await fetch(`${editor.base}/api/avatar?qq=abc`)
    check("头像代理：公开可达，非数字 QQ 直接 400", bad.status === 400, `实际 ${bad.status}`)
    const short = await fetch(`${editor.base}/api/avatar?qq=123`)
    check("头像代理：少于 5 位不当 QQ（避免拿它探别的接口）", short.status === 400, `实际 ${short.status}`)
    const none = await fetch(`${editor.base}/api/avatar`)
    check("头像代理：不带 qq 也是 400", none.status === 400, `实际 ${none.status}`)
  }

  {
    const person = freshPerson()
    rosterFor(person, OTHER)
    const own = await device().request("/api/data", link(person))
    const candidates = own.json?.roster?.candidates ?? []
    check("群昵称候选：本群成员拿得到整群名片", candidates.includes(person.nick), JSON.stringify(candidates))
    check("（同上）不止自己一个", candidates.includes(OTHER.nick), JSON.stringify(candidates))
    check(
      "左下角头像：链接身份给了同源代理地址",
      String(own.json?.perm?.avatar ?? "") === `api/avatar?qq=${person.qq}`,
      JSON.stringify(own.json?.perm?.avatar),
    )
    /** 名单里没有他（`member === false`）：拿着别群链接进来的人拿不到整群名片 */
    const stranger = freshPerson()
    const outside = await device().request("/api/data", link(stranger))
    check("群昵称候选：不在本群名单里的人拿不到（整群名片不外发）", (outside.json?.roster?.candidates ?? []).length === 0, JSON.stringify(outside.json?.roster))
    const guestData = await device().request("/api/data")
    check("左下角头像：没有链接身份就没有头像地址", String(guestData.json?.perm?.avatar ?? "") === "", JSON.stringify(guestData.json?.perm?.avatar))
  }

  {
    const person = freshPerson()
    /** 名单不可信：还没收到过（空名单）⇒ `isMember` 返回 null */
    rosterFor()
    const unknown = await device().request("/api/data", link(person))
    check(
      "名单不可信 ⇒ 不放权也不拒人（本人、可读、但没有整表权限）",
      unknown.json?.perm?.role === "self" && unknown.json?.perm?.readonly === false && unknown.json?.perm?.roam === false,
      JSON.stringify(unknown.json?.perm),
    )
    /** 找一行**别人**的数据行：用主人视角拿整张表（名单不可信时他自己只拿得到的行，不够用） */
    const full = await device().request("/api/data", link(ADMIN))
    const target = (full.json?.sheets ?? []).map(s => ({ s, r: (s.rows ?? []).find(r => String(r.nickname ?? "").trim() !== person.nick) })).find(x => x.r)
    const save = await device().request("/api/save", {
      ...link(person),
      method: "POST",
      body: { sheet: target?.s?.name ?? "", rows: [{ row: target?.r?.row ?? 0, values: { ...(target?.r ?? {}), note: "想改别人的行" } }] },
    })
    check("名单不可信时改别人的行被拒（退回「只能改自己那一行」）", save.status === 400 && String(save.json?.error ?? "").includes("不是你的记录"), JSON.stringify(save.json))
  }

  /* --------------------- ② 时间窗：当期 + 上一期可用，更旧的一律拒绝 --------------------- */

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

  /* ------------- ③ 没带 w/ws 的身份链接（群内短码兑换出来的就是这一档）照旧放行 ------------- */

  {
    const person = freshPerson()
    rosterFor(person)
    const noWindow = { who: person }
    checkEq("没带 w/ws 的身份链接 ⇒ 照旧放行（短码兑换那一档）", (await device().request("/queue/", noWindow)).status, 200)
    const api = await device().request("/api/data", noWindow)
    check(
      "（同上）权限照旧按名单判（在名单里 ⇒ 可写）",
      api.status === 200 && api.json?.perm?.role === "self" && api.json?.perm?.readonly === false,
      `HTTP ${api.status} ${JSON.stringify(api.json?.perm)}`,
    )
    rosterFor(OTHER)
    const outsideAgain = await device().request("/api/data", noWindow)
    check(
      "（同上）名单里没有他 ⇒ 照旧只读（与有没有时间窗无关）",
      outsideAgain.json?.perm?.readonly === true,
      JSON.stringify(outsideAgain.json?.perm),
    )
  }

  /* --------------------- ④ 管理员：窗口验过种 24 小时 cookie，之后不带 u/s 也能进门 --------------------- */

  {
    const adminDevice = device()
    /** 名单里得有主人，`/api/data` 才会用名单里的现用名补 `perm.nick`（cookie 那一档身份里没有昵称） */
    rosterFor(ADMIN, ADMIN2)
    const adminLink = link(ADMIN)
    const page = await adminDevice.request("/queue/", adminLink)
    checkEq("带时间窗的管理员链接能打开页面", page.status, 200)
    const adminSetCookie = page.setCookie.find(line => line.startsWith("abyss_admin_ok=")) ?? ""
    check("管理员 cookie 是 24 小时（Max-Age=86400）", /Max-Age=86400(;|$)/.test(adminSetCookie), adminSetCookie)
    check(
      "cookie 是 HttpOnly + SameSite=Lax、本机 http 下不写死 Secure",
      /HttpOnly/.test(adminSetCookie) && /SameSite=Lax/.test(adminSetCookie) && !/Secure/.test(adminSetCookie),
      adminSetCookie,
    )
    /** 同设备再来一次：不带 `u/s`（模拟"页面把地址栏清干净、之后只带 cookie"） */
    const again = await adminDevice.request("/api/data")
    checkEq("带 cookie 再来（不再带 u/s）仍进门", again.status, 200)
    check(
      "认出的是管理员 + 主人，群昵称照旧从名单补",
      again.json?.perm?.role === "admin" && again.json?.perm?.owner === true && again.json?.perm?.nick === ADMIN.nick,
      JSON.stringify(again.json?.perm),
    )

    const admin2Device = device()
    await admin2Device.request("/queue/", link(ADMIN2))
    const admin2 = await admin2Device.request("/api/data")
    check("白名单管理员（不是主人）也种 24 小时 cookie", admin2.json?.perm?.role === "admin" && admin2.json?.perm?.owner === false, JSON.stringify(admin2.json?.perm))
    check("（同上）管理口令不共享 ⇒ 拿不到主人那一档", admin2.json?.perm?.manage === false, JSON.stringify(admin2.json?.perm))

    /** 反代成 https 时才带 Secure */
    const httpsDevice = device()
    const httpsPage = await httpsDevice.request("/queue/", { ...link(ADMIN2), headers: { "x-forwarded-proto": "https" } })
    check("请求是 https（反代）时才带 Secure", /Secure/.test(httpsPage.setCookie.find(l => l.startsWith("abyss_admin_ok=")) ?? ""), httpsPage.setCookie.join(" | "))

    /** 群友不带链接、只有 cookie ⇒ 不认（共用浏览器不留身份） */
    const memberDevice = device()
    rosterFor({ qq: MEMBER_QQ, nick: "群友甲" })
    await memberDevice.request("/queue/", link({ qq: MEMBER_QQ, nick: "群友甲" }))
    const bare = await memberDevice.request("/api/data")
    check("群友只带 cookie 不再认回本人（共用浏览器不留身份）", bare.json?.perm?.role === "guest" && bare.json?.perm?.readonly === true, JSON.stringify(bare.json?.perm))
  }

  /* --------------------- ⑤ 认领那一层真的删干净了（文件、请求头、perm 字段） --------------------- */

  check("不再生成认领文件（`abyss-editor-claims.json` 不存在）", !fs.existsSync(ws.file("abyss-editor-claims.json")), ws.dir)
  {
    const page = await device().request("/queue/", link(ADMIN))
    check("响应头里不再有设备令牌 `x-abyss-device`", !String(page.headers.get("x-abyss-device") ?? "").trim(), String(page.headers.get("x-abyss-device") ?? ""))
    check("页面里不再注入 `__DEVICE__`（模板占位已经删掉）", !page.text.includes("__DEVICE__"), "页面里还留着 __DEVICE__")
  }
  {
    const person = freshPerson()
    rosterFor(person)
    const data = await device().request("/api/data", link(person))
    check("`perm` 里不再有 `staleLink`（链接新旧这一层删掉了）", !("staleLink" in (data.json?.perm ?? {})), JSON.stringify(data.json?.perm))
  }

  /* --------------------- ⑥ 落盘是**原子替换**（与认领无关，但要一直在） --------------------- */

  await check("写盘是原子替换：写到一半崩了也不破坏原来那份、不留 .tmp", async () => {
    const { writeJson } = await import("../util.js")
    const file = ws.file("atomic-probe.json")
    writeJson(file, { entries: { keep: "原来的内容" } })
    const before = fs.readFileSync(file, "utf8")

    const real = fs.writeFileSync
    fs.writeFileSync = (p, data, enc) => {
      real(p, String(data).slice(0, 8), enc)
      throw new Error("模拟：写到一半崩了")
    }
    try {
      /** 补丁必须真的生效，否则这条断言是空转 */
      if (fs.writeFileSync === real) throw new Error("没法替换 fs.writeFileSync，这条用例失去意义")
      let threw = false
      try {
        writeJson(file, { entries: { keep: "写完这一份就崩" } })
      } catch {
        threw = true
      }
      if (!threw) throw new Error("写到一半的失败没有抛给调用方")
    } finally {
      fs.writeFileSync = real
    }

    if (fs.readFileSync(file, "utf8") !== before) throw new Error(`目标文件被写坏了：${fs.readFileSync(file, "utf8")}`)
    const leftovers = fs.readdirSync(ws.dir).filter(f => f.endsWith(".tmp"))
    if (leftovers.length) throw new Error(`留下了中间产物：${leftovers.join("、")}`)
  })
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err?.message ?? err}\n${String(editor.log?.() ?? "").slice(-600)}`)
} finally {
  await editor.stop()
  await wait(200)
  ws.cleanup()
}

console.log(failed ? `\n❌ 链接身份验证失败 ${failed} 项` : "\n✅ 链接身份验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：子进程已 kill、临时目录已清，让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
