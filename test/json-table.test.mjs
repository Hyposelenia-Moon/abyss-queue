/** `JsonTable` 读路径回归：只读不加锁，需要落盘的导入并进写串行链 */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { JsonTable } from "../model/json-table.js"
import { STATE_FORMAT, writeDoc } from "../model/queue-doc.js"
import { exportWorkbook } from "../model/doc-export.js"
import { lockFileOf, withFileLock } from "../model/file-lock.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("读路径锁")

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abyss-json-table-"))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex")

/** 最小合法文档：1 张表、1 行数据 */
const makeDoc = ({ nickname = "甲", prefill = 0 } = {}) => ({
  format: STATE_FORMAT,
  revision: 0,
  updatedAt: new Date().toISOString(),
  sheets: [
    {
      name: "测试榜",
      kind: "abyss",
      header: { A: "序号", B: "昵称", C: "游戏名", D: "主播", E: "目标", F: "备注", G: "完成情况" },
      options: {},
      prefill,
      top: [{ A: "测试榜" }],
      rows: [{ nickname }],
    },
  ],
})

/** 一致的 fixture：json 与镜像同内容，且让镜像显得更旧（常规读不会触发导入） */
async function fixture(name, { nickname = "甲" } = {}) {
  const file = path.join(dir, `${name}.json`)
  const mirror = path.join(dir, `${name}.xlsx`)
  await writeDoc(file, makeDoc({ nickname }), { backup: false })
  await fs.writeFile(mirror, await exportWorkbook(makeDoc({ nickname })))
  const old = new Date(Date.now() - 5000)
  await fs.utimes(mirror, old, old)
  return { file, mirror, table: new JsonTable({ file, mirror }) }
}

/** 把镜像做成"比文档新、内容也不同"（模拟有人用 Excel 直接改镜像） */
async function touchMirror(mirror, nickname) {
  await fs.writeFile(mirror, await exportWorkbook(makeDoc({ nickname })))
  const future = new Date(Date.now() + 5000)
  await fs.utimes(mirror, future, future)
}

const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"))

check("常规读不加锁、不写盘：别的写者占着锁也照常返回", async () => {
  const { file, table } = await fixture("plain")
  const before = await fs.readFile(file, "utf8")
  let release
  const gate = new Promise(resolve => (release = resolve))
  const holder = withFileLock(file, () => gate)
  await sleep(20)
  try {
    // 读不拿锁：锁被占着也应当立刻返回，而不是等到放锁
    const names = await Promise.race([
      table.read(({ names }) => names),
      sleep(1000).then(() => "timeout"),
    ])
    assert.notEqual(names, "timeout", "常规读不该等写锁")
    assert.deepEqual(names, ["测试榜"])
  } finally {
    release()
    await holder
  }
  assert.equal(await fs.readFile(file, "utf8"), before, "常规读不该改写文档")
  assert.equal(await fs.stat(lockFileOf(file)).then(() => true, () => false), false, "读完不该留下锁文件")
})

check("读要导回镜像时并进写串行链：锁没放出来之前不写盘", async () => {
  const { file, mirror, table } = await fixture("import-wait")
  await touchMirror(mirror, "乙")
  let release
  const gate = new Promise(resolve => (release = resolve))
  const holder = withFileLock(file, () => gate)
  await sleep(20)
  const readP = table.read(({ doc }) => doc)
  await sleep(80)
  assert.equal((await readJson(file)).sheets[0].rows[0].nickname, "甲", "锁还被别人占着时不该导入写盘")
  release()
  await holder
  const doc = await readP
  assert.equal(doc.sheets[0].rows[0].nickname, "乙", "拿到锁之后应当按镜像导入")
  assert.equal((await readJson(file)).sheets[0].rows[0].nickname, "乙", "导入结果应当落盘")
  await fs.rm(lockFileOf(file), { force: true })
})

check("指纹遇到镜像更新也走导入，且与磁盘内容同源", async () => {
  const { file, mirror, table } = await fixture("fingerprint")
  await touchMirror(mirror, "丙")
  const fp = await table.fingerprint()
  assert.equal((await readJson(file)).sheets[0].rows[0].nickname, "丙", "指纹口径要含镜像导入后的那一版")
  assert.equal(fp, sha256(await fs.readFile(file)), "指纹应当就是落盘文档的哈希")
  await fs.rm(lockFileOf(file), { force: true })
})

check("JSON 缺失时读会先自举（从镜像补出文档）", async () => {
  const { file, table } = await fixture("bootstrap")
  await fs.rm(file)
  const doc = await table.read(({ doc }) => doc)
  assert.equal(doc.sheets[0].rows[0].nickname, "甲")
  assert.equal((await readJson(file)).sheets[0].rows[0].nickname, "甲", "自举后应当有 JSON")
  await fs.rm(lockFileOf(file), { force: true })
})

check("文档与镜像都没配时，读照旧报错、指纹返回空串", async () => {
  const file = path.join(dir, "missing.json")
  const table = new JsonTable({ file })
  await assert.rejects(() => table.read(() => {}), /表格文件不存在/)
  assert.equal(await table.fingerprint(), "")
})

await finish()
await fs.rm(dir, { recursive: true, force: true })
