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
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（不再"缺表就跳过"） */
import { SOURCE as SRC } from "./source.mjs"

const { signIdentity } = await shared("lib/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-signkey-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
fs.writeFileSync(
  cfg,
  [`xlsx_path: "${fixture.replace(/\\/g, "/")}"`, `store_file: "${path.join(tmp, "bindings.json").replace(/\\/g, "/")}"`].join("\n"),
  "utf8",
)

const PORT = 7804
const TOKEN = "access-token-aaa"
const SIGN_KEY = "sign-key-bbb"
const OWNER = { qq: "1733491779", nick: "缄月" }
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
const withWho = (who, key) => {
  const id = signIdentity(who, key)
  return `k=${TOKEN}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}`
}
const hit = async (p, qs) => {
  const res = await fetch(`${base}${p}?${qs}`)
  return { status: res.status, text: await res.text() }
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
      ready = (await hit("/healthz", `k=${TOKEN}`)).status === 200
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  check("healthz 标明签名密钥与口令是分开的", JSON.parse((await hit("/healthz", `k=${TOKEN}`)).text).sign_key === true)

  const forged = await hit("/api/admins", withWho(OWNER, TOKEN))
  check("拿口令伪造的主人身份被拒（白名单接口）", forged.status === 403, `HTTP ${forged.status}`)

  const forgedData = JSON.parse((await hit("/api/data", withWho(OWNER, TOKEN))).text)
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
