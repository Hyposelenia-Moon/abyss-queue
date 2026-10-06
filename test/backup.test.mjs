/**
 * 本地备份：每次拿到云端快照就往本地写一份当日 xlsx，**只留最新一份**
 *
 * 数据以云端为准，本地这份是防手滑/防服务端事故用的；用例全部在临时目录里跑。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { ensureEnv } from "./env.mjs"
import { createChecker, requireSource } from "./_helper.mjs"

const SOURCE = await requireSource()
const { check, finish } = createChecker("本地备份")

const pad = n => String(n).padStart(2, "0")
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-backup-"))
/** 前几天那份：只留最新，应当被清掉 */
const oldName = `queue-${stamp(new Date(Date.now() - 5 * 24 * 3600 * 1000))}.xlsx`
fs.writeFileSync(path.join(backupDir, oldName), "前几天的")
/** 不是备份命名的文件：不能碰 */
fs.writeFileSync(path.join(backupDir, "别删我.txt"), "x")

/** 快照备份的落点用环境变量指到临时目录（配置里没有这个键了） */
process.env.ABYSS_QUEUE_BACKUP_DIR = backupDir
const ENV = await ensureEnv({ prefix: "abyss-backup-" })
fs.copyFileSync(SOURCE, ENV.fixture)

const { getRemote } = await import("../model/remote.js")
const remote = await getRemote()
const { models } = await remote.read(x => x)

const today = path.join(backupDir, `queue-${stamp(new Date())}.xlsx`)
const sha = buf => createHash("sha256").update(buf).digest("hex")

check("拉到云端快照后写出了当天的备份", () => {
  if (!fs.existsSync(today)) throw new Error(`没有写出 ${today}`)
  const a = sha(fs.readFileSync(today))
  const b = sha(fs.readFileSync(ENV.fixture))
  if (a !== b) throw new Error("备份内容与云端快照不一致")
})

check("备份能解析成表（不是半截文件）", () => {
  if (!models.size) throw new Error("快照解析出来没有任何表")
})

check("只留最新：前面那份被清掉", () => {
  if (fs.existsSync(path.join(backupDir, oldName))) throw new Error(`${oldName} 应该被删除`)
})

check("不是备份命名的文件不动", () => {
  if (!fs.existsSync(path.join(backupDir, "别删我.txt"))) throw new Error("误删了其它文件")
})

check("同一天再拉一次仍然只有一份", async () => {
  /** 换个 ttl 强制再拉一次：同一天应当覆盖写，不新增文件 */
  remote.ttl = 0
  remote.fetchedAt = 0
  await remote.read(x => x)
  const files = fs.readdirSync(backupDir).filter(f => /^queue-\d{4}-\d{2}-\d{2}\.xlsx$/.test(f))
  if (files.length !== 1) throw new Error(`当天备份有 ${files.length} 份：${files.join(", ")}`)
})

await finish()

/**
 * 收尾：删临时目录 + 关掉假云端，然后**让事件循环自然结束**。
 *
 * 不要用 `process.exit()` 收尾：Windows + Node 24 上，强制退出时若 undici 的异步句柄还在收尾，
 * 会命中 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`（`src\win\async.c`），
 * 进程以 0xC0000409 崩溃——断言全绿也会被 `run.mjs` 记成失败。
 * 关掉服务后没有残余句柄，自然退出即可，退出码由 `finish()` 设的 `process.exitCode` 决定。
 */
fs.rmSync(ENV.dir, { recursive: true, force: true })
await ENV.cloud.close()
