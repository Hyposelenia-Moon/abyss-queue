/**
 * 远程模型缓存：**只改 sharedStrings 也必须重建模型**（审核 AQ-09）
 *
 * xlsx 里 `t="s"` 的单元格存的是共享字符串的**下标**，文本在 `xl/sharedStrings.xml`。
 * 所以"工作表 XML 一模一样、文本却换了"完全可能（Excel/WPS 保存时很常见）。
 * 缓存键只比工作表 XML 的话，云端改了昵称/完成情况，插件会一直返回旧值——
 * 而且不是 TTL 没到期，是模型根本没重建。
 *
 * 用法：node test/remote-cache.test.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureEnv } from "./env.mjs"
import { createChecker } from "./_helper.mjs"
import { sharedItems, zipSnapshot } from "./_snapshot-xlsx.mjs"

const { check, finish } = createChecker("远程模型缓存（共享字符串）")

/** 两份快照只差共享字符串表的内容 */
const OLD = { nickname: "审核旧昵称", status: "排队中", gameName: "审核旧游戏名" }
const NEW = { nickname: "审核新昵称", status: "已完成", gameName: "审核新游戏名" }

/** 快照备份指到临时目录：套件不许碰仓库里的 data/backup（用环境变量，配置里没有这个键） */
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-cache-backup-"))
process.env.ABYSS_QUEUE_BACKUP_DIR = backupDir
const ENV = await ensureEnv({ prefix: "abyss-cache-" })

const bufOld = await zipSnapshot({ items: sharedItems(OLD) })
const bufNew = await zipSnapshot({ items: sharedItems(NEW) })

/** 工作表 XML 逐字节相同 —— 这是本套回归的前提，先钉死它，否则测的就不是"只改共享字符串" */
const JSZip = (await import("jszip")).default
const sheetXmlOf = async buf => {
  const zip = await JSZip.loadAsync(buf)
  return zip.file("xl/worksheets/sheet1.xml").async("string")
}
const SHEET_OLD = await sheetXmlOf(bufOld)
const SHEET_NEW = await sheetXmlOf(bufNew)

const { getRemote } = await import("../model/remote.js")
const remote = await getRemote()

fs.writeFileSync(ENV.fixture, bufOld)
const first = await remote.read(x => x.models.get("幽境危战"))

/** 换内容前先落后一份快照（只动 sharedStrings），再强制重拉 */
fs.writeFileSync(ENV.fixture, bufNew)
remote.ttl = 0
remote.fetchedAt = 0
const second = await remote.read(x => x.models.get("幽境危战"))

check("两份快照的工作表 XML 完全一致（前提：只有 sharedStrings 变了）", () => {
  if (SHEET_OLD !== SHEET_NEW) throw new Error("夹具本身不合格：工作表 XML 也变了")
})

check("底表：共享字符串里的昵称被解析出来（t=\"s\" 基线）", () => {
  const row = first?.rows?.[0]
  if (!row) throw new Error("合成快照没有解析出任何成员行")
  if (row.nickname !== OLD.nickname) throw new Error(`昵称应是「${OLD.nickname}」，实际「${row.nickname}」`)
  if (row.status !== OLD.status) throw new Error(`状态应是「${OLD.status}」，实际「${row.status}」`)
  if (row.gameName !== OLD.gameName) throw new Error(`游戏名应是「${OLD.gameName}」，实际「${row.gameName}」`)
})

check("只改 sharedStrings：昵称跟着变（缓存键必须含共享字符串指纹）", () => {
  const row = second?.rows?.[0]
  if (!row) throw new Error("重拉后没有解析出成员行")
  if (row.nickname !== NEW.nickname)
    throw new Error(`共享字符串已改成「${NEW.nickname}」，远程仍返回「${row.nickname}」：模型沿用了旧引用`)
})

check("只改 sharedStrings：完成情况也跟着变", () => {
  const row = second?.rows?.[0]
  if (row?.status !== NEW.status) throw new Error(`完成情况应是「${NEW.status}」，实际「${row?.status}」`)
  if (row?.gameName !== NEW.gameName) throw new Error(`游戏名应是「${NEW.gameName}」，实际「${row?.gameName}」`)
})

check("共享字符串变了就重建模型对象（不是原地改旧对象）", () => {
  if (first === second) throw new Error("还是同一个 model 引用：说明走了缓存复用分支")
})

await finish()

/**
 * 收尾后**不调 `process.exit()`**：Windows + Node 24 上，强制退出时若 undici 的异步句柄还在收尾，
 * 会命中 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`（`src\win\async.c`）导致 0xC0000409 崩溃，
 * 断言全绿也会被 `run.mjs` 记成失败。关掉假云端后没有残余句柄，自然退出即可。
 */
fs.rmSync(backupDir, { recursive: true, force: true })
fs.rmSync(ENV.dir, { recursive: true, force: true })
await ENV.cloud.close()
