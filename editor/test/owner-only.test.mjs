/**
 * 主人专用模式（本机编辑器）：除主人外一律打不开，`/api/snapshot` 例外（机器人只拉快照）
 *
 * 用法：node editor/test/owner-only.test.mjs [xlsx路径]
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

const { signIdentity, signWindow } = await shared("model/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-owner-only-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
/** 数据落点派生自表格所在目录（测试模式），配置里没有路径键 */
fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")

const PORT = await freePort()
const TOKEN = "owner-only-token"
const OWNER = { qq: "1000000001", nick: "缄月" }
const admins = path.join(tmp, "admins.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

const child = spawn(
  process.execPath,
  [
    path.resolve(import.meta.dirname, "..", "editor.mjs"),
    "--port", String(PORT),
    "--token", TOKEN,
    "--file", fixture,
    "--admins", admins,
    "--owner-only",
  ],
  {
    /** 临时目录里的表：套件走测试模式（见 data-confinement.test.mjs） */
    env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
let out = ""
child.stdout.on("data", d => (out += d))
child.stderr.on("data", d => (out += d))

const wait = ms => new Promise(r => setTimeout(r, ms))
const base = `http://127.0.0.1:${PORT}`
const withWho = who => {
  const id = signIdentity(who, TOKEN)
  /** 带身份就必须带时间窗（本阶段起没有 w/ws 的身份链接一律 410，见 editor.mjs） */
  const win = signWindow(who, TOKEN)
  return (
    `k=${TOKEN}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}` +
    (win ? `&w=${win.w}&ws=${encodeURIComponent(win.ws)}` : "")
  )
}
const hit = async (p, qs) => {
  const res = await fetch(`${base}${p}?${qs}`)
  const text = await res.text()
  return { status: res.status, text }
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
      ready = (await hit("/healthz", `k=${TOKEN}`)).status === 200
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  const health = JSON.parse((await hit("/healthz", `k=${TOKEN}`)).text)
  check("healthz 标明主人专用", health.owner_only === true, JSON.stringify(health))

  const guestData = await hit("/api/data", `k=${TOKEN}`)
  check("访客（只有口令）读数据被拒", guestData.status === 403, `HTTP ${guestData.status}`)

  const guestPage = await hit("/", `k=${TOKEN}`)
  check("访客打开首页看到「仅主人可用」", guestPage.status === 403 && guestPage.text.includes("只有主人"), `HTTP ${guestPage.status}`)

  const otherData = await hit("/api/data", withWho({ qq: "10086", nick: "路人甲" }))
  check("别人的个人链接也被拒", otherData.status === 403, `HTTP ${otherData.status}`)

  const ownerData = await hit("/api/data", withWho(OWNER))
  check("主人能正常打开", ownerData.status === 200 && JSON.parse(ownerData.text).perm?.owner === true, `HTTP ${ownerData.status}`)

  const snap = await hit("/api/snapshot", `k=${TOKEN}`)
  check("机器人拉快照仍然放行", snap.status === 200, `HTTP ${snap.status}`)

  const badToken = await hit("/api/snapshot", "k=nope")
  check("快照仍然要口令", badToken.status === 403, `HTTP ${badToken.status}`)
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  child.kill()
  await wait(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 主人专用模式验证失败 ${failed} 项` : "\n✅ 主人专用模式验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：子进程已 kill、临时目录已清，让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
