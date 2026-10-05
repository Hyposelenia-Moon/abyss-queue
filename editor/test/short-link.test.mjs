/**
 * 短链：`<url>/s/<码>` → 换成带身份的长地址再跳过去
 *
 * 群里发的是短链（机器人 `signTicket` 签、编辑器 `verifyTicket` 验，两边共用 lib/identity.js），
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

const { signIdentity, signTicket, verifyTicket, SHORT_PATH, TICKET_WINDOW_MS } = await shared("lib/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-shortlink-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
/** 数据落点派生自表格所在目录（测试模式），配置里没有路径键 */
fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")

const PORT = 7808
const TOKEN = "short-token-aaa"
const SIGN_KEY = "short-sign-key-bbb"
const OWNER = { qq: "1733491779", nick: "缄月" }
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
/** 带身份取数据（管理员视角，用来挑一个真实成员） */
const asWho = who => {
  const id = signIdentity(who, SIGN_KEY)
  return `k=${TOKEN}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}`
}
const get = async (p, { redirect = "manual" } = {}) => {
  const res = await fetch(`${base}${p}`, { redirect })
  return { status: res.status, location: res.headers.get("location"), text: await res.text() }
}

let failed = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`)
  }
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

  /** 机器人每天推的群名单：短链里没有群名片，编辑器按 QQ 从这份名单里补 */
  fs.writeFileSync(rosterFile, JSON.stringify({ group: "965272093", updatedAt: Date.now(), members: [{ qq: MEMBER_QQ, nick: sample.nick }] }), "utf8")

  const code = signTicket({ qq: MEMBER_QQ }, SIGN_KEY)
  check("码是不透明的 16 字符单段短码（不含口令、群名片，也看不出 QQ）", /^[A-Za-z0-9_-]{16}$/.test(code), code)
  check("码里能验出是谁（与编辑器同一套）", verifyTicket(code, SIGN_KEY)?.qq === MEMBER_QQ, code)
  check("码里看不出 QQ（十进制与 base36 都不出现）", !code.includes(MEMBER_QQ) && !code.includes((Number(MEMBER_QQ)).toString(36)), code)

  const passed = await get(`/queue/${SHORT_PATH}/${code}`)
  check("原样带前缀访问（nginx 不剥前缀）→ 302", passed.status === 302, `HTTP ${passed.status}`)
  check(
    "跳转地址是相对路径、带口令与身份参数（换域名/https 都跟着走）",
    /^\/queue\/\?k=[^&]+&u=[^&]+&s=[^&]+$/.test(passed.location ?? ""),
    passed.location ?? "",
  )

  const stripped = await get(`/${SHORT_PATH}/${code}`)
  check("剥掉前缀访问（nginx 带尾斜杠转发）→ 302 且跳转仍带前缀", stripped.status === 302 && stripped.location?.startsWith("/queue/?"), `HTTP ${stripped.status} ${stripped.location}`)

  /** 顺着跳转走一遍：应当落到编辑器页面（口令 + 身份都在地址里） */
  const target = new URL(passed.location, base)
  const page = await get(`${target.pathname}${target.search}`, { redirect: "follow" })
  check("顺着跳转能打开编辑器页面", page.status === 200 && page.text.includes("排队表"), `HTTP ${page.status}`)

  /** 这个群昵称在三个榜里可能各有一行：认人按群名片兜底，命中几行就该给几行 */
  const expected = (all.sheets ?? []).flatMap(s =>
    (s.rows ?? []).filter(r => String(r.nickname ?? "").trim() === sample.nick).map(r => ({ sheet: s.name, row: r.row })),
  )
  const data = JSON.parse((await get(`/api/data${target.search}`)).text)
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
  const rootPort = 7809
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
