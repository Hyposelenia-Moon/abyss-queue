/**
 * 群成员名单：候选、改名同步、退群删行并压紧
 *
 * 用法：node editor/test/roster.test.mjs [xlsx路径]
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
import { cookieJar } from "./harness.mjs"

const { signIdentity } = await shared("model/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-roster-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
/** 数据落点派生自表格所在目录（测试模式），配置里没有路径键 */
fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")

const PORT = await freePort()
const TOKEN = "roster-token"
const SIGN_KEY = "roster-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }
const BOT = { qq: "0", nick: "群成员名单" }
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
    env: {
      ...process.env,
      ABYSS_QUEUE_CONFIG: cfg,
      ABYSS_EDITOR_VERSIONS_DIR: path.join(tmp, "versions"),
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
/** 一台"设备"一个 cookie 罐（按 QQ 分）：认领那一层靠 cookie 认设备，见 `harness.mjs` 的 `cookieJar` */
const jars = new Map()
const jarOf = who => {
  const key = who ? `qq:${who.qq ?? ""}` : "(无身份)"
  if (!jars.has(key)) jars.set(key, cookieJar())
  return jars.get(key)
}
const req = async (p, { who = null, body = null, method } = {}) => {
  const q = [`k=${TOKEN}`]
  if (who) {
    const id = signIdentity(who, SIGN_KEY)
    q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
  }
  const jar = jarOf(who)
  const init = { method: method ?? (body ? "POST" : "GET"), headers: { ...jar.headers } }
  if (body) {
    init.headers["content-type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`http://127.0.0.1:${PORT}${p}?${q.join("&")}`, init)
  jar.take(res)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { __raw: text.slice(0, 200) }
  }
  return { status: res.status, json }
}

let failed = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`)
  }
}

const SHEET = "幻想真境剧诗"
const rowsOf = async () => (await req("/api/data")).json.sheets.find(s => s.name === SHEET).rows

try {
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    await wait(500)
    try {
      ready = (await req("/healthz")).status === 200
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  const before = await rowsOf()
  /** 三行成员数据都从被测表里取（不写死昵称/行号：换表、补过行都不会误报） */
  const first = before[0]
  const second = before[1]
  const third = before[2]
  /** 改名后的名片：由原名片推出来，断言不钉在某个具体昵称上 */
  const RENAMED = `${first.nickname}改`

  check("一开始没有群名单（本地/未推送时没有候选）", (await req("/healthz")).json.roster === 0)

  /* 普通成员推不动名单 */
  const byMember = await req("/api/roster", { who: { qq: "10001", nick: first.nickname }, body: { group: "999", members: [] } })
  check("成员身份推送被拒", byMember.status === 403, `HTTP ${byMember.status}`)

  /* 先用成员身份各绑一行（绑定是"按 QQ 对账"的依据） */
  for (const [qq, row] of [["10001", first], ["10002", second], ["10003", third]]) {
    const who = { qq, nick: row.nickname }
    const saved = await req("/api/save", { who, body: { sheet: SHEET, rows: [{ row: row.row, values: { ...row, note: "" } }] } })
    if (!saved.json.ok) throw new Error(`绑定行失败（${row.nickname}）：${saved.json.error}`)
  }

  /* 机器人推名单：三个人都在，其中一人改了名片 */
  const pushed = await req("/api/roster", {
    who: BOT,
    body: {
      group: "999888",
      members: [
        { qq: "10001", nick: RENAMED }, // 改名
        { qq: "10002", nick: second.nickname },
        { qq: "10003", nick: third.nickname },
        { qq: "10004", nick: "路人甲" },
      ],
    },
  })
  check("机器人推名单成功", pushed.json.ok === true, JSON.stringify(pushed.json))
  check("回报里带上改了几行", pushed.json.renamed >= 1, JSON.stringify(pushed.json))

  const after = await rowsOf()
  const renamedRow = after.find(r => r.row === first.row)
  check("表里的群昵称跟着新名片改了", renamedRow.nickname === RENAMED, JSON.stringify(renamedRow.nickname))

  const payload = (await req("/api/data")).json
  check("候选里带着群成员昵称", payload.roster.count === 4 && payload.roster.candidates.includes("路人甲"), JSON.stringify(payload.roster))

  /* 再推一次：去掉一个人（退群）→ 删那一行并压紧 */
  const dropRow = third.row
  const totalBefore = (await rowsOf()).length
  const gone = await req("/api/roster", {
    who: BOT,
    body: {
      group: "999888",
      members: [
        { qq: "10001", nick: RENAMED },
        { qq: "10002", nick: second.nickname },
      ],
    },
  })
  check("退群处理成功", gone.json.ok === true && gone.json.removed === 1, JSON.stringify(gone.json))

  const packed = await rowsOf()
  check("行数少了一行", packed.length === totalBefore - 1, `${packed.length} vs ${totalBefore - 1}`)
  check(
    "没有留下空洞（被删行由下面的人补上）",
    packed.some(r => r.row === dropRow && r.nickname === before[3].nickname),
    JSON.stringify(packed.map(r => `${r.row}:${r.nickname}`)),
  )
  check(
    "下面的行整体上移、顺序不变",
    JSON.stringify(packed.map(r => r.nickname)) === JSON.stringify(before.filter(r => r.nickname !== third.nickname).map(r => (r.nickname === first.nickname ? RENAMED : r.nickname))),
    JSON.stringify(packed.map(r => r.nickname)),
  )

  const versions = await req("/api/versions", { who: OWNER })
  check("删行前存了历史版本（能回退）", versions.json.versions.length >= 1, JSON.stringify(versions.json.versions.length))

  const empty = await req("/api/roster", { who: BOT, body: { group: "999888", members: [] } })
  check("空名单被拒（防止全员被当成退群）", empty.status === 400, `HTTP ${empty.status} ${JSON.stringify(empty.json)}`)
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  child.kill()
  await wait(400)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 群名单 验证失败 ${failed} 项` : "\n✅ 群名单 验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
