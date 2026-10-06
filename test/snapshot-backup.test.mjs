/**
 * 有效备份：**解析 + 验收成功后**才更新（审核 AQ-10）
 *
 * "拿到手就备份"不行：HTTP 200 且长度够就先把当天的备份覆盖掉，再去解析。
 * 于是服务端抽风返回一个 HTML 错误页 / 坏 ZIP / 结构不对的表时，
 * 磁盘上最后一份**能恢复数据**的副本被异常响应顶掉，重启后连兜底都没了。
 *
 * 本套回归分别覆盖三种坏快照（HTML 错误页 / 损坏 ZIP / 表结构异常），断言：
 *   - 有效备份逐字节不变、仍能解析成业务模型
 *   - 异常响应另存到 backup.dir/failed/ 作诊断
 *   - 失败不清历史备份（保留策略只在成功路径跑）
 *   - 之后再来一份好快照，备份照旧原子更新
 *
 * 用法：node test/snapshot-backup.test.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { ensureEnv } from "./env.mjs"
import { createChecker, requireSource } from "./_helper.mjs"
import { headerlessSnapshot } from "./_snapshot-xlsx.mjs"

const SOURCE = await requireSource()
const { check, finish } = createChecker("有效备份不被失败快照覆盖")

const sha = buf => createHash("sha256").update(buf).digest("hex")
const pad = n => String(n).padStart(2, "0")
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-snapshot-"))
const today = path.join(backupDir, `queue-${stamp(new Date())}.xlsx`)
const failedDir = path.join(backupDir, "failed")

/** 快照备份的落点用环境变量指到临时目录（配置里没有这个键了） */
process.env.ABYSS_QUEUE_BACKUP_DIR = backupDir
const ENV = await ensureEnv({ prefix: "abyss-snapshot-" })
fs.copyFileSync(SOURCE, ENV.fixture)

const { getRemote } = await import("../model/remote.js")
const remote = await getRemote()
const first = await remote.read(x => x.models.get("幽境危战"))

/** 备份里那份"有效副本"：三种坏快照之后都应原样还在 */
const goodBytes = fs.readFileSync(today)
const goodHash = sha(goodBytes)

/** 失败过的诊断文件（按时间戳命名，比较数量即可） */
const failedFiles = () => (fs.existsSync(failedDir) ? fs.readdirSync(failedDir) : [])

/** 一份"前一天"的备份：只有成功路径才该按保留策略把它删掉 */
const staleName = `queue-${stamp(new Date(Date.now() - 5 * 24 * 3600 * 1000))}.xlsx`
fs.writeFileSync(path.join(backupDir, staleName), "前几天的备份")

/** 三种坏快照：都是 HTTP 200 且长度够，区别在"解析"这一步怎么失败 */
const cases = [
  ["HTML 错误页", Buffer.from(`<!DOCTYPE html><html><head><title>502</title></head><body>${"gateway error ".repeat(120)}</body></html>`)],
  ["短错误页（连长度都不够）", Buffer.from("<html><body>401 unauthorized</body></html>")],
  ["损坏的 ZIP", Buffer.concat([Buffer.from("PK\u0003\u0004"), randomBytes(2048)])],
  ["表结构异常（合法 ZIP、没有业务表头）", await headerlessSnapshot()],
]

const results = []
for (const [name, buf] of cases) {
  const before = failedFiles().length
  fs.writeFileSync(ENV.fixture, buf)
  remote.ttl = 0
  remote.fetchedAt = 0
  let thrown = null
  let fallback = null
  try {
    fallback = await remote.read(x => x.models.get("幽境危战"))
  } catch (err) {
    thrown = err
  }
  const after = failedFiles()
  results.push({ name, buf, thrown, fallback, newDiagnostics: after.length - before, all: after })
}

let recovered = null

check("前提：先有一份能解析的有效备份", () => {
  if (!first?.rows?.length) throw new Error("源表格没解析出成员行，套件前提不成立")
  if (!fs.existsSync(today)) throw new Error(`没有写出 ${today}`)
})

for (const r of results) {
  check(`${r.name}：有效备份逐字节不变`, () => {
    if (!fs.existsSync(today)) throw new Error("有效备份不见了")
    if (sha(fs.readFileSync(today)) !== goodHash) throw new Error("有效备份被失败快照覆盖了")
  })

  check(`${r.name}：回落到上一份可用快照（命令不报错）`, () => {
    if (r.thrown) throw new Error(`不该抛给调用方：${r.thrown.message}`)
    if (!r.fallback?.rows?.length) throw new Error("没有回落到内存里那份旧模型的成员行")
  })

  check(`${r.name}：异常响应另存诊断文件（不占有效备份的文件名）`, () => {
    if (r.newDiagnostics < 1) throw new Error(`没有在 ${failedDir} 留下诊断文件`)
    const files = r.all.filter(f => /^snapshot-\d{8}-\d{6}-\d{3}\.\w+$/.test(f))
    if (!files.length) throw new Error("诊断文件命名不符合约定，无法执行保留策略")
    const newest = files.sort().at(-1)
    const body = fs.readFileSync(path.join(failedDir, newest))
    if (sha(body) !== sha(r.buf)) throw new Error("诊断文件内容与拿到的异常响应不一致")
  })
}

check("失败路径不动有效备份，也不执行保留策略（前一天那份还在）", () => {
  if (!fs.existsSync(path.join(backupDir, staleName))) throw new Error("失败路径把历史备份删了")
})

check("有效备份本身仍能解析成业务模型（是能用来恢复的副本）", async () => {
  if (sha(fs.readFileSync(today)) !== goodHash) throw new Error("有效备份已损坏")
  /** 直接解析磁盘上那份：不经过 RemoteTable，避免"内存里还有旧模型"掩盖问题 */
  const { openWorkbook } = await import("../lib/xlsx.js")
  const { buildModel } = await import("../lib/schema.js")
  const wb = await openWorkbook(fs.readFileSync(today))
  const name = wb.sheets[0].name
  const model = buildModel({ name, xml: await wb.sheetXml(name), shared: wb.shared })
  if (!model.rows.length) throw new Error("备份解析出来没有任何成员行")
})

check("重来一份好快照：备份照旧原子更新并执行保留策略", async () => {
  fs.copyFileSync(SOURCE, ENV.fixture)
  remote.ttl = 0
  remote.fetchedAt = 0
  recovered = await remote.read(x => x.models.get("幽境危战"))
  if (!recovered?.rows?.length) throw new Error("恢复后没解析出成员行")
  if (sha(fs.readFileSync(today)) !== goodHash) throw new Error("同一天的好快照应覆盖回有效内容")
  if (fs.existsSync(path.join(backupDir, staleName))) throw new Error("成功路径应执行保留策略，把旧备份删掉")
})

check("备份目录不留临时文件（原子替换的中间产物要清干净）", () => {
  const leftovers = fs.readdirSync(backupDir).filter(f => f.includes(".tmp-"))
  if (leftovers.length) throw new Error(`残留临时文件：${leftovers.join(", ")}`)
})

check("诊断文件按份数滚动（不会无限堆积）", () => {
  const files = failedFiles().filter(f => /^snapshot-\d{8}-\d{6}-\d{3}\.\w+$/.test(f))
  if (files.length > 5) throw new Error(`诊断文件 ${files.length} 份，超过保留上限`)
})

await finish()
fs.rmSync(backupDir, { recursive: true, force: true })
fs.rmSync(ENV.dir, { recursive: true, force: true })
await ENV.cloud.close()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
