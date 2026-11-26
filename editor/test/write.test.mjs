/** 写表：tidy / move-row / write-queue 合并成一个套件（原文件见 git 历史） */
import fs from "node:fs"
import crypto from "node:crypto"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import { openWorkbook } from "./harness.mjs"
import { Table, wait } from "./harness.mjs"
import { createChecker } from "../../test/_helper.mjs"

const { check, finish } = createChecker("写表")

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")
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
  const anchor = (bootModel.options?.anchor ?? [])[0] ?? "公共队列"
  const goal = (bootModel.options?.goal ?? [])[0] ?? ""
  const ANCHOR_DONE = anchor
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
      /** 完成情况里写主播名要求它在主播列表里，所以那一行统一用模板第一个主播名 */
      ctx.setCell(SHEET, Number(row), "status", p.status)
      ctx.setCell(SHEET, Number(row), "note", `${p.nick}的备注`)
    }
  })
  const fp = await table.fingerprint()
  const binds = { [SHEET]: {} }
  for (const [row, p] of Object.entries(rows)) binds[SHEET][p.qq] = { row: Number(row), nickname: p.nick, at: 0 }
  fs.writeFileSync(ws.bindingsFile, JSON.stringify({ version: 1, table: fp, binds }, null, 2), "utf8")
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
      // `moved` 数的是**位置变了的行数**：三段式分组后
      if (first.json.moved !== 5) throw new Error(`应当挪 5 行，回执是 ${JSON.stringify(first.json)}`)
      const one = (first.json.tidied ?? []).find(t => t.sheet === SHEET)
      if (!one || one.moved !== 5) throw new Error(`这个榜的回执不对：${JSON.stringify(first.json.tidied)}`)
      for (const other of (first.json.tidied ?? []).filter(t => t.sheet !== SHEET))
        if (other.moved !== 0 || !other.reason) throw new Error(`没动的榜也该有说明：${JSON.stringify(other)}`)
    })
    await check("三段式：已完成最前，等待开启居中，排队中最末；完成类型本人优先", () => {
      /** 已完成：己（本人）、乙（主播） */
      if (nickAt(after, r1) !== "己") throw new Error(`第 ${r1} 行应当是「己」，实际「${nickAt(after, r1)}」`)
      if (nickAt(after, r2) !== "乙") throw new Error(`第 ${r2} 行应当是「乙」，实际「${nickAt(after, r2)}」`)
      /** 等待开启：丁 */
      if (nickAt(after, r3) !== "丁" || statusAt(after, r3) !== WAITING)
        throw new Error(`第 ${r3} 行应当是「丁/等待开启」，实际「${nickAt(after, r3)}/${statusAt(after, r3)}」`)
      /** 排队中：甲、丙、戊，保持 r1→r3→r6 的原顺序 */
      if (nickAt(after, r5) !== "甲") throw new Error(`第 ${r5} 行应当是「甲」，实际「${nickAt(after, r5)}」`)
      if (nickAt(after, r6) !== "丙") throw new Error(`第 ${r6} 行应当是「丙」，实际「${nickAt(after, r6)}」`)
      if (nickAt(after, r7) !== "戊") throw new Error(`第 ${r7} 行应当是「戊」，实际「${nickAt(after, r7)}」`)
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
      if (!yi || Number(yi.row) !== r2) throw new Error(`绑定没跟搬：${JSON.stringify(yi)}（乙应当在第 ${r2} 行）`)
      const jia = bindsAfter[rows[r1].qq]
      if (!jia || Number(jia.row) !== r5) throw new Error(`绑定没跟搬：${JSON.stringify(jia)}（甲应当在第 ${r5} 行）`)
      if (!locksAfter[`${SHEET}#${r2}`]) throw new Error(`锁没跟搬：${JSON.stringify(Object.keys(locksAfter))}（乙的锁应当落在第 ${r2} 行）`)
      if (String(locksAfter[`${SHEET}#${r2}`]?.nickname ?? "") !== rows[r2].nick)
        throw new Error(`锁上记的名字不对：${JSON.stringify(locksAfter[`${SHEET}#${r2}`])}`)
      if (locksAfter[`${SHEET}#${r1}`]) throw new Error("锁留在了旧行号上（等于锁到别人头上）")
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
      if (nickAt(data, r1) !== "己" || nickAt(data, r6) !== "丙") throw new Error("第二次整理把顺序弄乱了")
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
    // **机器人身份不带时间窗**也要能整理
    const botNoWindow = await editor.request("/api/tidy", { who: BOT, body: {}, windowed: false })
    await check("机器人身份不带时间窗：照旧放行（它没有设备可认领，插件老拼法也别踩雷）", () => {
      if (botNoWindow.status !== 200 || !botNoWindow.json.ok)
        throw new Error(`HTTP ${botNoWindow.status} ${JSON.stringify(botNoWindow.json)}`)
    })
    /* --------- ④ 改了「帮帮完成情况」⇒ 立刻生效（昵称检测 + 整理） --------- */
    // 上一节之后第一段是 乙(已完成)/甲(排队中)/丙(排队中)：把**丙**改成已完成，段内就该变成
    const rowOf = (payload, row) => sheetOf(payload).rows.find(r => r.row === Number(row))
    const saveRow = (payload, row, patch) =>
      editor.request("/api/save", {
        who: OWNER,
        body: { sheet: SHEET, rows: [{ row, values: { ...rowOf(payload, row), ...patch } }] },
      })
    const beforeInstant = await load(OWNER)
    /** 把排队中的丙（r6）改成已完成：它会从排队中组进入已完成组 */
    const movedRow = r6
    const instant = await saveRow(beforeInstant, movedRow, { status: ANCHOR_DONE })
    const afterInstant = await load(OWNER)
    await check("改完成情况的那一发保存：回执里说清整理挪了几行 + 行号搬家表", () => {
      if (instant.status !== 200 || !instant.json.ok) throw new Error(`HTTP ${instant.status} ${JSON.stringify(instant.json)}`)
      if (instant.json.tidied !== 3)
        throw new Error(`应当顺手挪 3 行（丙前移、丁下移、甲上移），回执是 ${JSON.stringify(instant.json)}`)
      const map = instant.json.rowMap ?? {}
      if (Number(map[movedRow]) !== r3 || Number(map[r3]) !== r5 || Number(map[r5]) !== r6)
        throw new Error(`行号搬家表不对（页面按它搬草稿键）：${JSON.stringify(map)}`)
    })
    await check("立刻生效：不等第二天早上，丙已进入已完成组", () => {
      if (nickAt(afterInstant, r2) !== "乙") throw new Error(`第 ${r2} 行应当是「乙」，实际「${nickAt(afterInstant, r2)}」`)
      if (nickAt(afterInstant, r3) !== "丙") throw new Error(`第 ${r3} 行应当是「丙」，实际「${nickAt(afterInstant, r3)}」`)
      if (statusAt(afterInstant, r3) !== ANCHOR_DONE) throw new Error(`丙被整理后的状态不对：${statusAt(afterInstant, r3)}`)
      if (nickAt(afterInstant, r5) !== "丁" || statusAt(afterInstant, r5) !== WAITING)
        throw new Error(`等待开启的丁应当在中段：${nickAt(afterInstant, r5)}/${statusAt(afterInstant, r5)}`)
    })
    await check("名单还没同步过：昵称检测跳过并说明原因（整理照旧做）", () => {
      const sync = instant.json.nickSync
      if (!sync) throw new Error(`回执里没有 nickSync：${JSON.stringify(instant.json)}`)
      if (!/群名单/.test(String(sync.skipped))) throw new Error(`没说清为什么跳过：${JSON.stringify(sync)}`)
      if ((sync.renamed ?? []).length || (sync.missing ?? []).length)
        throw new Error(`名单不可信时不该报改名 / 候选：${JSON.stringify(sync)}`)
    })
    await check("只改备注的那一发：不触发整理、也不做昵称检测（不白写一遍表）", async () => {
      const now = await load(OWNER)
      const out = await saveRow(now, r2, { note: "只改备注" })
      if (!out.json.ok) throw new Error(out.json.error || "保存失败")
      if (out.json.tidied || out.json.rowMap || out.json.nickSync)
        throw new Error(
          `只有完成情况变了才做那一套，这一发不该有：${JSON.stringify({ tidied: out.json.tidied, rowMap: out.json.rowMap, nickSync: out.json.nickSync })}`,
        )
      if (nickAt(await load(OWNER), r2) !== "乙") throw new Error("只改备注却把行挪了")
    })
    /* --------- ⑤ 名单可信时：改名同步 + 退群只报不删（每天那一趟才删） --------- */
    // 名单：甲改了群名片（名字对不上 ⇒ 要同步）、丙那个 QQ 不在名单里（退群候选）。
    const rosterFile = ws.file("abyss-editor-roster.json")
    const RENAMED = "甲改名"
    fs.writeFileSync(
      rosterFile,
      JSON.stringify(
        {
          group: "965272093",
          updatedAt: Date.now(),
          members: [
            { qq: rows[r1].qq, nick: RENAMED },
            { qq: rows[r2].qq, nick: "乙" },
            { qq: rows[r5].qq, nick: "丁" },
            { qq: rows[r6].qq, nick: "戊" },
            { qq: rows[r7].qq, nick: "己" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    )
    /** 再改一次完成情况（丙：已完成 → 排队中）：这一发要顺带把昵称核一遍，并按新分组重排 */
    const beforeNick = await load(OWNER)
    const nickSave = await saveRow(beforeNick, r3, { status: QUEUED })
    const afterNick = await load(OWNER)
    const bindsAfterNick = JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8")).binds?.[SHEET] ?? {}
    await check("改名：表里那一行的群昵称按名单同步过来了", () => {
      if (!nickSave.json.ok) throw new Error(nickSave.json.error || "保存失败")
      const renamed = nickSave.json.nickSync?.renamed ?? []
      const one = renamed.find(r => r.from === "甲")
      if (!one) throw new Error(`没报改名：${JSON.stringify(nickSave.json.nickSync)}`)
      if (one.nick !== RENAMED) throw new Error(`改成的名字不对：${JSON.stringify(one)}`)
      if (nickAt(afterNick, one.row) !== RENAMED)
        throw new Error(`表里第 ${one.row} 行还是「${nickAt(afterNick, one.row)}」`)
      if (String(bindsAfterNick[rows[r1].qq]?.nickname ?? "") !== RENAMED)
        throw new Error(`绑定上记的还是旧名：${JSON.stringify(bindsAfterNick[rows[r1].qq])}`)
    })
    await check("退群：只报候选、**不自动删**（删行是每天那一趟的事）", () => {
      const missing = nickSave.json.nickSync?.missing ?? []
      if (!missing.length) throw new Error(`没报退群候选：${JSON.stringify(nickSave.json.nickSync)}`)
      /** 丙那一行还在表里（这一发只报不删） */
      const still = sheetOf(afterNick).rows.find(r => r.nickname === "丙")
      if (!still) throw new Error("退群候选那一行被这一次保存删掉了（口径是「立刻只报、每天才删」）")
      if (!missing.some(m => m.nickname === "丙")) throw new Error(`候选里没有丙：${JSON.stringify(missing)}`)
      if (!/⚠|告警|missing/.test(editor.log())) throw new Error("主人没收到提醒（日志里没有那条 missing 告警）")
    })
    await check("每日兜底照旧：机器人推同一份名单时，退群那一行才被删掉", async () => {
      const pushed = await editor.request("/api/roster", {
        who: BOT,
        body: {
          group: "965272093",
          members: JSON.parse(fs.readFileSync(rosterFile, "utf8")).members,
        },
      })
      if (!pushed.json.ok) throw new Error(pushed.json.error || "名单推送失败")
      const after = await load(OWNER)
      if (sheetOf(after).rows.some(r => r.nickname === "丙")) throw new Error("每天那一趟没有把退群的行删掉")
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
})()

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")
  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过插队套件`)
    process.exit(0)
  }
  const ws = makeWorkspace("move-row")
  const TOKEN = "move-row-token"
  const SIGN_KEY = "move-row-sign-key"
  const OWNER = { qq: "424242", nick: "主人" }
  const ADMIN = { qq: "424243", nick: "白名单管理员" }
  const MEMBER = { qq: "20001", nick: "插队的人" }
  const adminsFile = ws.file("admins.json")
  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [ADMIN.qq] }), "utf8")
  const SHEET = "幽境危战"
  const QUEUED = "排队中"
  const COLUMNS = ["A", "B", "C", "D", "E", "F", "G", "H"]
  const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"))
  const rowShape = async sheet => {
    const wb = await openWorkbook(fs.readFileSync(ws.fixture))
    const xml = await wb.sheetXml(sheet)
    const rows = new Map()
    for (const m of xml.matchAll(/<row r="(\d+)"|<c r="([A-Z]+)(\d+)"/g)) {
      if (m[1] !== undefined) {
        if (!rows.has(Number(m[1]))) rows.set(Number(m[1]), new Set())
        continue
      }
      const at = Number(m[3])
      if (!rows.has(at)) rows.set(at, new Set())
      rows.get(at).add(m[2])
    }
    return rows
  }
  const { Table } = await shared("model/table.js")
  const table = new Table({ file: ws.fixture, backup: false })
  const bootModel = await table.read(({ models }) => models.get(SHEET))
  const dataStart = bootModel.dataStart
  const [rA, rB, rC, rD, rE] = [dataStart, dataStart + 1, dataStart + 2, dataStart + 3, dataStart + 4]
  const people = {
    [rA]: { qq: "30001", nick: "甲的候", status: QUEUED },
    [rB]: { qq: "30002", nick: "乙的候", status: QUEUED },
    [rC]: { qq: "30003", nick: "丙的候", status: QUEUED },
    [rD]: { qq: "30004", nick: "丁的候", status: QUEUED },
    [rE]: { qq: "30005", nick: "戊的候", status: "等待开启" },
  }
  const anchor = (bootModel.options?.anchor ?? [])[0] ?? "公共队列"
  const goal = (bootModel.options?.goal ?? [])[0] ?? ""
  await table.mutate(ctx => {
    for (const [row, p] of Object.entries(people)) {
      ctx.setCell(SHEET, Number(row), "nickname", p.nick)
      ctx.setCell(SHEET, Number(row), "gameName", `${p.nick}的游戏名`)
      ctx.setCell(SHEET, Number(row), "anchor", anchor)
      ctx.setCell(SHEET, Number(row), "goal", goal)
      ctx.setCell(SHEET, Number(row), "status", p.status)
      ctx.setCell(SHEET, Number(row), "note", `${p.nick}的备注`)
    }
  })
  const fp = await table.fingerprint()
  const binds = { [SHEET]: {} }
  for (const [row, p] of Object.entries(people)) binds[SHEET][p.qq] = { row: Number(row), nickname: p.nick, at: 0 }
  fs.writeFileSync(ws.bindingsFile, JSON.stringify({ version: 1, table: fp, binds }, null, 2), "utf8")
  fs.writeFileSync(
    ws.locksFile,
    // 两把锁：乙（留着不动，用来钉"挪别人的行不该动到我"）与丙（这条用例的主角，挪完要跟着走）
    JSON.stringify(
      {
        table: fp,
        rows: {
          [`${SHEET}#${rB}`]: { nickname: people[rB].nick, by: "主播甲", at: 0 },
          [`${SHEET}#${rC}`]: { nickname: people[rC].nick, by: "主播甲", at: 0 },
        },
      },
      null,
      2,
    ),
    "utf8",
  )
  let editor = null
  try {
    editor = await startEditor({
      label: "插队",
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
    const sheetOf = payload => payload.sheets.find(s => s.name === SHEET)
    const load = async who => (await editor.request("/api/data", { who })).json
    const rowOf = (payload, row) => sheetOf(payload).rows.find(r => r.row === Number(row))
    const nickAt = (payload, row) => rowOf(payload, row)?.nickname ?? ""
    const move = (body, who = OWNER) => editor.request("/api/move-row", { who, body })
    const version = async () => (await editor.request("/api/version")).json.version
    /* ---------- 摆数据：甲的后面排着乙、丙、丁与「等待开启」的戊 ---------- */
    const before = await load(OWNER)
    const seqBefore = sheetOf(before).rows.map(r => String(r.seq))
    const shapeBefore = await rowShape(SHEET)
    const rowCountBefore = sheetOf(before).rows.length
    /** 前置自检：这一段用例要有意义，得真有五行数据、且两两之间隔着别人 */
    check("前置：数据区里有「甲..戊」五行、第一行是「排队中」、乙丙丁戊各不相同", () => {
      if (sheetOf(before).dataStart !== dataStart)
        throw new Error(`两边认出来的数据区起点不一致：表=${dataStart} 接口=${sheetOf(before).dataStart}`)
      if (String(rowOf(before, rA)?.seq) !== "1") throw new Error(`第一行序号不是 1：${JSON.stringify(rowOf(before, rA))}`)
      for (const [row, p] of Object.entries(people)) if (nickAt(before, row) !== p.nick) throw new Error(`第 ${row} 行是「${nickAt(before, row)}」`)
    })
    /* ------------------------------ ① 挪得动 ------------------------------ */
    // 丙的锁在**起编辑器之前**就预置好了（见上面 `ws.locksFile` 那一段）：
    const beforeLocked = await load(OWNER)
    if (String(rowOf(beforeLocked, rC)?.status ?? "") !== QUEUED) throw new Error("前置：丙不是「排队中」了")
    if (!JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows?.[`${SHEET}#${rC}`])
      throw new Error("前置：丙那一行没有上锁（这条用例也就没验到东西）")
    const out1 = await move({ sheet: SHEET, row: rD, mode: "queue-front" }, ADMIN)
    // **挪完立刻同步取数**（绑定与锁直接读文件，不经过任何接口）
    const bindDoc1 = JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8"))
    const binds1 = bindDoc1.binds?.[SHEET] ?? {}
    const front1 = bindDoc1.queueFront?.[SHEET] ?? []
    const locks1 = JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows ?? {}
    const after1 = await load(OWNER)
    /** 丁自己打开页面（本人视角）：这是**会触发归属对账**的请求，放在最后，免得它把刚取到的快照盖掉 */
    const mineDing = await load({ qq: people[rD].qq, nick: people[rD].nick })
    await check("白名单管理员插队：把「丁」挪到这一榜最前面（跨过甲、乙、丙）", () => {
      if (out1.status !== 200 || !out1.json.ok) throw new Error(`HTTP ${out1.status} ${JSON.stringify(out1.json)}`)
      if (out1.json.moved !== true) throw new Error(`没有挪动：${JSON.stringify(out1.json)}`)
      if (Number(out1.json.from) !== rD || Number(out1.json.to) !== rA)
        throw new Error(`挪到了别的地方：${JSON.stringify(out1.json)}`)
      /** 回话用的“第几位”取 A 列序号，不取表格行号 */
      if (Number(out1.json.fromSeq) !== 4 || Number(out1.json.toSeq) !== 1)
        throw new Error(`回执的序号不对：${JSON.stringify(out1.json)}`)
      if (out1.json.nickname !== people[rD].nick || out1.json.crossed !== people[rA].nick)
        throw new Error(`回执里的人名不对：${JSON.stringify(out1.json)}`)
      if (nickAt(after1, rA) !== people[rD].nick) throw new Error(`第 ${rA} 行现在是「${nickAt(after1, rA)}」`)
      if (nickAt(after1, rB) !== people[rA].nick) throw new Error(`第 ${rB} 行现在是「${nickAt(after1, rB)}」`)
      if (nickAt(after1, rC) !== people[rB].nick) throw new Error(`第 ${rC} 行现在是「${nickAt(after1, rC)}」`)
      if (nickAt(after1, rD) !== people[rC].nick) throw new Error(`第 ${rD} 行现在是「${nickAt(after1, rD)}」`)
      if (front1[0] !== people[rD].nick) throw new Error(`插队置顶没有落盘：${JSON.stringify(front1)}`)
    })
    await check("挪行之后：无空行 / 无缺行（数据区的行号与列一个不缺）", async () => {
      const sheet = sheetOf(after1)
      if (sheet.rows.length !== rowCountBefore) throw new Error(`行数变了：${rowCountBefore} → ${sheet.rows.length}`)
      /** 一根行号轴：从 dataStart 到"最后一行有数据的行"逐行都在（中间不许缺） */
      const shape = await rowShape(SHEET)
      const filled = sheet.rows.map(r => r.row)
      const last = Math.max(...filled)
      for (let row = sheet.dataStart; row <= last; row++) if (!shape.has(row)) throw new Error(`第 ${row} 行整条不见了（缺行）`)
      /** 每一行原有的列一个都不能少（只有一边有值的格子被清空时最容易"挖掉列"） */
      for (const [row, cols] of shapeBefore) {
        if (row < sheet.dataStart || row > last) continue
        const now = shape.get(row) ?? new Set()
        const lost = [...cols].filter(c => !now.has(c))
        if (lost.length) throw new Error(`第 ${row} 行少了 ${lost.join("、")} 列（出现空格）`)
      }
      /** 摆过人的那几行，一行都不许空着（空行 = 人不知去向） */
      const empty = filled.map(row => ({ row, nick: nickAt(after1, row) })).filter(x => !x.nick)
      if (empty.length) throw new Error(`排队区出现了空行：第 ${empty.map(x => x.row).join("、")} 行`)
    })
    await check("挪行之后：排队区序号仍是 1..N（A 列缓存值逐行没动）", () => {
      const seqAfter = sheetOf(after1).rows.map(r => String(r.seq))
      if (JSON.stringify(seqAfter) !== JSON.stringify(seqBefore))
        throw new Error(`序号变了：${JSON.stringify(seqBefore)} → ${JSON.stringify(seqAfter)}`)
      if (!seqAfter.every((s, i) => s === String(i + 1))) throw new Error(`序号不是 1..N：${JSON.stringify(seqAfter)}`)
    })
    await check("挪行之后：内容逐行一致（只是顺序变了，一个字段都没丢）", () => {
      const lineOf = r => JSON.stringify([r.nickname, r.gameName, r.anchor, r.goal, r.note, r.status])
      /** 每个人那一整行（昵称 → 其余各列）挪前挪后必须逐字相同（完成情况那格被锁过，以锁后的基线为准） */
      const base = new Map(sheetOf(beforeLocked).rows.map(r => [r.nickname, lineOf(r)]))
      const now = new Map(sheetOf(after1).rows.map(r => [r.nickname, lineOf(r)]))
      if (base.size !== now.size) throw new Error(`人数变了：${base.size} → ${now.size}`)
      for (const [nick, line] of base)
        if (now.get(nick) !== line) throw new Error(`「${nick}」那一行的内容变了：\n前 ${line}\n后 ${now.get(nick)}`)
      /** 没参与这次轮转的「等待开启」那一行按行号原样不动 */
      const beforeAt = new Map(sheetOf(beforeLocked).rows.map(r => [r.row, JSON.stringify(r)]))
      const afterAt = new Map(sheetOf(after1).rows.map(r => [r.row, JSON.stringify(r)]))
      if (beforeAt.get(rE) !== afterAt.get(rE)) throw new Error(`不该被动的第 ${rE} 行变了`)
    })
    await check("挪行之后：绑定与锁的行号跟搬（锁上记的人与那一行现在的人仍然对得上）", () => {
      // 这次把丁从队尾挪到队首：甲、乙、丙依次后移一位，绑定与锁必须按这张映射一起搬。
      const expected = {
        [rA]: people[rD],
        [rB]: people[rA],
        [rC]: people[rB],
        [rD]: people[rC],
      }
      for (const [row, p] of Object.entries(expected)) {
        const got = Number(binds1[p.qq]?.row)
        if (got !== Number(row)) throw new Error(`「${p.nick}」的绑定指向第 ${got} 行，应在第 ${row} 行`)
        if (nickAt(after1, row) !== p.nick) throw new Error(`第 ${row} 行不是「${p.nick}」：${nickAt(after1, row)}`)
      }
      if (Number(binds1[people[rE].qq]?.row) !== rE) throw new Error(`等待开启的戊不该被挪：${JSON.stringify(binds1[people[rE].qq])}`)
      /** 每个人：界面显示谁，绑定就该指向谁（5 个人一个不落） */
      const rowByNick = new Map(sheetOf(after1).rows.map(r => [r.nickname, r.row]))
      for (const p of Object.values(people)) {
        const got = Number(binds1[p.qq]?.row)
        if (got !== rowByNick.get(p.nick)) throw new Error(`「${p.nick}」的绑定指向第 ${got} 行，界面在第 ${rowByNick.get(p.nick)} 行`)
      }
      /** 乙、丙的锁各跟着人后移一位；甲原来没有锁，别把乙的锁留在 rB */
      if (String(locks1[`${SHEET}#${rC}`]?.nickname ?? "") !== people[rB].nick)
        throw new Error(`乙的锁没跟着后移：${JSON.stringify(locks1)}`)
      if (String(locks1[`${SHEET}#${rD}`]?.nickname ?? "") !== people[rC].nick)
        throw new Error(`丙的锁没跟着后移：${JSON.stringify(locks1)}`)
      if (locks1[`${SHEET}#${rB}`]) throw new Error(`乙的锁还留在原来的行：${JSON.stringify(locks1)}`)
      /** 锁一把都没多、一把都没少（挪行只是把行号换掉，不该凭空多出/丢掉锁） */
      const lockCountBefore = Object.keys(JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows ?? {}).length
      if (Object.keys(locks1).length !== lockCountBefore)
        throw new Error(`锁的条数变了：${lockCountBefore} → ${Object.keys(locks1).length}：${JSON.stringify(locks1)}`)
      if (String(rowOf(after1, rA)?.status ?? "") !== QUEUED) throw new Error(`丁那一行的完成情况变了：${rowOf(after1, rA)?.status}`)
      /** 丁自己打开页面时，拿到的就是新位置那一行 */
      if (mineDing.perm.role !== "self") throw new Error(`丁的身份不对：${JSON.stringify(mineDing.perm)}`)
      if (Number(rowOf(mineDing, rA)?.row) !== rA)
        throw new Error(`丁自己打开页面时拿不到新位置那一行：${JSON.stringify(sheetOf(mineDing).rows)}`)
    })
    await check("再来一次：把「乙」挪到第一位（跨过甲、丁）", async () => {
      const out = await move({ sheet: SHEET, row: rC, mode: "queue-front" }, OWNER)
      if (out.status !== 200 || out.json.moved !== true) throw new Error(`没挪动：${out.status} ${JSON.stringify(out.json)}`)
      if (Number(out.json.to) !== rA || Number(out.json.toSeq) !== 1)
        throw new Error(`没挪到第一位：${JSON.stringify(out.json)}`)
      const after = await load(OWNER)
      if (nickAt(after, rA) !== people[rB].nick) throw new Error(`第一位现在是「${nickAt(after, rA)}」`)
      if (nickAt(after, rB) !== people[rD].nick) throw new Error(`第二位现在是「${nickAt(after, rB)}」`)
      if (nickAt(after, rC) !== people[rA].nick) throw new Error(`第三位现在是「${nickAt(after, rC)}」`)
      /** 行号轴与序号照旧 */
      const seqAfter = sheetOf(after).rows.map(r => String(r.seq))
      if (JSON.stringify(seqAfter) !== JSON.stringify(seqBefore)) throw new Error(`轮转把序号弄乱了：${JSON.stringify(seqAfter)}`)
    })
    /* ------------------------- ② 挪不动 / 拒绝：整表不动 ------------------------- */
    await check("本来就在最前面：原样回话、一个字节都不写", async () => {
      const after = await load(OWNER)
      const first = sheetOf(after).rows.find(r => String(r.status).trim() === QUEUED)
      const versionAt = await version()
      const out = await move({ sheet: SHEET, row: first.row, mode: "queue-front" }, OWNER)
      if (out.status !== 200 || out.json.ok !== true) throw new Error(`HTTP ${out.status} ${JSON.stringify(out.json)}`)
      if (out.json.moved !== false) throw new Error(`最前面那一行不该挪动：${JSON.stringify(out.json)}`)
      if (!String(out.json.reason ?? "").includes(QUEUED)) throw new Error(`没说清为什么没动：${JSON.stringify(out.json)}`)
      if ((await version()) !== versionAt) throw new Error("被拒的插队却改动了表")
    })
    await check("「等待开启」的人不能插队（不是排队中）：回 400 且表不动", async () => {
      const versionAt = await version()
      const out = await move({ sheet: SHEET, row: rE, mode: "queue-front" }, OWNER)
      if (out.status !== 400) throw new Error(`HTTP ${out.status} ${JSON.stringify(out.json)}`)
      if (!String(out.json.error ?? "").includes(QUEUED)) throw new Error(`报错没点明状态：${JSON.stringify(out.json)}`)
      if ((await version()) !== versionAt) throw new Error("被拒的插队却改动了表")
    })
    await check("行号不对 / 模式不对：400，且表不动", async () => {
      const versionAt = await version()
      for (const body of [
        { sheet: SHEET, row: 99999, mode: "queue-front" },
        { sheet: SHEET, row: rC, mode: "somewhere" },
        { sheet: "不存在的榜", row: rC, mode: "queue-front" },
      ]) {
        const out = await move(body, OWNER)
        if (out.status !== 400) throw new Error(`${JSON.stringify(body)} 应当 400，实际 ${out.status} ${JSON.stringify(out.json)}`)
        if (!out.json.error) throw new Error(`400 却没给原因：${JSON.stringify(out.json)}`)
      }
      if ((await version()) !== versionAt) throw new Error("被拒的插队却改动了表")
    })
    await check("权限：本人（有签名身份）与访客（只有口令）一律 403", async () => {
      const outMember = await move({ sheet: SHEET, row: rC, mode: "queue-front" }, people[rD].qq)
      if (outMember.status !== 403) throw new Error(`本人应当 403，实际 ${outMember.status} ${JSON.stringify(outMember.json)}`)
      /** 访客 = 没有身份签名（只有口令） */
      const outGuest = await editor.request("/api/move-row", {
        body: { sheet: SHEET, row: rC, mode: "queue-front" },
        cookies: false,
      })
      if (outGuest.status !== 403) throw new Error(`访客应当 403，实际 ${outGuest.status} ${JSON.stringify(outGuest.json)}`)
      /** 反面证据：白名单管理员与主人都进得去（上面两条用例已经成功，这里再确认角色判定不是"谁都被拒"） */
      const admin = await load(ADMIN)
      if (admin.perm.role !== "admin") throw new Error(`白名单管理员的角色不对：${JSON.stringify(admin.perm)}`)
    })
    // 机器人身份不带时间窗：**闸放它过去**，但插队本身仍只认白名单管理员
    await check("机器人身份不带时间窗：闸放行（403 而不是 410），插队权限照旧只给白名单管理员", async () => {
      const out = await editor.request("/api/move-row", {
        who: { qq: "0", nick: "插队" },
        windowed: false,
        body: { sheet: SHEET, row: rD, mode: "queue-front" },
      })
      if (out.status !== 403) throw new Error(`应当是 403（走到路由被判权限），实际 HTTP ${out.status} ${JSON.stringify(out.json)}`)
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
})()

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")
  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过写入口并发套件`)
    process.exit(0)
  }
  const ws = makeWorkspace("write-queue")
  const TOKEN = "write-queue-token"
  const SIGN_KEY = "write-queue-sign-key"
  const OWNER = { qq: "424242", nick: "主人" }
  const adminsFile = ws.file("admins.json")
  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
  const SLOW_MS = 1500
  const preload = ws.file("slow-replace.cjs")
  fs.writeFileSync(
    preload,
    [
      'const fsp = require("node:fs/promises")',
      "const orig = fsp.writeFile",
      "fsp.writeFile = async function (file, ...rest) {",
      '  if (String(file).includes(".replace.tmp")) await new Promise(r => setTimeout(r, Number(process.env.ABYSS_TEST_SLOW_MS || 0)))',
      "  return orig.call(this, file, ...rest)",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )
  const SHEET = "幽境危战"
  const uploadBytesWithNote = async (srcFile, outFile, row, note) => {
    fs.copyFileSync(srcFile, outFile)
    const table = new Table({ file: outFile, backup: false })
    await table.mutate(ctx => ctx.setCell(SHEET, row, "note", note))
    return fs.readFileSync(outFile)
  }
  let editor = null
  try {
    editor = await startEditor({
      label: "写入口队列",
      token: TOKEN,
      signKey: SIGN_KEY,
      adminsFile,
      args: ["--file", ws.fixture],
      env: {
        ABYSS_QUEUE_CONFIG: ws.cfg,
        ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
        ABYSS_TEST_SLOW_MS: String(SLOW_MS),
        /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
        ABYSS_EDITOR_TEST_PATHS: "1",
      },
      nodeArgs: ["--require", preload],
    })
    const payload = await editor.request("/api/data", { who: OWNER })
    const sheet = payload.json.sheets.find(s => s.name === SHEET)
    const rowA = sheet.dataStart
    const rowB = sheet.dataStart + 1
    const opts = sheet.options ?? {}
    const anchor = (opts.anchor ?? [])[0] ?? "公共队列"
    const goal = (opts.goal ?? [])[0] ?? "N5"
    /** 铺两行数据：一行给上传改、一行给并发保存改 */
    await check("准备：先在表里铺两行", async () => {
      for (const [row, nick] of [[rowA, "并发甲"], [rowB, "并发乙"]]) {
        const saved = await editor.request("/api/save", {
          who: OWNER,
          body: { sheet: SHEET, rows: [{ row, values: { nickname: nick, gameName: "游戏", anchor, goal, note: "原始备注" } }] },
        })
        if (!saved.json.ok) throw new Error(saved.json.error || `铺第 ${row} 行失败`)
      }
    })
    const readNote = async row => {
      const now = await editor.request("/api/data", { who: OWNER })
      return now.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)?.note
    }
    const rowOf = async row => {
      const now = await editor.request("/api/data", { who: OWNER })
      return now.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)
    }
    const versionNow = async () => (await editor.request("/api/version")).json.version
    await check("数据接口下发当前表版本（页面据此做乐观并发）", async () => {
      const v = (await editor.request("/api/data", { who: OWNER })).json.version
      if (!v || typeof v !== "string") throw new Error(`没有下发 version：${JSON.stringify(v)}`)
      if (v !== (await versionNow())) throw new Error("下发的版本与 /api/version 不一致")
    })
    await check("并发（都不带版本）：两个请求都成功时，两份改动都必须还在", async () => {
      const upBytes = await uploadBytesWithNote(ws.fixture, ws.file("up-a.xlsx"), rowA, "上传改的-1")
      const uploading = editor.request("/api/upload", { who: OWNER, raw: upBytes })
      await wait(400)
      const saving = editor.request("/api/save", {
        who: OWNER,
        body: { sheet: SHEET, rows: [{ row: rowB, values: { ...(await rowOf(rowB)), note: "保存改的-1" } }] },
      })
      const [up, save] = await Promise.all([uploading, saving])
      if (up.json.ok && save.json.ok) {
        const a = await readNote(rowA)
        const b = await readNote(rowB)
        if (a !== "上传改的-1") throw new Error(`上传的改动丢了：第 ${rowA} 行备注=${JSON.stringify(a)}`)
        if (b !== "保存改的-1") throw new Error(`保存的改动丢了：第 ${rowB} 行备注=${JSON.stringify(b)}`)
      } else {
        /** 被拒也必须说清楚是"冲突"，不能是含糊的失败 */
        for (const [name, r] of [["上传", up], ["保存", save]])
          if (!r.json.ok) {
            if (!/改过|冲突|版本/.test(String(r.json.error))) throw new Error(`${name} 被拒但没说清原因：${JSON.stringify(r.json)}`)
          }
      }
    })
    await check("并发（都带同一版本）：手里的版本过期那个必须被明确拒绝，不覆盖别人", async () => {
      const stale = await versionNow()
      const upBytes = await uploadBytesWithNote(ws.fixture, ws.file("up-b.xlsx"), rowA, "上传改的-2")
      const uploading = editor.request("/api/upload", { who: OWNER, raw: upBytes, params: { v: stale } })
      await wait(400)
      const row = await rowOf(rowB)
      const saving = editor.request("/api/save", {
        who: OWNER,
        body: { sheet: SHEET, rows: [{ row: rowB, values: { ...row, note: "保存改的-2" } }], version: stale },
      })
      const [up, save] = await Promise.all([uploading, saving])
      if (!up.json.ok) throw new Error(`先提交的上传不该被拒：${JSON.stringify(up.json)}`)
      if (save.json.ok) throw new Error("版本已经过期了，保存却成功了（会静默覆盖上传的改动）")
      if (save.status !== 409 || save.json.conflict !== true) throw new Error(`冲突要报清楚：HTTP ${save.status} ${JSON.stringify(save.json)}`)
      const a = await readNote(rowA)
      if (a !== "上传改的-2") throw new Error(`上传的改动没了：${JSON.stringify(a)}`)
    })
    await check("上传带错版本：直接冲突，且当前表一个字都不动", async () => {
      const before = await versionNow()
      const upBytes = await uploadBytesWithNote(ws.fixture, ws.file("up-c.xlsx"), rowA, "不该落地")
      const up = await editor.request("/api/upload", { who: OWNER, raw: upBytes, params: { v: "不是这一版" } })
      if (up.json.ok) throw new Error("带着错版本的上传竟然成功了")
      if (up.status !== 409 || up.json.conflict !== true) throw new Error(`HTTP ${up.status} ${JSON.stringify(up.json)}`)
      if ((await versionNow()) !== before) throw new Error("被拒的上传改了表")
      if ((await readNote(rowA)) === "不该落地") throw new Error("被拒的上传写进去了")
    })
    await check("保存带过期版本：冲突，且不写", async () => {
      const row = await rowOf(rowB)
      const save = await editor.request("/api/save", {
        who: OWNER,
        body: { sheet: SHEET, rows: [{ row: rowB, values: { ...row, note: "不该落地-2" } }], version: "过期版本" },
      })
      if (save.json.ok) throw new Error("带着过期版本的保存竟然成功了")
      if (save.status !== 409 || save.json.conflict !== true) throw new Error(`HTTP ${save.status} ${JSON.stringify(save.json)}`)
      if ((await readNote(rowB)) === "不该落地-2") throw new Error("被拒的保存写进去了")
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
})()

finish()
