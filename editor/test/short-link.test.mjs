/**
 * 短链：`<url>/s/<码>` → 换成带身份的长地址再跳过去
 *
 * 群里发的是短链（机器人 `signTicket` 签、编辑器 `verifyTicket` 验，两边共用 model/identity.js），
 * 所以这条链路两头都要盯住：
 *   - 码验得过 → 302 到带 `k/u/s` 的地址，且 **Location 只能是相对路径**
 *     （换域名、上 https、挂到 `/queue` 这种子路径都跟着走，代码里不写死主机名）
 *   - 子路径两种转发方式都要能用：nginx 原样带前缀（`/queue/s/<码>`）与剥掉前缀（`/s/<码>`）
 *   - 码验不过（过期 / 被改过 / 用口令签的）→ 410 提示页，不能放进去
 *   - 展开出来的身份要真的认得出人：**群名片不在码里**，由编辑器按 QQ 从群名单里补
 *
 * 用法：node editor/test/short-link.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { shared } from "./plugin.mjs"
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（缺真实表时也有样本可跑） */
import { SOURCE as SRC } from "./source.mjs"
/** 端口一律现要：套件之间不抢固定端口（见 test/_helper.mjs） */
import { freePort } from "../../test/_helper.mjs"

const { signIdentity, signWindow, signTicket, verifyTicket, decodeIdentity, signFreshness, decodeLinkNick, encodeLinkNick, SHORT_PATH, TICKET_WINDOW_MS } = await shared("model/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-shortlink-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
/** 数据落点派生自表格所在目录（测试模式），配置里没有路径键 */
fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")

const PORT = await freePort()
const TOKEN = "short-token-aaa"
const SIGN_KEY = "short-sign-key-bbb"
const OWNER = { qq: "1000000001", nick: "缄月" }
const MEMBER_QQ = "30001"
const admins = path.join(tmp, "admins.json")
const rosterFile = path.join(tmp, "roster.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

const child = spawn(
  process.execPath,
  [
    path.resolve(import.meta.dirname, "..", "editor.mjs"),
    "--port", String(PORT),
    "--token", TOKEN,
    "--sign-key", SIGN_KEY,
    "--file", fixture,
    "--admins", admins,
    /** 默认就是 /queue，写出来是为了把"子路径部署"这件事摆在明面上 */
    "--mount", "/queue",
  ],
  {
    env: {
      ...process.env,
      ABYSS_QUEUE_CONFIG: cfg,
      ABYSS_EDITOR_ROSTER_FILE: rosterFile,
      /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
      ABYSS_EDITOR_TEST_PATHS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
let out = ""
child.stdout.on("data", d => (out += d))
child.stderr.on("data", d => (out += d))

const wait = ms => new Promise(r => setTimeout(r, ms))
const base = `http://127.0.0.1:${PORT}`
/** 带身份取数据（管理员视角，用来挑一个真实成员）——带身份就必须带时间窗（见 editor.mjs） */
const asWho = who => {
  const id = signIdentity(who, SIGN_KEY)
  const win = signWindow(who, SIGN_KEY)
  return (
    `k=${TOKEN}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}` +
    (win ? `&w=${win.w}&ws=${encodeURIComponent(win.ws)}` : "")
  )
}
/**
 * 一个"浏览器"的 cookie 罐
 *
 * 认领那一层（`editor/claims.js`）靠 cookie 认设备：顺着短链跳过去的是**同一个浏览器**，
 * 所以后续取数要把它认领时拿到的 cookie 带上，否则会被当成"第二个来的人"降级成只读访客。
 * 挑真实成员的那次取数用的是**另一个身份**（管理员），它的设备 cookie 与短链那个身份的签名域
 * 对不上——所以两段各用各的罐，别混。
 */
const cookieJar = () => {
  const box = { value: "" }
  return {
    get: () => box.value,
    get headers() {
      return box.value ? { cookie: box.value } : {}
    },
    take(res) {
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const pair = String(line).split(";")[0].trim()
        if (pair.startsWith("abyss_editor_device=")) box.value = pair
      }
    },
  }
}
const get = async (p, { redirect = "manual", jar = null } = {}) => {
  const res = await fetch(`${base}${p}`, { redirect, headers: jar?.headers ?? {} })
  jar?.take(res)
  return { status: res.status, location: res.headers.get("location"), text: await res.text() }
}

let failed = 0
/**
 * 断言：`ok` 收两种写法——**布尔**（直接判真假）或**回调 / async 回调**（抛错即失败）
 *
 * 为什么必须两种都收（2026-10 自查抓到的坑）：这个文件里两种写法都有，而原来的实现写成
 * `if (ok)`——**回调永远是"真值"**，于是所有"传回调"的用例都只印 ✅、**一条断言都没跑**。
 * 同一形状的 check 在 `editor/test/` 有 8 个套件、`AGENTS.md` §五记了这条纪律。
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
  /** 异步用例：回一个 Promise，调用点写 `await check(...)` 的会等它跑完（不抢时序） */
  if (out && typeof out.then === "function") return out.then(pass, err => fail(err?.message ?? String(err)))
  return pass()
}

try {
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    await wait(500)
    try {
      ready = (await fetch(`${base}/healthz?k=${TOKEN}`)).status === 200
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  /** 挑一个表里真实存在的人（短链展开后要能按群名片定位到他的行） */
  const all = JSON.parse((await get(`/api/data?${asWho(OWNER)}`)).text)
  const sample = (() => {
    for (const s of all.sheets ?? []) for (const r of s.rows ?? []) if (String(r.nickname ?? "").trim()) return { sheet: s.name, row: r.row, nick: String(r.nickname).trim() }
    return null
  })()
  if (!sample) throw new Error("表里没有一行带群昵称的数据，无法验证身份定位")

  const code = signTicket({ qq: MEMBER_QQ }, SIGN_KEY)
  check("码是不透明的 16 字符单段短码（不含口令、群名片，也看不出 QQ）", /^[A-Za-z0-9_-]{16}$/.test(code), code)
  check("码里能验出是谁（与编辑器同一套）", verifyTicket(code, SIGN_KEY)?.qq === MEMBER_QQ, code)
  check("码里看不出 QQ（十进制与 base36 都不出现）", !code.includes(MEMBER_QQ) && !code.includes((Number(MEMBER_QQ)).toString(36)), code)

  /**
   * **群名单里没有这个 QQ 时**（文件都还没推过来）：身份里的群昵称用短链带来的那份兜底
   *
   * 现场：主人第一次点自己的链接，云端群名单里没有他 ⇒ 签出来的身份 `n` 是空串 ⇒ 页面认不出
   * "自己那一行"，只说"这个链接里没有你的群昵称"。所以机器人发链接时把**当时的群名片**也签进
   * 短链（`?n=`，见 `model/identity.js` 的 `signFreshness`），这里钉两条：
   *   - 名单里查不到 ⇒ 用链接里那份；
   *   - 名单里有 ⇒ **以名单为准**（那是最新的名字），链接里那份只做兜底。
   */
  const linkNick = "链接里带的昵称"
  const freshNick = signFreshness(code, SIGN_KEY, Date.now(), linkNick)
  const nickQ = `?t=${freshNick.t}&ts=${encodeURIComponent(freshNick.ts)}&n=${freshNick.n}`
  const byLink = await get(`/queue/${SHORT_PATH}/${code}${nickQ}`)
  check("群名单里没有这个 QQ：身份的群昵称用短链带来的那份兜底", () => {
    const id = decodeIdentity(new URL(byLink.location, base).searchParams.get("u"))
    return byLink.status === 302 && id?.nick === decodeLinkNick(freshNick.n) && id.nick === linkNick
  }, `${byLink.status} ${byLink.location}`)

  const badNick = await get(`/queue/${SHORT_PATH}/${code}?t=${freshNick.t}&ts=${encodeURIComponent(freshNick.ts)}&n=${encodeLinkNick("别的人")}`)
  check("签过的群昵称被换掉：整段新鲜度作废（昵称不采信，也退回短码自己的窗口时间）", () => {
    const id = decodeIdentity(new URL(badNick.location, base).searchParams.get("u"))
    return badNick.status === 302 && !id?.nick && id?.issuedAt === verifyTicket(code, SIGN_KEY)?.issuedAt
  }, `${badNick.status} ${badNick.location}`)

  /** 机器人每天推的群名单：短链里没有群名片，编辑器按 QQ 从这份名单里补 */
  fs.writeFileSync(rosterFile, JSON.stringify({ group: "100000002", updatedAt: Date.now(), members: [{ qq: MEMBER_QQ, nick: sample.nick }] }), "utf8")

  const rosterWins = await get(`/queue/${SHORT_PATH}/${code}?t=${freshNick.t}&ts=${encodeURIComponent(freshNick.ts)}&n=${encodeLinkNick("过期的旧昵称")}`)
  check("群名单里有这个人：以名单里的现名为准（链接里那份只做兜底）", () => {
    const id = decodeIdentity(new URL(rosterWins.location, base).searchParams.get("u"))
    return rosterWins.status === 302 && id?.nick === sample.nick
  }, `${rosterWins.status} ${rosterWins.location}`)

  /** 顺着短链走的是一个"浏览器"：它认领之后要把 cookie 带上（见上面 `cookieJar` 的说明） */
  const device = cookieJar()
  const passed = await get(`/queue/${SHORT_PATH}/${code}`, { jar: device })
  check("原样带前缀访问（nginx 不剥前缀）→ 302", passed.status === 302, `HTTP ${passed.status}`)
  check(
    "跳转地址是相对路径、带口令 / 身份 / 时间窗参数（换域名、上 https 都跟着走）",
    /^\/queue\/\?k=[^&]+&u=[^&]+&s=[^&]+&w=\d+&ws=[A-Za-z0-9_-]+$/.test(passed.location ?? ""),
    passed.location ?? "",
  )

  const stripped = await get(`/${SHORT_PATH}/${code}`, { jar: device })
  check("剥掉前缀访问（nginx 带尾斜杠转发）→ 302 且跳转仍带前缀", stripped.status === 302 && stripped.location?.startsWith("/queue/?"), `HTTP ${stripped.status} ${stripped.location}`)

  /**
   * 机器人发的短链还挂一段**签名过的签发时刻**（`?t=&ts=`，见 `model/identity.js` 的 `signFreshness`）：
   * 302 要把它写进身份的签发时间，认领层据此判"谁手里那条更新"（主人重发 `#排队` 能抢回写权限）。
   * 验不过 / 没带（旧链接）时退回短码自己的窗口时间——**不是错误**。
   */
  const fresh = signFreshness(code, SIGN_KEY)
  const freshRes = await get(`/queue/${SHORT_PATH}/${code}?t=${fresh.t}&ts=${encodeURIComponent(fresh.ts)}`)
  check("带签发时刻的短链：302 里身份的签发时间就是它", () => {
    const id = decodeIdentity(new URL(freshRes.location, base).searchParams.get("u"))
    return freshRes.status === 302 && id?.issuedAt === fresh.t * 60000
  }, `${freshRes.status} ${freshRes.location}`)
  const badFresh = await get(`/queue/${SHORT_PATH}/${code}?t=${fresh.t}&ts=AAAA`)
  check("签发时刻签名对不上：退回短码自己的窗口时间（照旧 302，不拒绝）", () => {
    const id = decodeIdentity(new URL(badFresh.location, base).searchParams.get("u"))
    return badFresh.status === 302 && id?.issuedAt === verifyTicket(code, SIGN_KEY)?.issuedAt
  }, `${badFresh.status} ${badFresh.location}`)

  /** 顺着跳转走一遍：应当落到编辑器页面（口令 + 身份都在地址里），并由这台设备认领 */
  const target = new URL(passed.location, base)
  const page = await get(`${target.pathname}${target.search}`, { redirect: "follow", jar: device })
  check("顺着跳转能打开编辑器页面", page.status === 200 && page.text.includes("排队表"), `HTTP ${page.status}`)

  /** 这个群昵称在三个榜里可能各有一行：认人按群名片兜底，命中几行就该给几行 */
  const expected = (all.sheets ?? []).flatMap(s =>
    (s.rows ?? []).filter(r => String(r.nickname ?? "").trim() === sample.nick).map(r => ({ sheet: s.name, row: r.row })),
  )
  const data = JSON.parse((await get(`/api/data${target.search}`, { jar: device })).text)
  const mineRowsOut = (data.sheets ?? []).flatMap(s => (s.rows ?? []).map(r => ({ sheet: s.name, row: r.row })))
  const key = list => JSON.stringify([...list].sort((a, b) => `${a.sheet}${a.row}`.localeCompare(`${b.sheet}${b.row}`)))
  check("展开出来的身份就是本人（群名片按 QQ 从群名单补上）", data.perm?.role === "self" && data.perm?.nick === sample.nick, JSON.stringify(data.perm))
  check(
    "本人只拿到自己那些行（表里同一昵称的每一行）",
    mineRowsOut.length > 0 && key(mineRowsOut) === key(expected),
    `拿到 ${JSON.stringify(mineRowsOut)}，应当 ${JSON.stringify(expected)}`,
  )

  /**
   * 有效期按 30 天窗口算：编辑器认"当期 + 上一期"，所以上一窗口的码照样能用；
   * 两个窗口之前的就失效了。窗口边界与"现在"在窗口里的位置有关，所以按窗口起点算。
   */
  const e0 = Math.floor(Date.now() / TICKET_WINDOW_MS) * TICKET_WINDOW_MS
  const prevWindow = signTicket({ qq: MEMBER_QQ }, SIGN_KEY, e0 - TICKET_WINDOW_MS / 2)
  check("上一窗口的码还能用（≈30~60 天）", (await get(`/queue/${SHORT_PATH}/${prevWindow}`)).status === 302)
  const expired = signTicket({ qq: MEMBER_QQ }, SIGN_KEY, e0 - 1.5 * TICKET_WINDOW_MS)
  check("两个窗口之前的码已失效 → 410 提示页", (await get(`/queue/${SHORT_PATH}/${expired}`)).status === 410)

  /** 改一个字符 → MAC 对不上 */
  const tampered = `${code.slice(0, 5)}${code[5] === "A" ? "B" : "A"}${code.slice(6)}`
  check("改一个字符 → 410（MAC 对不上）", (await get(`/queue/${SHORT_PATH}/${tampered}`)).status === 410)

  const tokenSigned = signTicket({ qq: MEMBER_QQ }, TOKEN)
  check("拿口令签的码 → 410（短链也认签名密钥）", (await get(`/queue/${SHORT_PATH}/${tokenSigned}`)).status === 410)

  check("乱七八糟的码 → 410", (await get(`/queue/${SHORT_PATH}/abc`)).status === 410)

  /**
   * 本机编辑器挂在**根目录**（`remote.url` 没有子路径，启动时 `--mount ""`）：
   * 这时请求里没有前缀可依，跳转要落到 `/?…`，不能凭空多出 `/queue`。
   */
  const rootPort = await freePort()
  const rootChild = spawn(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "..", "editor.mjs"),
      "--port", String(rootPort),
      "--token", TOKEN,
      "--sign-key", SIGN_KEY,
      "--file", fixture,
      "--admins", admins,
      "--mount", "",
    ],
    { env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_ROSTER_FILE: rosterFile, ABYSS_EDITOR_TEST_PATHS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  )
  try {
    let rootReady = false
    for (let i = 0; i < 40 && !rootReady; i++) {
      await wait(500)
      try {
        rootReady = (await fetch(`http://127.0.0.1:${rootPort}/healthz?k=${TOKEN}`)).status === 200
      } catch {}
    }
    if (!rootReady) throw new Error("根目录挂载的编辑器没起来")
    const rootRes = await fetch(`http://127.0.0.1:${rootPort}/${SHORT_PATH}/${code}`, { redirect: "manual" })
    const rootLocation = rootRes.headers.get("location") ?? ""
    check("挂在根目录（本机那种）：跳转落到 /?…，不多出子路径", rootRes.status === 302 && /^\/\?k=/.test(rootLocation), `HTTP ${rootRes.status} ${rootLocation}`)
    const rootPage = await fetch(`http://127.0.0.1:${rootPort}${rootLocation}`, { redirect: "follow" })
    check("根目录挂载下也能打开编辑器页面", rootPage.status === 200 && (await rootPage.text()).includes("排队表"), `HTTP ${rootPage.status}`)
  } finally {
    rootChild.kill()
  }
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}\n${out.slice(-600)}`)
} finally {
  child.kill()
  await wait(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 短链验证失败 ${failed} 项` : "\n✅ 短链验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：子进程已 kill、临时目录已清，让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
