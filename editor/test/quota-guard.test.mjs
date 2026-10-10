/**
 * 本群守卫 + 越界额度与红线 + 私聊告警（权限分阶段放开的第 3 步）
 *
 * 分两层：
 *   - **模块层**：`editor/quota.js`（单次上限 / 窗口累计 / 过期条目 / 被拒不占额度）、
 *     `editor/roster.js` 的 `trusted` + `isMember`（空、过期、正常三种）、
 *     `editor/alert.js`（限频、强制、发送失败、没有出口）；
 *   - **真编辑器**：群外人只读且看不到别人的行；本群成员能改别人的行（额度内）；
 *     一次改 4 位被拒 + 日志里留下告警；清空别人的行 / 改别人那一行的群昵称两条红线；
 *     额度窗口累计；名单过期 ⇒ **不放权也不拒人**（退回"只能改自己那一行"）。
 *
 * 用法：node editor/test/quota-guard.test.mjs [xlsx路径]
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

const { signedEditorQuery } = await shared("model/identity.js")
const { createQuota } = await shared("editor/quota.js")
const { createRoster } = await shared("editor/roster.js")
const { createAlerts } = await shared("editor/alert.js")
const { sendOwnerAlert } = await shared("modules/editor-host.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-quota-"))
const TOKEN = "quota-token"
const SIGN_KEY = "quota-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }
/** 机器人身份（`--roster-qq` 默认 0）：推群名单 */
const BOT = { qq: "0", nick: "群成员名单" }
/** 在群里的两个人（名单里要有他们） */
const MEMBER = { qq: "5001", nick: "群里的人" }
const OTHER = { qq: "5002", nick: "另一个群友" }
/** 不在群里的那个（转发到群外 / 退群了） */
const OUTSIDER = { qq: "5003", nick: "群外人" }
/** 排在 4 位以上别人行的那一位（额度那一条要用） */
const HEAVY = { qq: "5004", nick: "手很重" }
/** 完成情况里那个"本人已完成"（表格里存的是字面值，锁与归属都认它） */
const SELF_DONE_ALT = "本人已完成"

const admins = path.join(tmp, "admins.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

let failed = 0
/**
 * 断言：`ok` 收**布尔**或**回调 / async 回调**（抛错即失败）
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
const wait = ms => new Promise(r => setTimeout(r, ms))

/* ------------------------------ 模块层 ------------------------------ */

const moduleLayer = async () => {
  const file = path.join(tmp, "quota.json")
  const quota = createQuota({ file, maxPerSave: 3, windowMs: 10 * 60 * 1000, maxPerWindow: 10 })

  check("单次超上限 ⇒ 拒（3 放行、4 不放）", quota.check("1", 3).ok === true && quota.check("1", 4).ok === false, JSON.stringify([quota.check("1", 3), quota.check("1", 4)]))
  check("被拒的尝试**不占额度**（check 不写盘）", quota.used("1") === 0 && !fs.existsSync(file))

  quota.commit("1", 3)
  quota.commit("1", 3)
  check("窗口累计 6，再要 3（=9）照旧放行", quota.check("1", 3).ok === true && quota.used("1") === 6, String(quota.used("1")))
  quota.commit("1", 3)
  check("窗口累计 9，再要 3（=12）就拒", quota.check("1", 3).ok === false && quota.used("1") === 9, String(quota.used("1")))
  check("额度按人分开算（换了个人不受影响）", quota.check("2", 3).ok === true)

  /** 过期条目不算：把窗口推到 11 分钟之后，之前那两笔都该被丢掉 */
  const far = Date.now() + 11 * 60 * 1000
  check("窗口外的旧记录不算（11 分钟后再来 ⇒ 归零）", quota.used("1", far) === 0 && quota.check("1", 3, far).ok === true, String(quota.used("1", far)))

  /** 名单守卫：空 / 过期 / 正常三种 */
  const rosterFile = path.join(tmp, "roster.json")
  const roster = createRoster({ rosterFile, store: async () => ({ get: () => null, sheetsOf: () => [] }), trustMs: 48 * 3600 * 1000 })
  check("名单一次都没推过 ⇒ 判不了（trusted=false、isMember=null）", roster.trusted() === false && roster.isMember(MEMBER.qq) === null)
  roster.saveRoster({ group: "999", members: [MEMBER, OTHER] })
  check("名单在手且新鲜 ⇒ 名单里 true、名单外 false", roster.isMember(MEMBER.qq) === true && roster.isMember(OUTSIDER.qq) === false)
  const old = JSON.parse(fs.readFileSync(rosterFile, "utf8"))
  old.updatedAt = Date.now() - 49 * 3600 * 1000
  fs.writeFileSync(rosterFile, JSON.stringify(old), "utf8")
  check("名单过期（49 小时）⇒ 判不了（**不据此拒人**）", roster.trusted() === false && roster.isMember(OUTSIDER.qq) === null, JSON.stringify(roster.loadRoster().updatedAt))
  check("名单年龄能报出来（告警文案要用）", roster.ageMs() > 48 * 3600 * 1000, String(roster.ageMs()))

  /** 告警：限频与强制 */
  const sent = []
  const alerts = createAlerts({ send: payload => sent.push(payload.text), log: () => {}, windowMs: 5 * 60 * 1000 })
  const t0 = 1_000_000
  alerts.alert({ qq: "1", nick: "甲", kind: "quota", text: "第一次", now: t0 })
  const merged = alerts.alert({ qq: "1", nick: "甲", kind: "quota", text: "第二次", now: t0 + 1000 })
  check("非强制告警在窗口内合并（第 2 次不发，只累加）", sent.length === 1 && merged.sent === false && alerts.pendingOf("1") === 1, JSON.stringify({ sent, merged }))
  alerts.alert({ qq: "1", nick: "甲", kind: "quota", text: "第三次", now: t0 + 6 * 60 * 1000 })
  check("窗口过去之后再发，并带上「第几次触发」", sent.length === 2 && sent[1].includes("第 2 次"), JSON.stringify(sent))
  alerts.alert({ qq: "2", nick: "乙", kind: "redline", text: "红线", force: true, now: t0 + 7 * 60 * 1000 })
  alerts.alert({ qq: "2", nick: "乙", kind: "redline", text: "红线又来", force: true, now: t0 + 7 * 60 * 1000 + 1 })
  check("硬红线**每次都发**（不限频）", sent.filter(x => x.includes("红线")).length === 2, JSON.stringify(sent))
  const noHook = createAlerts({ send: null, log: () => {} })
  check("没有发送出口（独立模式）⇒ 只记日志、不抛错", noHook.alert({ qq: "9", kind: "quota", text: "x" }).sent === false)
  const boom = createAlerts({ send: () => { throw new Error("框架没有 pickFriend") }, log: () => {} })
  check("发送出口抛错 ⇒ 吞掉（不影响保存判定）", boom.alert({ qq: "9", kind: "quota", text: "x" }).sent === false)

  /** 宿主侧真正发私聊那一段：`modules/editor-host.js` 的 `sendOwnerAlert` */
  const dmed = []
  const fakePick = qq => ({ sendMsg: async text => dmed.push([qq, text]) })
  const r = await sendOwnerAlert({ owners: ["1000000001", "1000000001", "1000000002"], text: "有人越界", logImpl: () => {}, pickFriend: fakePick })
  check("宿主侧：私聊每一位主人（去重）", r.sent === 2 && dmed.length === 2, JSON.stringify(dmed))
  const notFriend = await sendOwnerAlert({ owners: ["1000000001"], text: "x", logImpl: () => {}, pickFriend: () => null })
  check("宿主侧：没加机器人好友 ⇒ 记 failed、不抛错", notFriend.failed === 1 && notFriend.sent === 0, JSON.stringify(notFriend))
}

/* ------------------------------ 真编辑器 ------------------------------ */

const startEditor = async () => {
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
    /** 额度调小好验：一次 3 行、窗口 10 行（与默认一致，写出来是为了让套件的判据看得见） */
    "--roster-qq", "0",
  ]
  const env = {
    ...process.env,
    ABYSS_QUEUE_CONFIG: cfg,
    ABYSS_EDITOR_TEST_PATHS: "1",
    ABYSS_EDITOR_QUOTA_PER_SAVE: "3",
    ABYSS_EDITOR_QUOTA_PER_WINDOW: "10",
  }
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", d => (log += d))
  child.stderr.on("data", d => (log += d))
  return { port, dir, child, log: () => log }
}

const jars = new Map()
const jarOf = who => {
  const key = who ? `qq:${who.qq}` : "(无身份)"
  if (!jars.has(key)) jars.set(key, cookieJar())
  return jars.get(key)
}

const makeReq = port => async (p, { who = null, body = null, method, query = {} } = {}) => {
  const q = [`k=${TOKEN}`, ...Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)]
  if (who) {
    const id = sharedSign(who)
    q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
    if (id.w) q.push(`w=${id.w}`, `ws=${encodeURIComponent(id.ws)}`)
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

const { signIdentity, signWindow } = await shared("model/identity.js")
const sharedSign = who => {
  const id = signIdentity(who, SIGN_KEY)
  const win = signWindow(who, SIGN_KEY)
  return { ...id, w: win?.w, ws: win?.ws }
}

const runEditor = async () => {
  const ed = await startEditor()
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

    const sheet = (await req("/api/data", { who: OWNER })).json.sheets[0]
    const sheetName = sheet.name
    const options = sheet.options ?? {}
    const firstRow = sheet.rows[0]
    const anchor = firstRow.anchor || options.anchor?.[0]
    const goal = firstRow.goal || options.goal?.[0]
    const rowA = firstRow.row
    const rowB = sheet.rows[1]?.row ?? rowA + 1

    /* --- 名单还没推：判不了 ⇒ 不放权也不拒人（老口径） --- */
    const beforeRoster = await req("/api/data", { who: MEMBER })
    check(
      "名单还没推过 ⇒ 退回老口径（roam=false、不 readonly）",
      beforeRoster.json.perm.roam === false && beforeRoster.json.perm.readonly === false && beforeRoster.json.perm.outOfGroup === false,
      JSON.stringify(beforeRoster.json.perm),
    )
    check(
      "名单还没推过 ⇒ 看不到整张表（只给自己那些行）",
      (beforeRoster.json.sheets ?? []).every(s => (s.rows ?? []).every(r => String(r.nickname ?? "").trim() === MEMBER.nick)),
      JSON.stringify((beforeRoster.json.sheets ?? []).map(s => s.rows.length)),
    )
    const legacyWrite = await req("/api/save", {
      who: MEMBER,
      body: { sheet: sheetName, rows: [{ row: rowA, values: { ...firstRow, note: "老口径不许改别人的行" } }] },
    })
    check("名单还没推过 ⇒ 别人的行照旧拒（老口径）", legacyWrite.status === 400 && String(legacyWrite.json.error).includes("只能改自己那一行"), JSON.stringify(legacyWrite.json))

    /* --- 推一份名单：MEMBER / OTHER / HEAVY 在群里，OUTSIDER 不在 --- */
    const query = signedEditorQuery({ qq: BOT.qq, nick: BOT.nick, token: TOKEN, signKey: SIGN_KEY })
    const pushRes = await fetch(`http://127.0.0.1:${ed.port}/api/roster?${query}`, {
      method: "POST",
      headers: { ...jarOf(BOT).headers, "content-type": "application/json" },
      body: JSON.stringify({
        group: "999888",
        members: [
          { qq: MEMBER.qq, nick: MEMBER.nick },
          { qq: OTHER.qq, nick: OTHER.nick },
          { qq: HEAVY.qq, nick: HEAVY.nick },
        ],
      }),
    })
    jarOf(BOT).take(pushRes)
    check("前置：名单推上去了", (await pushRes.json()).ok === true, `HTTP ${pushRes.status}`)

    /* --- 本群成员：能改别人的行，也能看到整张表 --- */
    const memberView = await req("/api/data", { who: MEMBER })
    check("本群成员：roam=true（能改整表）", memberView.json.perm.roam === true, JSON.stringify(memberView.json.perm))
    const memberRows = (memberView.json.sheets ?? []).flatMap(s => (s.rows ?? []).map(r => r.row))
    check("本群成员：拿到整张表（口径 A）", memberRows.length >= sheet.rows.length, `${memberRows.length} 行`)
    const helpSave = await req("/api/save", {
      who: MEMBER,
      body: { sheet: sheetName, rows: [{ row: rowB, values: { ...(sheet.rows[1] ?? firstRow), row: rowB, note: "帮别人改的" } }] },
    })
    check("本群成员：改别人的行（额度内）⇒ 写成功", helpSave.json.ok === true, JSON.stringify(helpSave.json))

    /* --- 群外人：只读，而且看不到别人的行 --- */
    const outsiderView = await req("/api/data", { who: OUTSIDER })
    check(
      "群外人：perm 里说清 outOfGroup + readonly",
      outsiderView.json.perm.outOfGroup === true && outsiderView.json.perm.readonly === true && outsiderView.json.perm.roam === false,
      JSON.stringify(outsiderView.json.perm),
    )
    check(
      "群外人：看不到别人的行（不能白拿全表）",
      (outsiderView.json.sheets ?? []).every(s => (s.rows ?? []).every(r => String(r.nickname ?? "").trim() === OUTSIDER.nick)),
      JSON.stringify((outsiderView.json.sheets ?? []).map(s => s.rows.length)),
    )
    const outsiderSave = await req("/api/save", {
      who: OUTSIDER,
      body: { sheet: sheetName, rows: [{ row: rowA, values: { ...firstRow, note: "群外人也想改" } }] },
    })
    check("群外人：一个字都不许写", outsiderSave.status === 400 && String(outsiderSave.json.error).includes("不在本群成员名单"), JSON.stringify(outsiderSave.json))

    /* --- 硬红线①：清空别人的行 --- */
    /**
     * 清空 = **七个字段都显式给空串**（页面「删除」就是这么发的）；
     * 只给 `{}` 是"这些字段别动"（服务端会按表里现值补上），那不是清空。
     */
    const blankValues = Object.fromEntries((((await req("/api/data", { who: OWNER })).json.fields) ?? []).map(f => [f.key, ""]))
    const wipe = await req("/api/save", {
      who: MEMBER,
      body: { sheet: sheetName, rows: [{ row: rowA, values: blankValues }] },
    })
    check("红线：清空别人的行 ⇒ 拒", wipe.status === 400 && String(wipe.json.error).includes("清空"), JSON.stringify(wipe.json))
    const afterWipe = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows.find(r => r.row === rowA)
    check("红线：那一行一个字都没被清掉", String(afterWipe?.nickname ?? "").trim() === String(firstRow.nickname ?? "").trim(), JSON.stringify(afterWipe))

    /* --- 硬红线②：改别人那一行的群昵称 --- */
    const rename = await req("/api/save", {
      who: MEMBER,
      body: { sheet: sheetName, rows: [{ row: rowA, values: { ...firstRow, nickname: "我要顶掉他" } }] },
    })
    check("红线：改别人那一行的群昵称 ⇒ 拒", rename.status === 400 && String(rename.json.error).includes("群昵称"), JSON.stringify(rename.json))
    const afterRename = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows.find(r => r.row === rowA)
    check("红线：那一行的群昵称没被改掉", String(afterRename?.nickname ?? "").trim() === String(firstRow.nickname ?? "").trim(), JSON.stringify(afterRename))

    /* --- 一次改 4 位别人的行 ⇒ 超单次上限 --- */
    const live = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName)
    const four = live.rows.slice(0, 4)
    if (four.length < 4) throw new Error("这一榜不足 4 行，验不了单次上限")
    const tooMany = await req("/api/save", {
      who: HEAVY,
      body: {
        sheet: sheetName,
        rows: four.map((r, i) => ({ row: r.row, values: { ...r, note: `批量-${i}` } })),
      },
    })
    check("额度：一次改 4 位别人的行 ⇒ 拒（上限 3）", tooMany.status === 400 && String(tooMany.json.error).includes("一次最多改 3 位"), JSON.stringify(tooMany.json))
    const untouched = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows.filter(r => String(r.note ?? "").startsWith("批量-"))
    check("额度：被拒的那一次一个字都没写", untouched.length === 0, JSON.stringify(untouched))

    /* --- 窗口累计：3+3+3 放行，第 4 次（再 3 行）超 10 --- */
    /** 每次改 3 行、每次改**不同的值**，否则"没改动"的行不算写（页面也只提交改过的行） */
    const trio = liveFor => liveFor.rows.slice(0, 3).map((r, i) => ({ row: r.row, values: { ...r, note: `窗口-${Date.now()}-${i}` } }))
    let windowPass = 0
    for (let round = 0; round < 3; round++) {
      const snap = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName)
      const r = await req("/api/save", { who: HEAVY, body: { sheet: sheetName, rows: trio(snap) } })
      if (r.json.ok) windowPass++
    }
    check("额度窗口：连做 3 次（每次 3 行 = 9 行）都放行", windowPass === 3, `成功 ${windowPass} 次`)
    const snap2 = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName)
    const windowBlocked = await req("/api/save", { who: HEAVY, body: { sheet: sheetName, rows: trio(snap2) } })
    check(
      "额度窗口：第 4 次（累计 12 > 10）⇒ 拒，并说清多久多少位",
      windowBlocked.status === 400 && String(windowBlocked.json.error).includes("10 分钟") && String(windowBlocked.json.error).includes("10 位"),
      JSON.stringify(windowBlocked.json),
    )

    /* --- 告警：独立进程没有宿主出口 ⇒ 至少留下日志（宿主模式会私聊主人） --- */
    const log = ed.log()
    check("越界告警留下了日志（红线与额度各一条以上）", log.includes("越界告警") && log.includes("redline") && log.includes("quota"), log.slice(-400))

    /* --- 主播锁：**不拒**，只忽略那一格（口径没变） --- */
    /** 完成情况要写一个**下拉里有的值**：主播名就是合法的完成人（校验那关认它） */
    const doneBy = options.anchor?.[0] ?? anchor
    const lockedRow = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows[1]
    const lockSet = await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, rows: [{ row: lockedRow.row, values: { ...lockedRow, status: doneBy } }] },
    })
    check("前置：管理员改了某一行的完成情况（给它上锁）", lockSet.json.ok === true, JSON.stringify(lockSet.json))
    const rowNow = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows.find(r => r.row === lockedRow.row)
    const lockTry = await req("/api/save", {
      who: OTHER,
      body: { sheet: sheetName, rows: [{ row: lockedRow.row, values: { ...rowNow, status: SELF_DONE_ALT } }] },
    })
    check(
      "主播锁定的完成情况：照旧**忽略那一格**并回报（不是整单拒绝）",
      lockTry.json.ok === true && (lockTry.json.ignored ?? []).some(x => x.row === lockedRow.row),
      JSON.stringify(lockTry.json),
    )
    const statusNow = (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows.find(r => r.row === lockedRow.row)?.status
    check("主播锁定的那一格保住了", String(statusNow) === String(rowNow.status), `${statusNow} vs ${rowNow.status}`)

    /* --- 名单过期 ⇒ 不放权也不拒人 --- */
    /** 名单文件落在"表格旁边"（测试模式）——文件名与 `editor/config.js` 的 `FILES.roster` 一致 */
    const rosterFile = path.join(ed.dir, "abyss-editor-roster.json")
    const raw = JSON.parse(fs.readFileSync(rosterFile, "utf8"))
    raw.updatedAt = Date.now() - 49 * 3600 * 1000
    fs.writeFileSync(rosterFile, JSON.stringify(raw), "utf8")
    const staleView = await req("/api/data", { who: MEMBER })
    check(
      "名单过期 ⇒ 不放权也不拒人（roam=false、readonly=false）",
      staleView.json.perm.roam === false && staleView.json.perm.readonly === false && staleView.json.perm.outOfGroup === false,
      JSON.stringify(staleView.json.perm),
    )
    const staleWrite = await req("/api/save", {
      who: MEMBER,
      body: { sheet: sheetName, rows: [{ row: rowB, values: { ...(await (async () => (await req("/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetName).rows.find(r => r.row === rowB))()), note: "过期名单下改别人的行" } }] },
    })
    check("名单过期 ⇒ 别人的行又回到「只能改自己那一行」", staleWrite.status === 400 && String(staleWrite.json.error).includes("只能改自己那一行"), JSON.stringify(staleWrite.json))
    /** 日志是子进程 stdout 过来的，给管道一点时间再断言 */
    await wait(200)
    check("名单过期的提醒也进了日志（告警通道）", ed.log().includes("群成员名单已经"), ed.log().slice(-400))
  } finally {
    ed.child.kill()
    await wait(300)
  }
}

/* ------------------------------ 入口 ------------------------------ */

try {
  console.log("模块层：")
  await moduleLayer()
  console.log("真编辑器：")
  await runEditor()
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 本群守卫/额度/告警 验证失败 ${failed} 项` : "\n✅ 本群守卫/额度/告警 验证通过")
process.exitCode = failed ? 1 : 0
