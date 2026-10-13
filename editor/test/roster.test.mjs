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

const { signIdentity, signWindow } = await shared("model/identity.js")

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
/**
 * 发一个请求
 *
 * **默认不带时间窗**——这是插件侧的真实拼法（机器人推名单 / 每日整理 / 插队都是无设备的一次性
 * 请求）。2026-10-08 复审报告 §2-#1 抓到的正是这里：这份构造器原先替**所有**带身份的请求自动补
 * `w/ws`，于是"插件只带了 k/u/s"这个跨层 bug 在编辑器侧全绿。人（页面）那一侧才带窗口：`windowed: true`。
 */
const req = async (p, { who = null, body = null, method, windowed = false } = {}) => {
  const q = [`k=${TOKEN}`]
  if (who) {
    const id = signIdentity(who, SIGN_KEY)
    q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
    const win = windowed ? signWindow(who, SIGN_KEY) : null
    if (win) q.push(`w=${win.w}`, `ws=${encodeURIComponent(win.ws)}`)
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
  const byMember = await req("/api/roster", { who: { qq: "10001", nick: first.nickname }, body: { group: "999", members: [] }, windowed: true })
  check("成员身份推送被拒", byMember.status === 403, `HTTP ${byMember.status}`)

  /* 先用成员身份各绑一行（绑定是"按 QQ 对账"的依据）：人这一侧走的是带窗口的链接 */
  for (const [qq, row] of [["10001", first], ["10002", second], ["10003", third]]) {
    const who = { qq, nick: row.nickname }
    const saved = await req("/api/save", { who, body: { sheet: SHEET, rows: [{ row: row.row, values: { ...row, note: "" } }] }, windowed: true })
    if (!saved.json.ok) throw new Error(`绑定行失败（${row.nickname}）：${saved.json.error}`)
  }

  /**
   * 机器人推名单：三个人都在，其中一人改了名片
   *
   * **这一发不带时间窗**（构造器默认），正是插件侧的真实形状：机器人身份没有设备可认领，
   * 编辑器的闸对它豁免（`editor.mjs` 的「链接的时间窗」那条 `fromBot`）。带窗口的那一路由下面
   * 那条单独钉——插件现在两种都通（`signedEditorQuery` 会带窗口，豁免是第二道保险）。
   */
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

  const versions = await req("/api/versions", { who: OWNER, windowed: true })
  check("删行前存了历史版本（能回退）", versions.json.versions.length >= 1, JSON.stringify(versions.json.versions.length))

  const empty = await req("/api/roster", { who: BOT, body: { group: "999888", members: [] } })
  check("空名单被拒（防止全员被当成退群）", empty.status === 400, `HTTP ${empty.status} ${JSON.stringify(empty.json)}`)

  /**
   * 插件现在的真实拼法**带当期时间窗**（`model/identity.js` 的 `signedEditorQuery`）：
   * 这一发按那个形状走一遍，钉住"机器人带窗口也照样通"（两道保险都别坏）。
   */
  const withWindow = await req("/api/roster", {
    who: BOT,
    windowed: true,
    body: { group: "999888", members: [{ qq: "10001", nick: RENAMED }, { qq: "10002", nick: second.nickname }] },
  })
  check("机器人带当期时间窗推名单（插件真实拼法）：同样通", withWindow.json.ok === true, `HTTP ${withWindow.status} ${JSON.stringify(withWindow.json)}`)

  /**
   * 别人（非机器人身份）不带窗口推名单
   *
   * **2026-10 口径反转**：从前那条闸对"带身份、没窗口"的请求一律 410（只放行认领过的设备），
   * 现在窗口只挡**过期的窗口**（`w/ws` 验不过才 410），没有窗口的请求照旧放行——
   * 但他**不是机器人身份**，所以推名单照旧 403（权限那一条闸没动）。
   */
  const noWindow = await req("/api/roster", { who: { qq: "10009", nick: "路人" }, body: { group: "999888", members: [{ qq: "10001", nick: RENAMED }] } })
  check("非机器人身份不带时间窗推名单：403（不再 410，权限那一条闸没动）", noWindow.status === 403, `HTTP ${noWindow.status}`)

  /* ------------- 退群候选行审计：只列候选，主人点名才删 ------------- */

  /**
   * 「表里有行、但既没有有效绑定、群名单里也找不到这个人」的人：**不会**被名单对账自动删
   * （对账只看绑定，见 `reconcileRoster`），要靠这里的候选列表 + 主人确认。
   */
  const orphan = "查无此人的行"
  const rowsBeforePrune = await rowsOf()
  const put = await req("/api/save", {
    who: OWNER,
    body: {
      sheet: SHEET,
      rows: [
        {
          row: rowsBeforePrune.at(-1).row + 1,
          values: { nickname: orphan, gameName: "孤儿行", anchor: first.anchor, goal: first.goal, note: "谁都不认识这一行" },
        },
      ],
    },
  })
  check("前置：主人铺了一行不在群名单里的（没有绑定）", put.json?.ok === true, JSON.stringify(put.json))

  const audit = await req("/api/ownership", { who: OWNER })
  const missing = audit.json?.missing?.rows ?? []
  check(
    "候选行里列出了它（既无有效绑定、群名单里也找不到）",
    audit.json?.missing?.supported === true && missing.some(m => m.nickname === orphan),
    JSON.stringify(audit.json?.missing),
  )
  check(
    "名单里有的人**不会**进候选（人名对得上就不列）",
    /** 此刻名单里只剩这两位（上面刚把 10003 / 10004 当成退群推掉） */
    !missing.some(m => [RENAMED, second.nickname].includes(m.nickname)),
    JSON.stringify(missing.map(m => m.nickname)),
  )

  const target = missing.find(m => m.nickname === orphan)
  /**
   * 候选行给的是**序号**（表里第一列那个 1..N），不是表格行号——三个榜表头行号不同，
   * 主人对着表看的是序号（维护者报过"第 x 行与实际不符"）。`row` 照旧带着，删行要用它。
   */
  const rowsNow = await rowsOf()
  const orphanSeq = String(rowsNow.find(r => r.row === target.row)?.seq ?? "").trim()
  check(
    "候选行带着序号（与表里那一行的序号一致，不是表格行号）",
    Boolean(orphanSeq) && String(target.seq) === orphanSeq,
    `候选 seq=${JSON.stringify(target.seq)}、表里那一行的 seq=${JSON.stringify(orphanSeq)}、表格行号=${target.row}`,
  )
  const pruned = await req("/api/ownership", { who: OWNER, body: { action: "prune-missing", rows: [{ sheet: target.sheet, row: target.row }] } })
  check("主人点名的候选行被删掉（压紧）", pruned.json?.ok === true && pruned.json?.removed === 1, JSON.stringify(pruned.json))
  const afterPrune = await rowsOf()
  check("表里已经没有那一行了", !afterPrune.some(r => String(r.nickname ?? "").trim() === orphan), JSON.stringify(afterPrune.map(r => r.nickname)))
  check("删的是一行：行数少 1", afterPrune.length === rowsBeforePrune.length, `${rowsBeforePrune.length} → ${afterPrune.length}`)

  const changes = (await req("/api/changes", { who: OWNER })).json
  const rec = (changes?.entries ?? []).find(e => e.kind === "remove" && e.nick === orphan)
  check(
    "删了什么进了改动记录（via=主人确认，可回溯）",
    rec?.via === "主人确认" && Boolean(rec?.snapshot),
    JSON.stringify((changes?.entries ?? []).filter(e => e.kind === "remove").slice(0, 2)),
  )

  /** 表已经变了：同一个行号再点一次不会删错人（服务端只删对得上的行） */
  const again = await req("/api/ownership", { who: OWNER, body: { action: "prune-missing", rows: [{ sheet: target.sheet, row: target.row }] } })
  check("行号已经失效（那一行没了 / 是别人了）⇒ 跳过，不乱删", again.json?.ok === true && again.json?.removed === 0, JSON.stringify(again.json))

  /* ------------- 同一趟里「有人改名 + 有人退群」：两笔写不能互相盖掉 ------------- */

  /**
   * **回归**（2026-10 实测抓到的既有缺陷）：`reconcileRoster` 原本先按绑定写改名、再删行压紧，
   * 而压紧是"把留下的每一行内容整体重写一遍"（`compactSheet` 拿的是**改动前**那一版模型的值），
   * 于是刚写进去的新名片会被同一格上的旧值盖掉——表写前的自检（`model/table.js` 的 `#verify`）
   * 发现"这一格期望「新名」实际「旧名」"就**放弃整趟写入**：机器人推名单整个失败，
   * 当天的名单同步上不去（编辑器退回老口径），而群里只看得到"名单好像没更新"。
   */
  const RENAMED2 = `${RENAMED}又改`
  const mixBefore = await rowsOf()
  const mixed = await req("/api/roster", {
    who: BOT,
    body: { group: "999888", members: [{ qq: "10001", nick: RENAMED2 }] },
  })
  check("同一趟里改名 + 退群：整趟成功（不再被自检放弃）", mixed.json?.ok === true, `HTTP ${mixed.status} ${JSON.stringify(mixed.json)}`)
  check("回报里改名与删行都在", mixed.json?.renamed === 1 && mixed.json?.removed === 1, JSON.stringify(mixed.json))
  const mixAfter = await rowsOf()
  check(
    "改名写进去了（没被压紧盖回旧名）",
    mixAfter.some(r => String(r.nickname ?? "").trim() === RENAMED2),
    JSON.stringify(mixAfter.map(r => r.nickname)),
  )
  check("退群那一行删掉了、行数少 1", mixAfter.length === mixBefore.length - 1, `${mixBefore.length} → ${mixAfter.length}`)

  /** 名单不可信（这里清掉名单文件）：不做候选，并说清原因 */
  const rosterFile = path.join(tmp, "abyss-editor-roster.json")
  fs.writeFileSync(rosterFile, JSON.stringify({ group: "999888", updatedAt: 0, members: [] }), "utf8")
  const noRoster = await req("/api/ownership", { who: OWNER })
  check(
    "群名单不可信 ⇒ 不列候选，并说清「先同步一次名单」",
    noRoster.json?.missing?.supported === false && String(noRoster.json?.missing?.reason).includes("同步名单"),
    JSON.stringify(noRoster.json?.missing),
  )
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
