/**
 * `POST /api/tidy`：每日整理（已完成前移 / 排队中后移，「等待开启」当挡位不动）
 *
 * 验收的是"整理完之后表还是那张表、而且不该动的时候一个字都不写"：
 *   - **段内稳定分区**：同一段里已完成（完成情况写了人：主播名 / 本人昵称）的在前、排队中的在后，
 *     同类之间保持原有先后（谁先排的不能被搅乱）；段与段之间被「等待开启」那一行切开、互不跨越；
 *   - **「等待开启」原地不动**：内容、行号都不动（它是挡位，不是待排的人）；
 *   - **空行不参与也不动**：没有群昵称的行不会被填内容、也不会被搬走（不然会凭空出现空档）；
 *   - **行号一个都不变**：行数不变、A 列序号（`=ROW()-k`）的缓存值逐行不动——整理只换内容；
 *   - **数据不丢不重**：整榜内容与整理前是同一个多重集合，只是换了位置；
 *   - **归属跟搬**：绑定与完成情况锁里的行号按"哪一行的人去了哪一行"重排；
 *   - **已经有序 ⇒ 一个字都不写**：第二次调 `moved: 0`，表文件哈希与版本目录都不变（维护者要求）；
 *   - **权限**：机器人身份与主人放行，本人与访客 403（且表不动）。
 *
 * 用仓库里的空模板起步（结构齐全、没有成员），不依赖真实表格。
 */
import fs from "node:fs"
import crypto from "node:crypto"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("每日整理（tidy）")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过每日整理套件`)
  process.exit(0)
}

const ws = makeWorkspace("tidy")
const TOKEN = "tidy-token"
const SIGN_KEY = "tidy-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
const ADMIN = { qq: "424243", nick: "白名单管理员" }
const MEMBER = { qq: "20001", nick: "甲" }
/** 机器人身份（`model/roster.js` 的 ROSTER_QQ）：插件每天就是这么调的 */
const BOT = { qq: "0", nick: "每日整理" }
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [ADMIN.qq] }), "utf8")

const SHEET = "幽境危战"
const QUEUED = "排队中"
const WAITING = "等待开启"

const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const dirCount = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0)

const { Table } = await shared("model/table.js")
const table = new Table({ file: ws.fixture, backup: false })
const bootModel = await table.read(({ models }) => models.get(SHEET))
const ds = bootModel.dataStart
const [r1, r2, r3, r4, r5, r6, r7] = [ds, ds + 1, ds + 2, ds + 3, ds + 4, ds + 5, ds + 6]
const anchor = (bootModel.options?.anchor ?? [])[0] ?? "都可以"
const goal = (bootModel.options?.goal ?? [])[0] ?? ""
const strength = (bootModel.options?.strength ?? [])[0] ?? "中配"
/**
 * 完成情况里写"人"的两种写法：**主播名**（乙那行）、**该行自己的群昵称**（己那行 = 点过「本人已完成」）
 * 主播名取自这一版表的下拉选项本身，免得写死一个模板里没有的名字
 */
const ANCHOR_DONE = anchor
/** r4 故意留空：它要证明"空行不参与也不动" */
const rows = {
  [r1]: { qq: "30001", nick: "甲", status: QUEUED },
  [r2]: { qq: "30002", nick: "乙", status: ANCHOR_DONE },
  [r3]: { qq: "30003", nick: "丙", status: QUEUED },
  [r5]: { qq: "30005", nick: "丁", status: WAITING },
  [r6]: { qq: "30006", nick: "戊", status: QUEUED },
  [r7]: { qq: "30007", nick: "己", status: "己" },
}
await table.mutate(ctx => {
  for (const [row, p] of Object.entries(rows)) {
    ctx.setCell(SHEET, Number(row), "nickname", p.nick)
    ctx.setCell(SHEET, Number(row), "gameName", `${p.nick}的游戏名`)
    ctx.setCell(SHEET, Number(row), "anchor", anchor)
    ctx.setCell(SHEET, Number(row), "goal", goal)
    ctx.setCell(SHEET, Number(row), "strength", strength)
    /** 完成情况里写主播名要求它在主播列表里，所以那一行统一用模板第一个主播名 */
    ctx.setCell(SHEET, Number(row), "status", p.status)
    ctx.setCell(SHEET, Number(row), "note", `${p.nick}的备注`)
  }
})
const fp = await table.fingerprint()
const binds = { [SHEET]: {} }
for (const [row, p] of Object.entries(rows)) binds[SHEET][p.qq] = { row: Number(row), nickname: p.nick, at: 0 }
fs.writeFileSync(ws.bindingsFile, JSON.stringify({ version: 1, table: fp, binds }, null, 2), "utf8")
/** 乙 那一行上锁（管理员改过完成情况才会给本人上锁）：整理后锁必须跟着人走 */
fs.writeFileSync(
  ws.locksFile,
  JSON.stringify({ table: fp, rows: { [`${SHEET}#${r2}`]: { nickname: rows[r2].nick, by: "主播甲", at: 0 } } }, null, 2),
  "utf8",
)

let editor = null
try {
  editor = await startEditor({
    label: "每日整理",
    token: TOKEN,
    signKey: SIGN_KEY,
    adminsFile,
    args: ["--file", ws.fixture],
    env: {
      ABYSS_QUEUE_CONFIG: ws.cfg,
      ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
      ABYSS_EDITOR_TEST_PATHS: "1",
    },
  })

  const versionsDir = ws.file("versions")
  const load = async who => (await editor.request("/api/data", { who })).json
  const sheetOf = payload => payload.sheets.find(s => s.name === SHEET)
  const nickAt = (payload, row) => String(sheetOf(payload).rows.find(r => r.row === Number(row))?.nickname ?? "")
  const statusAt = (payload, row) => String(sheetOf(payload).rows.find(r => r.row === Number(row))?.status ?? "")
  const seqAt = (payload, row) => String(sheetOf(payload).rows.find(r => r.row === Number(row))?.seq ?? "")
  const tidy = (body = {}, who = BOT) => editor.request("/api/tidy", { who, body })

  const before = await load(OWNER)
  const seqBefore = Object.fromEntries(Object.keys(rows).map(row => [row, seqAt(before, row)]))
  const rowCountBefore = sheetOf(before).rows.length

  /* ---------------------------- 前置自检 ---------------------------- */

  await check("前置：两个段（「等待开启」在中间当挡位）、一个空行、六条记录都摆好了", () => {
    if (sheetOf(before).dataStart !== ds)
      throw new Error(`两边认出来的数据区起点不一致：表=${ds} 接口=${sheetOf(before).dataStart}`)
    for (const [row, p] of Object.entries(rows)) {
      if (nickAt(before, row) !== p.nick) throw new Error(`第 ${row} 行是「${nickAt(before, row)}」，应当是「${p.nick}」`)
      if (statusAt(before, row) !== p.status) throw new Error(`第 ${row} 行完成情况是「${statusAt(before, row)}」`)
    }
    if (nickAt(before, r4)) throw new Error(`第 ${r4} 行本该是空行，实际有「${nickAt(before, r4)}」`)
    if (sheetOf(before).rows.length !== Object.keys(rows).length)
      throw new Error(`记录数不对：${sheetOf(before).rows.length}`)
  })

  /* ---------------------------- ① 整理 ---------------------------- */

  const versionsBefore = dirCount(versionsDir)
  const first = await tidy()
  const after = await load(OWNER)
  const bindsAfter = JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8")).binds?.[SHEET] ?? {}
  const locksAfter = JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows ?? {}

  await check("机器人身份调 /api/tidy：回执说清挪了几行", () => {
    if (first.status !== 200 || !first.json.ok) throw new Error(`HTTP ${first.status} ${JSON.stringify(first.json)}`)
    /**
     * `moved` 数的是**位置变了的行数**：第一段甲↔乙互换（两行都变了位置）+ 第二段戊↔己互换 = 4 行。
     * 另外两个榜没有可排的行，回执里各给一条 reason（"一个字都没写"）。
     */
    if (first.json.moved !== 4) throw new Error(`应当挪 4 行（甲乙互换 + 戊己互换），回执是 ${JSON.stringify(first.json)}`)
    const one = (first.json.tidied ?? []).find(t => t.sheet === SHEET)
    if (!one || one.moved !== 4) throw new Error(`这个榜的回执不对：${JSON.stringify(first.json.tidied)}`)
    for (const other of (first.json.tidied ?? []).filter(t => t.sheet !== SHEET))
      if (other.moved !== 0 || !other.reason) throw new Error(`没动的榜也该有说明：${JSON.stringify(other)}`)
  })

  await check("段内「已完成」前移、「排队中」后移：同类之间保持原有先后", () => {
    /** 第一段（r1..r3）：原本 排队中/已完成/排队中 ⇒ 已完成在前，两个排队中保持甲→丙 */
    if (nickAt(after, r1) !== "乙") throw new Error(`第 ${r1} 行应当是「乙」，实际「${nickAt(after, r1)}」`)
    if (nickAt(after, r2) !== "甲") throw new Error(`第 ${r2} 行应当是「甲」，实际「${nickAt(after, r2)}」`)
    if (nickAt(after, r3) !== "丙") throw new Error(`第 ${r3} 行应当是「丙」，实际「${nickAt(after, r3)}」`)
    /** 第二段（r6..r7）：原本 排队中/已完成 ⇒ 已完成（己）前移 */
    if (nickAt(after, r6) !== "己") throw new Error(`第 ${r6} 行应当是「己」，实际「${nickAt(after, r6)}」`)
    if (nickAt(after, r7) !== "戊") throw new Error(`第 ${r7} 行应当是「戊」，实际「${nickAt(after, r7)}」`)
  })

  await check("「等待开启」当挡位：原地不动，两段之间没有互跨", () => {
    if (nickAt(after, r5) !== "丁" || statusAt(after, r5) !== WAITING)
      throw new Error(`挡位那一行被动了：${nickAt(after, r5)} / ${statusAt(after, r5)}`)
    /** 挡位以上不许出现第二段的人，以下不许出现第一段的人 */
    const top = [r1, r2, r3, r4].map(row => nickAt(after, row))
    const bottom = [r6, r7].map(row => nickAt(after, row))
    for (const n of ["戊", "己"]) if (top.includes(n)) throw new Error(`挡位以上出现了第二段的人「${n}」：${JSON.stringify(top)}`)
    for (const n of ["甲", "乙", "丙"]) if (bottom.includes(n)) throw new Error(`挡位以下出现了第一段的人「${n}」：${JSON.stringify(bottom)}`)
  })

  await check("空行不参与也不动：还是空的，也没被搬走", () => {
    if (nickAt(after, r4)) throw new Error(`第 ${r4} 行被填上了「${nickAt(after, r4)}」`)
    if (statusAt(after, r4)) throw new Error(`第 ${r4} 行的完成情况被填上了「${statusAt(after, r4)}」`)
  })

  await check("只换内容、行号一个都不变：行数不变 + A 列序号逐行不动", () => {
    if (sheetOf(after).rows.length !== rowCountBefore) throw new Error(`行数变了：${rowCountBefore} → ${sheetOf(after).rows.length}`)
    for (const row of Object.keys(rows)) {
      const now = seqAt(after, row)
      if (now !== seqBefore[row]) throw new Error(`第 ${row} 行的序号从「${seqBefore[row]}」变成了「${now}」（序号 = 位置，不该跟着人走）`)
    }
  })

  await check("数据不丢不重：整理前后是同一个多重集合", () => {
    const bag = payload => sheetOf(payload).rows.map(r => `${r.nickname}|${r.status}|${r.note}`).sort().join("\n")
    if (bag(before) !== bag(after)) throw new Error(`内容变了：\n--- 前 ---\n${bag(before)}\n--- 后 ---\n${bag(after)}`)
  })

  await check("归属跟搬：绑定与完成情况锁里的行号指着「人现在那一行」", () => {
    const yi = bindsAfter[rows[r2].qq]
    if (!yi || Number(yi.row) !== r1) throw new Error(`绑定没跟搬：${JSON.stringify(yi)}（乙应当在第 ${r1} 行）`)
    const jia = bindsAfter[rows[r1].qq]
    if (!jia || Number(jia.row) !== r2) throw new Error(`绑定没跟搬：${JSON.stringify(jia)}（甲应当在第 ${r2} 行）`)
    if (!locksAfter[`${SHEET}#${r1}`]) throw new Error(`锁没跟搬：${JSON.stringify(Object.keys(locksAfter))}（乙的锁应当落在第 ${r1} 行）`)
    if (String(locksAfter[`${SHEET}#${r1}`]?.nickname ?? "") !== rows[r2].nick)
      throw new Error(`锁上记的名字不对：${JSON.stringify(locksAfter[`${SHEET}#${r1}`])}`)
    if (locksAfter[`${SHEET}#${r2}`]) throw new Error("锁还留在旧行号上（等于锁到别人头上）")
  })

  await check("整理前留了底：多了一份历史版本（可回退）", () => {
    if (dirCount(versionsDir) <= versionsBefore) throw new Error(`没有新增历史版本：${versionsBefore} → ${dirCount(versionsDir)}`)
  })

  /* ------------------------- ② 已经有序 ⇒ 不写 ------------------------- */

  const hashAfterFirst = sha(ws.fixture)
  const versionsAfterFirst = dirCount(versionsDir)
  const second = await tidy()
  const third = await tidy({ sheet: SHEET }, OWNER)

  await check("已经是有序的 ⇒ moved: 0，且表文件与版本目录一个字都没变", async () => {
    if (second.json.moved !== 0) throw new Error(`第二次整理不该再挪：${JSON.stringify(second.json)}`)
    const one = (second.json.tidied ?? []).find(t => t.sheet === SHEET)
    if (!one?.reason) throw new Error(`没有说明"为什么没动"：${JSON.stringify(second.json.tidied)}`)
    if (sha(ws.fixture) !== hashAfterFirst) throw new Error("表文件被重写了（已经有序却还是写了一次表）")
    if (dirCount(versionsDir) !== versionsAfterFirst) throw new Error("已经有序却多存了一份历史版本")
    const data = await load(OWNER)
    if (nickAt(data, r1) !== "乙" || nickAt(data, r6) !== "己") throw new Error("第二次整理把顺序弄乱了")
  })

  await check("主人（管理口令身份）也能整理：照样是「已经有序 ⇒ 不写」", () => {
    if (third.status !== 200 || !third.json.ok) throw new Error(`HTTP ${third.status} ${JSON.stringify(third.json)}`)
    if (third.json.moved !== 0) throw new Error(`主人这一次也不该挪：${JSON.stringify(third.json)}`)
    if (sha(ws.fixture) !== hashAfterFirst) throw new Error("主人这一次把表写了一遍")
  })

  /* ----------------------------- ③ 权限 ----------------------------- */

  const hashBeforeDenied = sha(ws.fixture)
  const asMember = await tidy({}, MEMBER)
  /** 访客 = 没有身份签名（只有口令） */
  const asGuest = await editor.request("/api/tidy", { body: {}, cookies: false })

  await check("本人与访客一律 403，且表一个字没动", () => {
    if (asMember.status !== 403) throw new Error(`本人应当 403，实际 ${asMember.status} ${JSON.stringify(asMember.json)}`)
    if (asGuest.status !== 403) throw new Error(`访客应当 403，实际 ${asGuest.status} ${JSON.stringify(asGuest.json)}`)
    if (sha(ws.fixture) !== hashBeforeDenied) throw new Error("被拒的请求居然动了表")
  })

  /**
   * **机器人身份不带时间窗**也要能整理
   *
   * 插件侧的真实形状（早先的 `model/tidy.js` 就只带 `k/u/s`）：机器人这些推送没有设备可认领，
   * 所以编辑器的闸对 `ROSTER_QQ` 豁免"带身份、没窗口只认认领设备"那一条
   * （2026-10-08 复审 §2-#1：每日整理与名单同步被这条闸 410 挡死）。插件现在也带窗口了，
   * 这一条钉的是"不带窗口那一路也不许再坏"。
   */
  const botNoWindow = await editor.request("/api/tidy", { who: BOT, body: {}, windowed: false })
  await check("机器人身份不带时间窗：照旧放行（它没有设备可认领，插件老拼法也别踩雷）", () => {
    if (botNoWindow.status !== 200 || !botNoWindow.json.ok)
      throw new Error(`HTTP ${botNoWindow.status} ${JSON.stringify(botNoWindow.json)}`)
  })
} catch (err) {
  await check("套件执行", async () => {
    throw err
  })
} finally {
  if (editor) await editor.stop()
  ws.cleanup()
}

await finish()
