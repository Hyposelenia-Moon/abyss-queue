/**
 * 身份昵称为空：**不许回写昵称格**
 *
 * 现场（维护者截图确认）：某成员在云端编辑器把「群昵称」填好并保存，再打开那一格只剩
 * 灰色 placeholder「群昵称，必填」。根因是 `/api/data` 的"按 QQ 同步昵称"这一步——
 * 身份里的群名片为空时（云端群名单里没这个人，短链展开时 `nickOf` 补不出名片），
 * `locateSelf` 把"表里昵称 ≠ 空串"报成改名，调用方于是把**空串写回了昵称格**。
 *
 * 这一套钉住新口径：
 *   1. 空名片身份建行并保存昵称 → 再读一次 `/api/data`，昵称必须还在（本次修复的核心断言）；
 *   2. 非空名片改名 → 照旧同步进表（原有行为不许回退）；
 *   3. 群名单为空（或名单里没这个人）→ 不得删行、不得清昵称。
 *
 * 口径见 `modules/queue.js` 的 `locateSelf`：**身份昵称为空时不算改名**。
 *
 * 用法：node editor/test/empty-nick.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createChecker, freePort } from "../../test/_helper.mjs"
import { PLUGIN_DIR, shared } from "./plugin.mjs"
import { cookieJar } from "./harness.mjs"
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（缺真实表时也有样本可跑） */
import { SOURCE as SRC } from "./source.mjs"

/** 身份签名只有一份实现（插件 model/identity.js），编辑器也用它 */
const { signIdentity, signWindow } = await shared("model/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-empty-nick-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
/** 数据落点派生自表格所在目录（测试模式），配置里没有路径键 */
fs.writeFileSync(cfg, "default_sheet: 幻想真境剧诗\n", "utf8")

const PORT = await freePort()
const TOKEN = "empty-nick-token"
const SIGN_KEY = "empty-nick-sign-key"
/** 机器人身份（推群名单）：与 `--roster-qq` 同一个号 */
const BOT = { qq: "0", nick: "群成员名单" }
const admins = path.join(tmp, "admins.json")
/** 主人身份：用来给"名单里没有他"的靶子铺一行（本人身份只能改自己名下的行） */
const OWNER = { qq: "1000000001", nick: "测试主人" }
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

/**
 * 被测编辑器：默认工作树里那一份；`ABYSS_TEST_EDITOR_MJS` 可以换成别处的一份
 * （把"修复前的旧逻辑"复制出来跑一遍，看本套件会不会变红——见仓库外的验证脚本）。
 */
const editor = path.resolve(process.env.ABYSS_TEST_EDITOR_MJS ?? path.join(import.meta.dirname, "..", "editor.mjs"))
const child = spawn(
  process.execPath,
  [
    editor,
    /** 共用模块明确指向本套件解析出的插件根（`ABYSS_PLUGIN_DIR` 可覆盖），不靠编辑器的自定位 */
    "--plugin", PLUGIN_DIR,
    "--port", String(PORT),
    "--token", TOKEN,
    "--sign-key", SIGN_KEY,
    "--file", fixture,
    "--admins", admins,
    "--roster-qq", BOT.qq,
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
/**
 * 一台"设备"一个 cookie 罐（按 QQ 分）
 *
 * 认领那一层靠 cookie 认设备（`editor/claims.js`）：同一个人认领之后，后续请求要带上那个 cookie，
 * 否则会被当成"第二个来的人"降级成只读。所以这里按身份分罐（同一个人换昵称还是同一台设备）。
 */
const jars = new Map()
const jarOf = who => {
  const key = who ? `qq:${who.qq ?? ""}` : "(无身份)"
  if (!jars.has(key)) jars.set(key, cookieJar())
  return jars.get(key)
}
const req = async (p, { who = null, body = null } = {}) => {
  const q = [`k=${TOKEN}`]
  if (who) {
    const id = signIdentity(who, SIGN_KEY)
    q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
    /** 带身份就必须带时间窗（本阶段起没有 w/ws 的身份链接一律 410，见 editor.mjs） */
    const win = signWindow(who, SIGN_KEY)
    if (win) q.push(`w=${win.w}`, `ws=${encodeURIComponent(win.ws)}`)
  }
  const jar = jarOf(who)
  const init = { method: body ? "POST" : "GET", headers: { ...jar.headers } }
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

const SHEET = "幻想真境剧诗"
const sheetOf = async who => (await req("/api/data", { who })).json.sheets.find(s => s.name === SHEET)
const rowAt = async (row, who = null) => (await sheetOf(who)).rows.find(r => r.row === row)
/** 表里的原始值（不经界面）：管理员读一次就是表本身的样子 */
const rawNicknameAt = async row => String((await rowAt(row))?.nickname ?? "")

const checker = createChecker("身份昵称为空")
const { check } = checker

try {
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    await wait(500)
    try {
      ready = (await req("/healthz")).status === 200
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  const first = (await sheetOf()).rows[0]
  /** 空名片身份：短链展开时云端群名单里没这个人，`nickOf` 补出来的就是空串 */
  const NO_CARD = { qq: "10001", nick: "", s: "" }

  /* ---------- 1) 核心：空名片身份建行并保存昵称，再读一次昵称必须还在 ---------- */

  const WANT = "空名片成员"
  const appendRow = (await sheetOf()).rows.at(-1).row + 1
  const created = await req("/api/save", {
    who: NO_CARD,
    body: {
      sheet: SHEET,
      rows: [
        {
          row: appendRow,
          values: { nickname: WANT, gameName: "空名片测试", anchor: first.anchor, goal: first.goal, note: "空名片建行" },
        },
      ],
    },
  })
  await check("空名片身份能建新行并保存（新行不按昵称判归属）", () => {
    if (!created.json?.ok) throw new Error(`保存失败：${JSON.stringify(created.json)}`)
  })
  await check("保存后表里就是填的昵称（还没重新读）", async () => {
    const got = await rawNicknameAt(appendRow)
    if (got !== WANT) throw new Error(`表里第 ${appendRow} 行昵称＝「${got}」，期望「${WANT}」`)
  })
  /** 核心断言：**这一条必须能失败**——旧口径下第二次 /api/data 会把昵称同步成空串 */
  await check("再读一次 /api/data，昵称必须还在（身份昵称为空不许回写昵称格）", async () => {
    const again = await req("/api/data", { who: NO_CARD })
    if (again.json?.sync?.renamed) throw new Error(`空名片竟然报了改名同步：sync.renamed=${again.json.sync.renamed}`)
    const got = String(again.json?.sheets?.find(s => s.name === SHEET)?.rows?.find(r => r.row === appendRow)?.nickname ?? "")
    if (got !== WANT) throw new Error(`重新读取后昵称＝「${got}」，期望「${WANT}」（填好的昵称被清空了）`)
  })
  await check("空名片身份再读之后，表里那一格也还是填的昵称", async () => {
    const got = await rawNicknameAt(appendRow)
    if (got !== WANT) throw new Error(`表里昵称＝「${got}」`)
  })

  /* ---------- 2) 非空名片改名：照旧同步进表（原有行为不许回退） ---------- */

  const RENAMED = `${first.nickname}改名`
  await req("/api/data", { who: { qq: "10002", nick: first.nickname } })
  const didRename = await req("/api/data", { who: { qq: "10002", nick: RENAMED } })
  await check("非空名片改名：表里的群昵称照旧同步成新名片", async () => {
    const got = await rawNicknameAt(first.row)
    if (got !== RENAMED) throw new Error(`表里昵称＝「${got}」，期望「${RENAMED}」`)
    if (!(didRename.json?.sync?.renamed >= 1)) throw new Error(`没有回报改名同步：${JSON.stringify(didRename.json?.sync)}`)
  })

  /* ---------- 3) 群名单为空 / 名单里没这个人：不许删行、不许清昵称 ---------- */

  /** 这个人只用来当"名单里没有他"的靶子：先由主人铺一行、他本人认领，再等名单对账把他删掉 */
  const fillerQq = "10003"
  const FILLER_START = "名单里的靶子"
  const FILLER = "名单里没有的人"
  const fillerRow = (await sheetOf()).rows.at(-1).row + 1
  const seeded = await req("/api/save", {
    who: OWNER,
    body: {
      sheet: SHEET,
      rows: [
        {
          row: fillerRow,
          values: { nickname: FILLER_START, gameName: "靶子", anchor: first.anchor, goal: first.goal, note: "名单对账的靶子" },
        },
      ],
    },
  })
  await check("靶子那一行铺好了（主人写、本人认领）", async () => {
    if (!seeded.json?.ok) throw new Error(`铺行失败：${JSON.stringify(seeded.json)}`)
    /** 本人按昵称认领一次；之后按 QQ 认人（改名也不丢行） */
    await req("/api/data", { who: { qq: fillerQq, nick: FILLER_START } })
    await req("/api/data", { who: { qq: fillerQq, nick: FILLER } })
    const got = await rawNicknameAt(fillerRow)
    if (got !== FILLER) throw new Error(`靶子行的昵称＝「${got}」，期望「${FILLER}」`)
  })
  const rowsBefore = (await sheetOf()).rows
  /**
   * 名单包含**所有已经绑定过的号**，只少靶子那一个。
   *
   * 少写一个人都不行：按 QQ 对账是**全表**的（`reconcileRoster` 遍历绑定文件里的每一张榜），
   * 而且"首次认领"会按昵称在**三张榜**里都记下绑定 —— 漏掉谁，谁就在三张榜里各被删一行。
   */
  const WANT_REMOVED = 1

  const partial = await req("/api/roster", {
    who: BOT,
    body: {
      group: "999888",
      members: [
        { qq: NO_CARD.qq, nick: WANT },
        { qq: "10002", nick: RENAMED },
      ],
    },
  })
  await check("名单里没有靶子那一位：他的行按退群删掉并压紧", async () => {
    if (!partial.json?.ok) throw new Error(`推送失败：${JSON.stringify(partial.json)}`)
    if (partial.json.removed !== WANT_REMOVED) throw new Error(`删行数＝${partial.json.removed}，期望 ${WANT_REMOVED}`)
    const now = (await sheetOf()).rows.length
    if (now !== rowsBefore.length - WANT_REMOVED) throw new Error(`行数 ${now}，期望 ${rowsBefore.length - WANT_REMOVED}`)
  })
  await check("退群的那个人确实不在表里了", async () => {
    const rows = (await sheetOf()).rows
    if (rows.some(r => String(r.nickname ?? "").trim() === FILLER)) throw new Error(`「${FILLER}」还在表里`)
    if (!rows.some(r => String(r.nickname ?? "").trim() === RENAMED)) throw new Error(`「${RENAMED}」被误删了`)
  })
  await check("名单里有这个人时，空名片那行的昵称照旧是他填的那个", async () => {
    const row = (await sheetOf()).rows.find(r => String(r.nickname ?? "").trim() === WANT)
    if (!row) throw new Error(`表里找不到昵称「${WANT}」的那一行（被清空或被删了）`)
  })

  const beforeEmpty = (await sheetOf()).rows
  const empty = await req("/api/roster", { who: BOT, body: { group: "999888", members: [] } })
  await check("空名单被拒（防止全员被当成退群），表与昵称一个都没动", async () => {
    if (empty.status !== 400) throw new Error(`期望 400，实际 ${empty.status} ${JSON.stringify(empty.json)}`)
    const now = (await sheetOf()).rows
    if (now.length !== beforeEmpty.length) throw new Error(`行数从 ${beforeEmpty.length} 变成 ${now.length}`)
    if (!now.some(r => String(r.nickname ?? "").trim() === WANT)) throw new Error(`昵称「${WANT}」没了`)
  })

  /* ---------- 4) 空名片的人：自己填的昵称不能被后续读取清掉（首次认领路径） ---------- */

  const CLAIM = { qq: "10004", nick: "", s: "" }
  const CLAIM_NICK = "首认空名片"
  const claimRow = (await sheetOf()).rows.at(-1).row + 1
  await req("/api/save", {
    who: CLAIM,
    body: {
      sheet: SHEET,
      rows: [
        {
          row: claimRow,
          values: { nickname: CLAIM_NICK, gameName: "首认测试", anchor: first.anchor, goal: first.goal, note: "首次认领" },
        },
      ],
    },
  })
  await check("首次认领：空名片的人自己填的昵称，再读一次仍在", async () => {
    const again = await req("/api/data", { who: CLAIM })
    const rows = again.json?.sheets?.find(s => s.name === SHEET)?.rows ?? []
    /** 压紧之后行号会变；这里按昵称找，钉的是"值还在"这件事 */
    const got = rows.find(r => String(r.nickname ?? "").trim() === CLAIM_NICK)
    if (!got) throw new Error(`重新读取后表里找不到「${CLAIM_NICK}」：${JSON.stringify(rows.map(r => `${r.row}:${r.nickname}`))}`)
  })

  /** 插件侧同一口径的纯函数断言（空名片不许报改名）：只有一份实现，别让两边漂移 */
  const { buildModel } = await shared("model/schema.js")
  const { openWorkbook } = await shared("model/xlsx.js")
  const { locateSelf } = await shared("modules/queue.js")
  const wb = await openWorkbook(fs.readFileSync(fixture))
  const model = buildModel({ name: SHEET, xml: await wb.sheetXml(SHEET), shared: wb.shared })
  await check("locateSelf：身份昵称为空时不算改名（不给 renamedFrom）", () => {
    const target = model.rows.find(r => String(r.nickname ?? "").trim() === WANT)
    if (!target) throw new Error(`表里找不到「${WANT}」这一行`)
    const store = { get: () => ({ row: target.row, nickname: WANT }), qqsOf: () => [NO_CARD.qq] }
    const hit = locateSelf(model, store, SHEET, NO_CARD.qq, "")
    if (hit.row !== target.row) throw new Error(`没认到绑定那一行：row=${hit.row}`)
    if (hit.renamedFrom !== undefined) throw new Error(`空名片被报成改名：renamedFrom=${JSON.stringify(hit.renamedFrom)}`)
  })
  await check("locateSelf：非空名片改名照旧报 renamedFrom（原有行为不许回退）", () => {
    const target = model.rows.find(r => String(r.nickname ?? "").trim() === RENAMED)
    if (!target) throw new Error(`表里找不到「${RENAMED}」这一行`)
    const store = { get: () => ({ row: target.row, nickname: RENAMED }), qqsOf: () => ["10002"] }
    const hit = locateSelf(model, store, SHEET, "10002", "新名片")
    if (hit.row !== target.row) throw new Error(`没认到绑定那一行：row=${hit.row}`)
    if (hit.renamedFrom !== RENAMED) throw new Error(`renamedFrom=${JSON.stringify(hit.renamedFrom)}`)
    if (hit.nick !== "新名片") throw new Error(`nick=${JSON.stringify(hit.nick)}`)
  })
} catch (err) {
  console.log(`  ❌ 异常：${err?.message ?? err}`)
  process.exitCode = 1
} finally {
  child.kill()
  await wait(400)
  fs.rmSync(tmp, { recursive: true, force: true })
}

await checker.finish()
/** 导出给"这份代码是不是真在跑这一份实现"用：套件跑的是仓库里的编辑器与插件模块 */
export const TESTED = { plugin: PLUGIN_DIR, editor }
