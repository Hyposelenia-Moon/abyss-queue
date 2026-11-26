/** 清榜：cycle-clear / check-done 合并成一个套件（原文件见 git 历史） */
import fs from "node:fs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import { shared } from "./plugin.mjs"
import { createChecker } from "../../test/_helper.mjs"

const { check, finish } = createChecker("清榜")

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")
  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过周期清榜套件`)
    process.exit(0)
  }
  const ws = makeWorkspace("cycle-clear")
  const TOKEN = "cycle-clear-token"
  const SIGN_KEY = "cycle-clear-sign-key"
  const OWNER = { qq: "424242", nick: "主人" }
  const KEY = "幽境危战:clear:test-round"
  const SHEET = "幽境危战"
  const adminsFile = ws.file("admins.json")
  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
  const { Table } = await shared("model/table.js")
  const table = new Table({ file: ws.fixture, backup: false })
  const model = await table.read(({ models }) => models.get(SHEET))
  const ds = model.dataStart
  const seed = rows =>
    table.mutate(ctx => {
      rows.forEach(([nick, status], i) => {
        ctx.setCell(SHEET, ds + i, "nickname", nick)
        ctx.setCell(SHEET, ds + i, "gameName", `${nick}游戏`)
        ctx.setCell(SHEET, ds + i, "anchor", "公共队列")
        ctx.setCell(SHEET, ds + i, "goal", model.options.goal[0])
        ctx.setCell(SHEET, ds + i, "status", status)
      })
    })
  await seed([
    ["空状态", ""],
    ["排队", "排队中"],
    ["等待", "等待开启"],
    ["完成", "本人已完成"],
  ])
  let editor = null
  try {
    editor = await startEditor({
      label: "cycle-clear",
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
    const sheetNow = async () =>
      (await editor.request("/api/data", { who: OWNER })).json.sheets.find(s => s.name === SHEET).rows
    const currentVersion = async () => (await editor.request("/api/version", { who: OWNER })).json.version
    await check("第一次清榜：空状态/排队/完成被清，等待保留并翻排队中", async () => {
      const out = await editor.request("/api/cycle", {
        who: OWNER,
        body: {
          sheet: SHEET,
          mode: "queued-done",
          promote: "all",
          eventKey: KEY,
          version: await currentVersion(),
        },
      })
      if (!out.json.ok) throw new Error(out.json.error || "清榜失败")
      if (out.json.cleared !== 3) throw new Error(`应清 3 行，实际 ${out.json.cleared}`)
      if (out.json.promoted !== 1) throw new Error(`应翻 1 行，实际 ${out.json.promoted}`)
      const map = out.json.rowMap
      if (!map || typeof map !== "object") throw new Error("清榜回执缺 rowMap，插件无法搬本地绑定")
      if (!Object.values(map).includes(0)) throw new Error(`清掉的行没有标 0：${JSON.stringify(map)}`)
      const rows = await sheetNow()
      if (rows.length !== 1 || rows[0].nickname !== "等待" || rows[0].status !== "排队中")
        throw new Error(`等待行没有保留并翻排队中：${JSON.stringify(rows)}`)
    })
    await check("同一 eventKey 第二次：skipped，不清掉清榜后新报名", async () => {
      await seed([["新报名", "排队中"]])
      const out = await editor.request("/api/cycle", {
        who: OWNER,
        body: {
          sheet: SHEET,
          mode: "queued-done",
          promote: "all",
          eventKey: KEY,
          version: await currentVersion(),
        },
      })
      if (!out.json.ok || !out.json.skipped) throw new Error(`第二次没有 skipped：${JSON.stringify(out.json)}`)
      const rows = await sheetNow()
      if (!rows.some(r => r.nickname === "新报名")) throw new Error(`新报名被第二次清掉了：${JSON.stringify(rows)}`)
    })
    await check("归档版本过期：409 且不清表，intent 撤销", async () => {
      const oldVersion = await currentVersion()
      await seed([["版本冲突", "排队中"]])
      const out = await editor.request("/api/cycle", {
        who: OWNER,
        body: {
          sheet: SHEET,
          mode: "queued-done",
          promote: "all",
          eventKey: "幽境危战:clear:stale-version",
          version: oldVersion,
        },
      })
      if (out.status !== 409 || !out.json.conflict) throw new Error(`过期版本没有 409：${out.status} ${JSON.stringify(out.json)}`)
      const rows = await sheetNow()
      if (!rows.some(r => r.nickname === "版本冲突")) throw new Error(`版本冲突仍清了表：${JSON.stringify(rows)}`)
      const status = await editor.request("/api/cycle/status?eventKey=幽境危战%3Aclear%3Astale-version", { who: OWNER })
      if (status.json.pending) throw new Error(`写前冲突没有撤销 intent：${JSON.stringify(status.json)}`)
    })
    await check("status 查询同一 eventKey 返回 done，协议为 2", async () => {
      const out = await editor.request(`/api/cycle/status?eventKey=${encodeURIComponent(KEY)}`, { who: OWNER })
      if (!out.json.done) throw new Error(`status 没记 done：${JSON.stringify(out.json)}`)
      if (out.json.protocol !== 2) throw new Error(`status 协议不是 2：${JSON.stringify(out.json)}`)
    })
  } finally {
    await editor?.stop()
  }
  await finish()
})()

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")
  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过清榜核查套件`)
    process.exit(0)
  }
  const ws = makeWorkspace("check-done")
  const TOKEN = "check-done-token"
  const SIGN_KEY = "check-done-sign-key"
  const OWNER = { qq: "424242", nick: "主人" }
  const SHEET = "幽境危战"
  const adminsFile = ws.file("admins.json")
  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
  const { Table } = await shared("model/table.js")
  const table = new Table({ file: ws.fixture, backup: false })
  const model = await table.read(({ models }) => models.get(SHEET))
  const ds = model.dataStart
  const people = [
    ["排队甲", "排队中"],
    ["等待乙", "等待开启"],
    ["完成丙", "完成丙"],
  ]
  await table.mutate(ctx => {
    people.forEach(([nick, status], i) => {
      ctx.setCell(SHEET, ds + i, "nickname", nick)
      ctx.setCell(SHEET, ds + i, "gameName", `${nick}游戏`)
      ctx.setCell(SHEET, ds + i, "anchor", "公共队列")
      ctx.setCell(SHEET, ds + i, "goal", model.options.goal[0])
      ctx.setCell(SHEET, ds + i, "status", status)
    })
  })
  let editor = null
  try {
    editor = await startEditor({
      label: "check-done",
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
    const version = async () => (await editor.request("/api/version", { who: OWNER })).json.version
    const rows = async () => (await editor.request("/api/data", { who: OWNER })).json.sheets.find(s => s.name === SHEET).rows
    await check("只改仍排队且昵称对得上的行", async () => {
      const v = await version()
      const out = await editor.request("/api/check-done", {
        who: OWNER,
        body: {
          sheet: SHEET,
          version: v,
          rows: [
            { row: ds, nickname: "排队甲" },
            { row: ds + 1, nickname: "等待乙" },
            { row: ds + 2, nickname: "完成丙" },
            { row: ds, nickname: "别人的名字" },
          ],
        },
      })
      if (!out.json.ok) throw new Error(out.json.error || "写状态失败")
      if (out.json.updated !== 1) throw new Error(`应只改 1 行：${JSON.stringify(out.json)}`)
      const got = await rows()
      const byNick = Object.fromEntries(got.map(r => [r.nickname, r.status]))
      if (byNick["排队甲"] !== "排队甲") throw new Error(`排队甲没落成群昵称：${JSON.stringify(byNick)}`)
      if (byNick["等待乙"] !== "等待开启") throw new Error(`等待乙被改了：${JSON.stringify(byNick)}`)
      if (byNick["完成丙"] !== "完成丙") throw new Error(`完成丙被改了：${JSON.stringify(byNick)}`)
    })
    await check("版本过期：409，整批不落表", async () => {
      const old = await version()
      await table.mutate(ctx => {
        ctx.setCell(SHEET, ds, "note", "别人刚改过")
      })
      const out = await editor.request("/api/check-done", {
        who: OWNER,
        body: { sheet: SHEET, version: old, rows: [{ row: ds, nickname: "排队甲" }] },
      })
      if (out.status !== 409 || !out.json.conflict) throw new Error(`过期版本没有 409：${out.status} ${JSON.stringify(out.json)}`)
    })
  } finally {
    await editor?.stop()
  }
  await finish()
})()

finish()
