/**
 * 改动记录（留痕）：谁在什么时候改了哪一行的哪个字段
 *
 * 分两层验，缺一层都说明不了问题：
 *   - **模块层**（`editor/changes.js`）：滚动保留、可见范围（自己发的 / 改到我自己那些行的 / 全部）；
 *   - **端到端**（起一个真编辑器）：保存 → 记录里字段级差异对不对；提交整行但没改 → 不记；
 *     一次改两个字段 → 一条记录；被拒的保存 → `reject`；改名连带 → `via: "改名连带"`；
 *     退群删行 → `remove`；`/api/changes` 的可见范围（管理员全部 / 本人只看到与自己相关的 / 访客 403）。
 *
 * 用法：node editor/test/changes.test.mjs [xlsx路径]
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

const { signIdentity, signWindow, signedEditorQuery } = await shared("model/identity.js")
const { createChanges } = await shared("editor/changes.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-changes-"))
const TOKEN = "changes-token"
const SIGN_KEY = "changes-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }
/**
 * 群友甲 / 乙：**昵称在启动后从被测表里现取**（表里那一行的群昵称）
 *
 * 不写死名字：真实表与合成样本是两批数据（`test/fixtures/sample-table.mjs` 的样本叫「样本甲…」，
 * 维护者真实表里是群人自己的名片），写死名字的话换一台机器就整套红。
 * `locateSelf` 的昵称兜底要求"这一榜里叫这个名字的**只有一行**"，所以取名字时顺手把重名剔掉。
 */
const SELF = { qq: "900000001", nick: "" }
const OTHER = { qq: "900000002", nick: "" }
/** 机器人身份：推群成员名单（`--roster-qq` 默认就是 "0"） */
const ROSTER = { qq: "0", nick: "群成员名单" }

const admins = path.join(tmp, "admins.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

let failed = 0
/**
 * 断言：`ok` 收两种写法——**布尔**（直接判真假）或**回调 / async 回调**（抛错即失败）
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
  if (out && typeof out.then === "function") return out.then(pass, err => fail(err?.message ?? String(err)))
  return pass()
}

/* ------------------------------ 模块层 ------------------------------ */

/**
 * 模块层用例：不碰网络，直接对着临时文件跑
 *
 * 这一层专门钉"滚动保留"和"可见范围"——那两条是纯函数口径，端到端里要造出一堆记录才能看出来，
 * 放在这里既快又准。
 */
const moduleCases = () => {
  const file = path.join(tmp, "unit-changes.json")
  const box = createChanges({ file, keep: 3 })
  const mk = (n, qq = "1", row = n) => ({ kind: "edit", at: 1000 + n, qq, nick: `人${qq}`, sheet: "榜", row, changes: { note: ["", String(n)] } })

  box.append([mk(1), mk(2), mk(3), mk(4), mk(5)])
  const kept = box.load().rows
  check("滚动保留：只留最近 keep 条（顺序保持）", kept.length === 3 && kept.map(r => r.changes.note[1]).join("") === "345", JSON.stringify(kept.map(r => r.changes.note[1])))

  check("没有 at 的脏记录进不去", box.append([{ kind: "edit", changes: {} }]) === 0 && box.load().rows.length === 3)

  check("管理员视角：新的在前", box.list({ all: true }).map(r => r.changes.note[1]).join("") === "543")

  /**
   * 可见范围单独用一个大 keep 的实例：上面那个 keep=3 会把要判定的记录滚掉
   * （那正是前一条要验的行为，不能拿它当这一条的舞台）。
   */
  const box2 = createChanges({ file: path.join(tmp, "unit-visibility.json"), keep: 50 })
  check("本人视角：自己发的 + 改到我自己那些行的", () => {
    box2.append([
      /** 别人发的，但改的是第 9 行 —— 用 mine 认出来 */
      { kind: "edit", at: 2000, qq: "77", sheet: "榜", row: 9, changes: { note: ["a", "b"] } },
      /** 别人发的别人那一行 —— 与我无关 */
      { kind: "edit", at: 2001, qq: "77", sheet: "榜", row: 8, changes: { note: ["a", "b"] } },
      /** 别人的榜 —— 与我无关 */
      { kind: "edit", at: 2002, qq: "77", sheet: "别的榜", row: 9, changes: { note: ["a", "b"] } },
      /** reject 用的是 rows 数组，也要能被认出来 */
      { kind: "reject", at: 2003, qq: "77", sheet: "榜", rows: [9, 10], reason: "超额度" },
      /** 我发的、行号与我无关（比如我改的是空行）—— 也要看得到 */
      { kind: "edit", at: 2004, qq: "5", sheet: "榜", row: 1, changes: { note: ["a", "b"] } },
    ])
    const mine = new Map([["榜", new Set([9])]])
    const got = box2.list({ all: false, qq: "5", mine })
    const at = got.map(r => r.at)
    for (const want of [2004, 2003, 2000])
      if (!at.includes(want)) throw new Error(`应当看到 at=${want} 那条，实际 ${JSON.stringify(at)}`)
    for (const no of [2001, 2002]) if (at.includes(no)) throw new Error(`不该看到 at=${no} 那条：${JSON.stringify(got.find(r => r.at === no))}`)
    if (at.length !== 3) throw new Error(`应当正好 3 条，实际 ${JSON.stringify(at)}`)
  })
}

/* ------------------------------ 端到端 ------------------------------ */

const start = async () => {
  const dir = path.join(tmp, "editor")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "queue.xlsx")
  fs.copyFileSync(SRC, file)
  const cfg = path.join(dir, "config.yaml")
  fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")
  const port = await freePort()
  const args = [
    path.resolve(import.meta.dirname, "..", "editor.mjs"),
    "--port", String(port),
    "--token", TOKEN,
    "--sign-key", SIGN_KEY,
    "--file", file,
    "--admins", admins,
    /** 认领记录 / 绑定 / 改动记录都落在"表格旁边"（见 editor/config.js 的 dataBase 口径） */
    "--roster-qq", "0",
  ]
  const env = { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1" }
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", d => (log += d))
  child.stderr.on("data", d => (log += d))
  return { port, file, dir, child, log: () => log }
}

const wait = ms => new Promise(r => setTimeout(r, ms))
/** 一台"设备"一个 cookie 罐（认领那一层靠 cookie 认设备） */
const jars = new Map()
const jarOf = who => {
  const key = who ? `qq:${who.qq}` : "(无身份)"
  if (!jars.has(key)) jars.set(key, cookieJar())
  return jars.get(key)
}

function makeReq(port) {
  return async (p, { who = null, body = null, method, query = {} } = {}) => {
    const q = [`k=${TOKEN}`, ...Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)]
    if (who) {
      const id = signIdentity(who, SIGN_KEY)
      q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
      const win = signWindow(who, SIGN_KEY)
      if (win) q.push(`w=${win.w}`, `ws=${encodeURIComponent(win.ws)}`)
    }
    const jar = jarOf(who)
    const init = { method: method ?? (body ? "POST" : "GET"), headers: { ...jar.headers } }
    if (body) {
      init.headers["content-type"] = "application/json"
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`http://127.0.0.1:${port}${p}?${q.join("&")}`, init)
    jar.take(res)
    const text = await res.text()
    let out = null
    try {
      out = JSON.parse(text)
    } catch {
      out = { __raw: text.slice(0, 200) }
    }
    return { status: res.status, json: out }
  }
}

/** 某一榜里**真的没人**的第一个空行（`model.rows` 只列出有内容的行） */
const freeRow = sheet => {
  const used = new Set(sheet.rows.map(r => r.row))
  for (let r = sheet.dataStart; r <= sheet.dataEnd; r++) if (!used.has(r)) return r
  return 0
}

const runE2E = async () => {
  const ed = await start()
  const req = makeReq(ed.port)
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await wait(500)
      try {
        up = (await req("/healthz")).status === 200
      } catch {}
    }
    if (!up) throw new Error(`编辑器没起来：\n${ed.log()}`)

    const data = (await req("/api/data", { who: OWNER })).json
    const sheetName = data.sheets[0].name
    const sheet = data.sheets[0]
    /**
     * 挑两行"名字在这一榜里唯一"的成员当甲、乙
     *
     * 唯一性有两个用处：`locateSelf` 的昵称兜底只认唯一同名行；改名连带（`statusRenamePlan`）
     * 也要求"这一榜里叫旧昵称的行只有一行"，否则它会整榜不动。
     */
    const count = new Map()
    for (const r of sheet.rows) {
      const n = String(r.nickname ?? "").trim()
      if (n) count.set(n, (count.get(n) ?? 0) + 1)
    }
    const uniq = sheet.rows.filter(r => {
      const n = String(r.nickname ?? "").trim()
      return n && count.get(n) === 1 && String(r.gameName ?? "").trim()
    })
    if (uniq.length < 2) throw new Error(`这一榜里凑不出两行唯一昵称的成员：${JSON.stringify(sheet.rows.map(r => r.nickname))}`)
    const rowA = uniq[0]
    const rowB = uniq[1]
    SELF.nick = String(rowA.nickname).trim()
    OTHER.nick = String(rowB.nickname).trim()

    const listOf = async who => (await req("/api/changes", { who })).json

    /* --- 1. 改了哪个字段就记哪个字段 --- */
    const before = (await listOf(OWNER)).entries.length
    const newNote = "留痕测试-备注"
    const saved = await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, rows: [{ row: rowB.row, values: { ...rowB, note: newNote } }] },
    })
    if (!saved.json.ok) throw new Error(`保存失败：${JSON.stringify(saved.json)}`)
    let entries = (await listOf(OWNER)).entries
    check("保存成功 ⇒ 多一条记录", entries.length === before + 1, `${before} → ${entries.length}`)
    const first = entries[0]
    /**
     * 这一条是**反着**判的：我没碰的字段一个都不许出现在记录里。
     *
     * 为什么不断言"只有 note 一个字段"：那一行的完成情况在表里存的是字面「本人已完成」，
     * 读出来时页面拿到的是这一行的群昵称，写回去会把它落成群昵称——**那一格确实真的变了**
     * （见 `applySave` 里 `statusWithSelfDone` 那段），记它是正确的。
     */
    const untouched = ["nickname", "gameName", "anchor", "goal", "strength"].filter(k => k in (first?.changes ?? {}))
    check(
      "记录只含**真正改动**的字段（提交的是整行，没碰的字段一个都不许记）",
      first?.kind === "edit" && untouched.length === 0 && "note" in (first?.changes ?? {}),
      JSON.stringify(first),
    )
    check("记录里是 [原值, 新值]", first?.changes?.note?.[0] === String(rowB.note ?? "") && first?.changes?.note?.[1] === newNote, JSON.stringify(first?.changes))
    check("记录带齐榜 / 行 / 谁 / 哪一版", first?.sheet === sheetName && first?.row === rowB.row && first?.qq === OWNER.qq && Boolean(first?.version), JSON.stringify(first))

    /* --- 2. 提交整行但一个字没改 ⇒ 不记（否则"提交了几行"会被误当成"改了几行"） --- */
    const same = await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, rows: [{ row: rowB.row, values: { ...rowB, note: newNote } }] },
    })
    check("提交没改动的行：保存照旧成功、但不产生记录", same.json.ok === true && (await listOf(OWNER)).entries.length === entries.length, JSON.stringify(same.json))

    /* --- 3. 一次改两个字段 ⇒ **一条**记录、两个字段（一行一条） --- */
    const rowB2 = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows.find(r => r.row === rowB.row)
    /** 两个字段都挑**自由文本**（备注 / 游戏名）：它们没有下拉校验，换一张表也照样成立 */
    const newGameName = `${String(rowB2.gameName ?? "").trim()}·留痕`
    const two = await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, rows: [{ row: rowB.row, values: { ...rowB2, note: "留痕-两处", gameName: newGameName } }] },
    })
    entries = (await listOf(OWNER)).entries
    const twoRec = entries[0]
    check(
      "一次改两个字段：一条记录、两个字段",
      two.json.ok === true && twoRec?.changes?.note?.[1] === "留痕-两处" && twoRec?.changes?.gameName?.[1] === newGameName && Object.keys(twoRec.changes).length === 2,
      JSON.stringify(twoRec),
    )

    /* --- 4. 本人改自己那一行：认得出来、记得下 --- */
    const selfData = (await req("/api/data", { who: SELF })).json
    const selfSheet = selfData.sheets.find(s => s.name === sheetName)
    check("本人只拿到自己那些行（昵称兜底认出来）", selfSheet?.rows.length === 1 && selfSheet.rows[0].row === rowA.row, JSON.stringify(selfSheet?.rows?.map(r => r.row)))
    const selfSaved = await req("/api/save", {
      who: SELF,
      body: { sheet: sheetName, rows: [{ row: rowA.row, values: { ...selfSheet.rows[0], note: "本人改的" } }] },
    })
    check("本人改自己那一行：成功且记录挂在本人 QQ 上", selfSaved.json.ok === true && (await listOf(SELF)).entries[0]?.qq === SELF.qq, JSON.stringify(selfSaved.json))

    /* --- 5. 被拒的保存也要留痕（谁在试，和谁改成了一样重要） --- */
    const rejected = await req("/api/save", {
      who: SELF,
      body: { sheet: sheetName, rows: [{ row: rowB.row, values: { ...rowB2, note: "越权改别人的行" } }] },
    })
    const selfEntries = (await listOf(SELF)).entries
    const rej = selfEntries.find(e => e.kind === "reject")
    check("越权保存被拒（400）", rejected.status === 400, `HTTP ${rejected.status} ${JSON.stringify(rejected.json)}`)
    check(
      "被拒的保存留了一条 reject（含试图改哪几行 + 原因）",
      rej?.rows?.includes(rowB.row) && String(rej.reason).includes("不是你的记录"),
      JSON.stringify(rej),
    )

    /* --- 6. 可见范围 --- */
    check("访客看不到改动记录", (await req("/api/changes")).status === 403)
    const ownerView = await listOf(OWNER)
    /** 到这一步为止：第 1 步 1 条、第 3 步 1 条、第 4 步 1 条、第 5 步 1 条 reject（第 2 步不该有） */
    check("管理员看到的是全部（all=true）", ownerView.all === true && ownerView.entries.length >= 4, JSON.stringify({ all: ownerView.all, n: ownerView.entries.length }))
    check("本人看到的是自己相关的（all=false）", (await listOf(SELF)).all === false)
    check(
      "本人看不到与自己无关的那些记录",
      !selfEntries.some(e => e.qq === OWNER.qq && e.row !== rowA.row),
      JSON.stringify(selfEntries.map(e => [e.kind, e.qq, e.row])),
    )
    const otherEntries = (await listOf(OTHER)).entries
    check(
      "别人改了我的行 ⇒ 我看得见（`hitsMine` 那条路）",
      otherEntries.some(e => e.qq === OWNER.qq && e.row === rowB.row),
      JSON.stringify(otherEntries.map(e => [e.kind, e.qq, e.row])),
    )

    /* --- 7. 改名连带：改的是**别人的行**，要标出来（不能记成"用户动了别人的行"） --- */
    const rowB3 = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows.find(r => r.row === rowB.row)
    await req("/api/save", { who: OWNER, body: { sheet: sheetName, rows: [{ row: rowB.row, values: { ...rowB3, status: SELF.nick } }] } })
    /** 新名字也要唯一：重名会被校验拦掉（"昵称与表格第 N 行重复"），那就验不到改名连带 */
    let newNick = `${SELF.nick}改`
    while (count.has(newNick)) newNick += "改"
    const renamed = await req("/api/save", {
      who: SELF,
      body: { sheet: sheetName, rows: [{ row: rowA.row, values: { ...selfSheet.rows[0], note: "本人改的", nickname: newNick } }] },
    })
    const afterRename = (await listOf(OWNER)).entries
    const cascade = afterRename.find(e => e.via === "改名连带" && e.row === rowB.row)
    check("本人改名成功", renamed.json.ok === true, JSON.stringify(renamed.json))
    check(
      "改名连带写到别人那一行时标了 via=改名连带（不是记成用户改的）",
      cascade?.changes?.status?.[1] === newNick,
      JSON.stringify(afterRename.filter(e => e.row === rowB.row).slice(0, 3)),
    )

    /* --- 8. 退群删行也要留痕（"我那行怎么没了"必须有据可查） --- */
    /**
     * 推名单这条用的是 `signedEditorQuery` 拼好的完整 query（里面已经有 `k=` 与 `w/ws`），
     * 所以不能走上面那个 `req`（它会再拼一个 `?`）——这里直接发一次。
     */
    const query = signedEditorQuery({ qq: ROSTER.qq, nick: ROSTER.nick, token: TOKEN, signKey: SIGN_KEY })
    const pushRes = await fetch(`http://127.0.0.1:${ed.port}/api/roster?${query}`, {
      method: "POST",
      headers: { ...jarOf(ROSTER).headers, "content-type": "application/json" },
      body: JSON.stringify({ group: "123456", members: [{ qq: OTHER.qq, nick: OTHER.nick }] }),
    })
    jarOf(ROSTER).take(pushRes)
    const pushed = { status: pushRes.status, json: await pushRes.json() }
    const removes = (await listOf(OWNER)).entries.filter(e => e.kind === "remove")
    /**
     * 同一个人可能在三张榜里都有行：`/api/data` 的 `syncIdentity` 会给**每一榜**唯一同名的那一行
     * 记下 QQ 绑定（「首次按昵称认出来 → 记下绑定」），所以退群删行删掉几行是正常的。
     * 这里只钉"这一榜这一行"那一条。
     */
    const mineRemove = (await listOf(SELF)).entries.find(e => e.kind === "remove" && e.sheet === sheetName && e.row === rowA.row)
    const target = removes.find(e => e.sheet === sheetName && e.row === rowA.row)
    check("名单推送成功且认出了退群", pushed.json.ok === true && pushed.json.removed >= 1, JSON.stringify(pushed.json))
    check(
      "退群删行留了一条 remove（记的是被删那一行的人与昵称）",
      target?.qq === SELF.qq && target?.nick === newNick,
      JSON.stringify(removes),
    )
    check("本人看得到自己的行被删（qq 匹配那条路）", mineRemove?.qq === SELF.qq, JSON.stringify(mineRemove))
  } finally {
    ed.child.kill()
    await wait(400)
  }
  return failed
}

try {
  console.log("模块层：")
  moduleCases()
  console.log("端到端：")
  await runE2E()
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 改动记录 验证失败 ${failed} 项` : "\n✅ 改动记录 验证通过")
process.exitCode = failed ? 1 : 0
