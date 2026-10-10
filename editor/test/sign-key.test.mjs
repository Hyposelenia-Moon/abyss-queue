/**
 * 签名密钥与访问口令分开之后：拿口令伪造出来的身份必须被拒
 *
 * 口令（`k=`）会出现在每个人的链接里，签名密钥只留在机器人与编辑器手上——
 * 这是"越权"最要命的一条，所以单独一个套件盯着它。
 *
 * 用法：node editor/test/sign-key.test.mjs [xlsx路径]
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-signkey-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
/** 数据落点派生自表格所在目录（测试模式），配置里没有路径键 */
fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")

const PORT = await freePort()
const TOKEN = "access-token-aaa"
const SIGN_KEY = "sign-key-bbb"
const OWNER = { qq: "1000000001", nick: "缄月" }
const admins = path.join(tmp, "admins.json")
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
/**
 * @param {string} key 用来签名的密钥：正式那份是 SIGN_KEY，伪造那份只有 TOKEN
 * @param {object} [opts] `windowed: false` = 不带时间窗
 *        拿口令伪造的那一份**不该**带窗口：攻击者手里没有签名密钥，签不出能过的 `ws`
 *        （带上一个签错的窗口，编辑器按"改过的窗口"给 410，那就测不到"伪造身份只是访客"了）
 */
const withWho = (who, key, { windowed = true } = {}) => {
  const id = signIdentity(who, key)
  const win = windowed ? signWindow(who, key) : null
  return (
    `k=${TOKEN}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}` +
    (win ? `&w=${win.w}&ws=${encodeURIComponent(win.ws)}` : "")
  )
}
const hit = async (p, qs) => {
  const res = await fetch(`${base}${p}?${qs}`)
  return { status: res.status, text: await res.text() }
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

  check("healthz 标明签名密钥与口令是分开的", JSON.parse((await hit("/healthz", `k=${TOKEN}`)).text).sign_key === true)

  const forged = await hit("/api/admins", withWho(OWNER, TOKEN, { windowed: false }))
  check("拿口令伪造的主人身份被拒（白名单接口）", forged.status === 403, `HTTP ${forged.status}`)

  const forgedData = JSON.parse((await hit("/api/data", withWho(OWNER, TOKEN, { windowed: false }))).text)
  check("拿口令伪造的身份只是访客（数据接口）", forgedData.perm?.owner !== true && forgedData.perm?.role !== "admin", JSON.stringify(forgedData.perm))

  const real = await hit("/api/admins", withWho(OWNER, SIGN_KEY))
  check("用签名密钥签的主人身份正常", real.status === 200 && JSON.parse(real.text).ok === true, `HTTP ${real.status}`)

  check("机器人拉快照仍只凭口令", (await hit("/api/snapshot", `k=${TOKEN}`)).status === 200)
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  child.kill()
  await wait(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 签名密钥验证失败 ${failed} 项` : "\n✅ 签名密钥验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：子进程已 kill、临时目录已清，让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
