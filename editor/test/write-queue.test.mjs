/**
 * 所有写入口共用同一条提交队列（AQ-06）
 *
 * 以前普通保存走 `Table.mutate` 的进程内队列，上传/回退却直接写临时文件再 rename，
 * 两者谁也看不见谁：让普通保存先读入旧表、再让一份上传完成、最后恢复普通保存，
 * **两个请求都返回 200/ok，上传的那条改动却没了**。
 *
 * 这里用一份"延迟 .replace.tmp 写入"的预载来固定异步顺序（只固定顺序，不改仓库源码），
 * 断言的是**不变量**而不是谁赢：
 *   - 不带版本并发：两个请求都成功 → 两份改动都必须还在（谁也别静默覆盖谁）
 *   - 带版本并发：手里版本过期的那个必须被明确拒绝（409 冲突），而不是"成功但改动消失"
 * 另外验证 /api/data 下发版本、上传带错版本会冲突。
 */
import fs from "node:fs"
import path from "node:path"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, Table, TEMPLATE, wait } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("写入口共用队列")

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

/** 只延迟整表替换的临时文件写入：把"上传正在提交"这个瞬间拉长到可以插进别的请求 */
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

/** 复制当前表并把某一行改成别的备注（模拟"拿着本地那份表上传覆盖"） */
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
    ports: [7814, 7820, 7821],
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
  const anchor = (opts.anchor ?? [])[0] ?? "都可以"
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
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在异步句柄收尾途中触发 libuv 断言崩溃 */
