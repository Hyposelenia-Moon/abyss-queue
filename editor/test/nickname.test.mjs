/** 群昵称与状态：empty-nick / status-rename 合并成一个套件（原文件见 git 历史） */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { freePort } from "../../test/_helper.mjs"
import { PLUGIN_DIR, shared } from "./plugin.mjs"
import { cookieJar } from "./harness.mjs"
import { SOURCE as SRC } from "./source.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import { createChecker } from "../../test/_helper.mjs"

const { check, finish } = createChecker("群昵称与状态")

await (async () => {
  const { signIdentity, signWindow } = await shared("model/identity.js")

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-empty-nick-"))

  const fixture = path.join(tmp, "queue.xlsx")

  fs.copyFileSync(SRC, fixture)

  const cfg = path.join(tmp, "config.yaml")

  fs.writeFileSync(cfg, "default_sheet: 幻想真境剧诗\n", "utf8")

  const PORT = await freePort()

  const TOKEN = "empty-nick-token"

  const SIGN_KEY = "empty-nick-sign-key"

  const BOT = { qq: "0", nick: "群成员名单" }

  const admins = path.join(tmp, "admins.json")

  const OWNER = { qq: "1000000001", nick: "测试主人" }

  fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

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

  const rawNicknameAt = async row => String((await rowAt(row))?.nickname ?? "")



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
          /** 第 4 段那个"首次认领"的空名片成员：**本群守卫**要求写表的人在名单里（空名片照旧算成员） */
          { qq: "10004", nick: "" },
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


  const TESTED = { plugin: PLUGIN_DIR, editor }
})()

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")


  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过昵称变更套件`)
    process.exit(0)
  }

  const ws = makeWorkspace("status-rename")

  const TOKEN = "status-rename-token"

  const SIGN_KEY = "status-rename-sign-key"

  const OWNER = { qq: "1000000001", nick: "主人" }

  const BOT = { qq: "0", nick: "群成员名单" }

  const JIA = { qq: "30001", nick: "甲旧名" }

  const YI = { qq: "30002", nick: "乙名" }

  const BING = { qq: "30003", nick: "甲旧名后缀" }

  const adminsFile = ws.file("admins.json")

  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

  const SHEET = "幽境危战"

  let editor = null

  try {
    editor = await startEditor({
      label: "昵称变更",
      token: TOKEN,
      signKey: SIGN_KEY,
      adminsFile,
      args: ["--file", ws.fixture],
      env: {
        ABYSS_QUEUE_CONFIG: ws.cfg,
        ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
        /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
        ABYSS_EDITOR_TEST_PATHS: "1",
      },
    })

    const payload = await editor.request("/api/data", { who: OWNER })
    const sheet = payload.json.sheets.find(s => s.name === SHEET)
    const R1 = sheet.dataStart
    const R2 = R1 + 1
    const R3 = R1 + 2
    const R4 = R1 + 3
    const R5 = R1 + 4
    const R6 = R1 + 5
    if (R6 > sheet.dataEnd) throw new Error(`空模板行数不够（dataEnd=${sheet.dataEnd}），套件需要调整`)
    const opts = sheet.options ?? {}
    const anchor = (opts.anchor ?? [])[0] ?? "公共队列"
    const goal = (opts.goal ?? [])[0] ?? "N5"

    const rowsOf = async (who = OWNER) => (await editor.request("/api/data", { who })).json.sheets.find(s => s.name === SHEET).rows
    const rowAt = async (row, who = OWNER) => (await rowsOf(who)).find(x => x.row === row)
    const save = (who, rows) => editor.request("/api/save", { who, body: { sheet: SHEET, rows } })
    /** 推一份群成员名单（机器人身份） */
    const pushRoster = members => editor.request("/api/roster", { who: BOT, body: { group: "999888", members } })

    /* -------------------- 准备：三个人各建一行，各绑到自己名下 -------------------- */
    await check("准备：三位群友各建一行（按 QQ 绑定）", async () => {
      const made = [
        [BING, R3, "甲旧名后缀", "游戏丙"],
        [YI, R2, "乙名", "游戏乙"],
        [JIA, R1, "甲旧名", "游戏甲"],
      ]
      for (const [who, row, nickname, gameName] of made) {
        const out = await save(who, [{ row, values: { nickname, gameName, anchor, goal } }])
        if (!out.json.ok) throw new Error(`${nickname} 建行失败：${out.json.error}`)
      }
      /** 完成情况里写上"谁完成的"：甲自己、甲+乙、丙自己（都必须是 0 行还没有的昵称之外的值，见 validateRows） */
      /**
       * 完成情况由**管理员**写（2026-10-14 起普通人自己那一行只能填「排队中」/「本人已完成」，
       * 像"谁帮我打了"这种多值 token 是主播填的动作）——这里要造的是"别人那一行里记着甲的 token"
       */
      const setStatus = [
        [R1, "甲旧名"],
        [R2, "甲旧名,乙名,甲旧名后缀"],
        [R3, "甲旧名后缀"],
      ]
      for (const [row, status] of setStatus) {
        const out = await save(OWNER, [{ row, values: { status } }])
        if (!out.json.ok) throw new Error(`第 ${row} 行写完成情况失败：${out.json.error}`)
      }
    })

    /* -------------------- ① 成员自己保存改名 -------------------- */
    await check("① 本人改名：本人那一格与「别人那一行」里记着他的 token 都换成新名", async () => {
      const out = await save(JIA, [{ row: R1, values: { nickname: "甲新名" } }])
      if (!out.json.ok) throw new Error(out.json.error)
      const r1 = await rowAt(R1)
      const r2 = await rowAt(R2)
      if (r1.nickname !== "甲新名") throw new Error(`表里昵称没改：${r1.nickname}`)
      if (r1.status !== "甲新名") throw new Error(`本人那一格没跟着改：${r1.status}`)
      if (r2.status !== "甲新名,乙名,甲旧名后缀") throw new Error(`别人那一行没跟着改（或改坏了）：${r2.status}`)
    })

    await check("① 不误伤：前缀相同的别人的名字（甲旧名后缀）一个字没动", async () => {
      const r3 = await rowAt(R3)
      if (r3.status !== "甲旧名后缀") throw new Error(`被当子串替换了：${r3.status}`)
      if (r3.nickname !== "甲旧名后缀") throw new Error(`别人那一行的昵称被动过：${r3.nickname}`)
    })

    /* -------------------- ② 管理员改某行昵称 -------------------- */
    await check("② 管理员改名：旧名换成新名（含别人那一行里的 token）", async () => {
      /** 丙的绑定在改名之后会被"昵称对不上"清掉，所以归属要在这一轮之前就已经在（下面 ⑤ 会用到这一点） */
      const out = await save(OWNER, [{ row: R3, values: { nickname: "丙新名" } }])
      if (!out.json.ok) throw new Error(out.json.error)
      const r3 = await rowAt(R3)
      const r2 = await rowAt(R2)
      if (r3.nickname !== "丙新名") throw new Error(`表里昵称没改：${r3.nickname}`)
      if (r3.status !== "丙新名") throw new Error(`本人那一格没跟着改：${r3.status}`)
      if (r2.status !== "甲新名,乙名,丙新名") throw new Error(`别人那一行没跟着改（或改坏了）：${r2.status}`)
    })

    await check("② 不误伤：别人的名字与已经改好的新名都没动", async () => {
      const r1 = await rowAt(R1)
      if (r1.status !== "甲新名") throw new Error(`甲那一格被动过：${r1.status}`)
      const r2 = await rowAt(R2)
      if (!r2.status.includes("乙名")) throw new Error(`乙的名字被动了：${r2.status}`)
    })

    /* -------------------- ③ 群名单同步改名 -------------------- */
    await check("③ 群名单改名：旧名换成新名（含别人那一行里的 token）", async () => {
      const out = await pushRoster([
        { qq: JIA.qq, nick: "甲新名" },
        { qq: YI.qq, nick: "乙新名" },
      ])
      if (!out.json.ok) throw new Error(out.json.error)
      if (out.json.renamed !== 1) throw new Error(`改名行数不对：${JSON.stringify(out.json)}`)
      const r2 = await rowAt(R2)
      if (r2.nickname !== "乙新名") throw new Error(`表里昵称没改：${r2.nickname}`)
      if (r2.status !== "甲新名,乙新名,丙新名") throw new Error(`完成情况没跟着改：${r2.status}`)
    })

    await check("③ 不误伤：别的行与主播名没动", async () => {
      const r1 = await rowAt(R1)
      const r3 = await rowAt(R3)
      if (r1.status !== "甲新名") throw new Error(`甲那一格被动过：${r1.status}`)
      if (r3.status !== "丙新名") throw new Error(`丙那一格被动过：${r3.status}`)
    })

    await check("③′ 本人打开页面时按新名片同步（syncIdentity）：完成情况一起改", async () => {
      /** 甲又改了一次名片，链接身份里带的正是新名片（`locateSelf` 会报 `renamedFrom`） */
      const data = await editor.request("/api/data", { who: { qq: JIA.qq, nick: "甲再改" } })
      if (data.status !== 200 || !Array.isArray(data.json.sheets)) throw new Error(JSON.stringify(data.json).slice(0, 300))
      if (data.json.sync?.renamed !== 1) throw new Error(`没按名片同步：${JSON.stringify(data.json.sync)}`)
      const r1 = await rowAt(R1)
      if (r1.nickname !== "甲再改") throw new Error(`表里昵称没跟着名片改：${r1.nickname}`)
      if (r1.status !== "甲再改") throw new Error(`完成情况没跟着改：${r1.status}`)
    })

    /* -------------------- ④ 榜里有两行同名：整榜不动，只说明 -------------------- */
    await check("④ 有两行同名：完成情况一个字不动，并在日志里说明", async () => {
      /** 人工改表就能造出重名（编辑器自己的保存会拒），这正是"分不清这一格写的是哪一位"那种场景 */
      const { Table } = await shared("model/table.js")
      await new Table({ file: ws.fixture, backup: false }).mutate(ctx => ctx.setCell(SHEET, R3, "nickname", "乙新名"))

      const mark = editor.log().length
      const out = await pushRoster([
        { qq: JIA.qq, nick: "甲再改" },
        { qq: YI.qq, nick: "乙再改" },
      ])
      if (!out.json.ok) throw new Error(out.json.error)
      const r2 = await rowAt(R2)
      if (r2.status !== "甲再改,乙新名,丙新名") throw new Error(`重名时不该改完成情况：${r2.status}`)
      const logged = editor.log().slice(mark)
      if (!/分不清完成情况里写的是哪一位/.test(logged)) throw new Error(`没在日志里说明：\n${logged}`)
    })

    /* -------------------- ⑤ 这一行没有可依据的绑定：只动本人那一格 -------------------- */
    await check("⑤ 没有绑定：只改本人那一格，别的行里同样的名字不动、并在回执里说明", async () => {
      /** 完成情况一改会触发整理，下面一律按昵称现查，不拿旧行号 */
      const rowByNick = async nickname => {
        const rows = await rowsOf()
        const hit = rows.find(x => String(x.nickname ?? "").trim() === nickname)
        if (!hit) throw new Error(`找不到「${nickname}」那一行：${JSON.stringify(rows.map(r => r.nickname))}`)
        return hit
      }
      /** 主人新建一行（主人身份不会建绑定），另把"无主旧名"先写进乙那一行的完成情况 */
      const made = await save(OWNER, [{ row: R4, values: { nickname: "无主旧名", gameName: "游戏丁", anchor, goal } }])
      if (!made.json.ok) throw new Error(made.json.error)
      const yi = await rowByNick("乙新名")
      const pretag = await save(OWNER, [{ row: yi.row, values: { status: "甲再改,乙新名,丙新名,无主旧名" } }])
      if (!pretag.json.ok) throw new Error(pretag.json.error)

      const ownerRow = await rowByNick("无主旧名")
      const out = await save(OWNER, [{ row: ownerRow.row, values: { nickname: "无主新名", status: "无主旧名" } }])
      if (!out.json.ok) throw new Error(out.json.error)
      const notices = JSON.stringify(out.json.notices ?? [])
      if (!/没有可依据的 QQ 绑定/.test(notices)) throw new Error(`回执里没说明：${notices}`)
      const r4 = await rowByNick("无主新名")
      if (r4.status !== "无主新名") throw new Error(`本人那一格没跟着改：${r4.status}`)
      const r2 = await rowByNick("乙新名")
      if (r2.status !== "甲再改,乙新名,丙新名,无主旧名") throw new Error(`没有绑定时不该动别人的行：${r2.status}`)
    })

    /* -------------------- ⑥ 群昵称本身就是状态词：不动（那是状态，不是人） -------------------- */
    await check("⑥ 旧昵称是固定状态词：完成情况里的那个字面值不动", async () => {
      const made = await save(OWNER, [{ row: R5, values: { nickname: "排队中", gameName: "游戏戊", anchor, goal, status: "排队中" } }])
      if (!made.json.ok) throw new Error(made.json.error)
      const out = await save(OWNER, [{ row: R5, values: { nickname: "改过名的排队中" } }])
      if (!out.json.ok) throw new Error(out.json.error)
      const r5 = await rowAt(R5)
      if (r5.nickname !== "改过名的排队中") throw new Error(`表里昵称没改：${r5.nickname}`)
      if (r5.status !== "排队中") throw new Error(`把状态词当成人改了：${r5.status}`)
    })

    /* -------------------- ⑦ 旧昵称就是主播名：不动（那是主播，不是这位群友） -------------------- */
    await check(
      "⑦ 旧昵称是主播名：完成情况里的那个 token 不动",
      async () => {
        const made = await save(OWNER, [{ row: R6, values: { nickname: anchor, gameName: "游戏己", anchor, goal, status: anchor } }])
        if (!made.json.ok) throw new Error(made.json.error)
        const out = await save(OWNER, [{ row: R6, values: { nickname: "换过名字的行" } }])
        if (!out.json.ok) throw new Error(out.json.error)
        const r6 = await rowAt(R6)
        if (r6.nickname !== "换过名字的行") throw new Error(`表里昵称没改：${r6.nickname}`)
        if (r6.status !== anchor) throw new Error(`把主播名当成人改了：${r6.status}`)
      },
      /** 模板里没有主播区时这一条没得验：明确报"没验到"，不当成通过 */
      (opts.anchor ?? []).length ? "" : "空模板里没有主播名可用",
    )

    /* -------------------- ⑧ 复合完成情况：版本前缀里的旧昵称也要跟着换 -------------------- */
    await check("⑧ 复合完成情况：`7.2旧名 7.3等待开启` 只替换人名，保留版本与等待段", async () => {
      /**
       * 空模板没有绝境攻炼；这里直接在幽境危战行上造一段枪战复合状态，
       * 专测 `statusRenamePlan` 的解析/重拼，不再受表结构限制。
       */
      const target = (await rowsOf()).find(x => String(x.nickname ?? "").trim() === "甲再改")
      if (!target) throw new Error("找不到「甲再改」那一行")
      const { Table } = await shared("model/table.js")
      await new Table({ file: ws.fixture, backup: false }).mutate(ctx =>
        ctx.setCell(SHEET, target.row, "status", `7.2${target.nickname} 7.3等待开启`),
      )
      const renamedComposite = await save(OWNER, [
        { row: target.row, values: { nickname: "甲复合新名" } },
      ])
      if (!renamedComposite.json.ok) throw new Error(`复合改名失败：${renamedComposite.json.error}`)
      const after = (await rowsOf()).find(x => String(x.nickname ?? "").trim() === "甲复合新名")
      if (!after) throw new Error("改名后找不到「甲复合新名」那一行")
      if (after.status !== "7.2甲复合新名 7.3等待开启")
        throw new Error(`复合完成情况没跟着改：${after.status}`)
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
