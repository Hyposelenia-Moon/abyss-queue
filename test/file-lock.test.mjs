/** 跨进程写锁回归：`queue.lock` 的派生、抢占、等待、残留接管与释放 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LOCK_STALE_MS, QueueBusyError, lockFileOf, withFileLock } from "../model/file-lock.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("跨进程写锁")

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-lock-"))
const fileOf = name => path.join(dir, `${name}.json`)
const writeHolder = (lockPath, holder) => fs.writeFileSync(lockPath, JSON.stringify(holder))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

check("锁文件按状态文档派生：queue.json → queue.lock", () => {
  const lockPath = lockFileOf(fileOf("derive"))
  assert.equal(path.basename(lockPath), "derive.lock")
  assert.equal(path.dirname(lockPath), dir)
})

check("拿锁期间锁文件在（写入自己的 pid），跑完自动删除", async () => {
  const file = fileOf("basic")
  const lockPath = lockFileOf(file)
  await withFileLock(file, async () => {
    assert.equal(fs.existsSync(lockPath), true, "拿锁后应当有锁文件")
    const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"))
    assert.equal(holder.pid, process.pid)
    assert.equal(holder.host, os.hostname())
  })
  assert.equal(fs.existsSync(lockPath), false, "跑完应当删掉锁文件")
})

check("第二次调用等第一次放锁后才进临界区", async () => {
  const file = fileOf("serialize")
  const events = []
  const first = withFileLock(file, async () => {
    events.push("first-enter")
    await sleep(80)
    events.push("first-leave")
  })
  await sleep(10)
  const second = withFileLock(file, async () => {
    events.push("second-enter")
  })
  await Promise.all([first, second])
  assert.deepEqual(events, ["first-enter", "first-leave", "second-enter"])
})

check("别的实例占着锁：等满 waitMs 抛 QueueBusy", async () => {
  const file = fileOf("busy")
  const lockPath = lockFileOf(file)
  writeHolder(lockPath, { pid: process.pid + 1, host: "another-host", at: Date.now() }) // 跨主机只看时间
  await assert.rejects(
    () => withFileLock(file, () => {}, { waitMs: 120 }),
    err => err instanceof QueueBusyError && err.code === "QUEUE_BUSY" && /另一个编辑器/.test(err.message),
  )
  fs.rmSync(lockPath, { force: true })
})

check("残留锁（同主机 pid 已死）会被接管", async () => {
  const file = fileOf("stale-pid")
  const lockPath = lockFileOf(file)
  writeHolder(lockPath, { pid: 99999999, host: os.hostname(), at: Date.now() })
  let entered = false
  await withFileLock(
    file,
    async () => {
      entered = true
      const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"))
      assert.equal(holder.pid, process.pid, "接管后锁文件应归当前进程")
    },
    { waitMs: 500 },
  )
  assert.equal(entered, true)
  assert.equal(fs.existsSync(lockPath), false)
})

check("陈旧锁（别的机器 + 超过 staleMs）也会被接管", async () => {
  const file = fileOf("stale-age")
  const lockPath = lockFileOf(file)
  writeHolder(lockPath, { pid: 1234, host: "another-host", at: Date.now() - LOCK_STALE_MS - 1000 })
  let entered = false
  await withFileLock(
    file,
    () => {
      entered = true
    },
    { waitMs: 500 },
  )
  assert.equal(entered, true)
})

check("同主机的锁拿了很久但 pid 还活着：不算残留，照旧抛 QueueBusy", async () => {
  // 真实的慢写（大表 + 慢盘）可能超过 staleMs；按年龄硬抢会变成两个写者同时写。
  const file = fileOf("live-old")
  const lockPath = lockFileOf(file)
  writeHolder(lockPath, { pid: process.pid, host: os.hostname(), at: Date.now() - LOCK_STALE_MS - 1000 })
  await assert.rejects(
    () => withFileLock(file, () => {}, { waitMs: 120 }),
    err => err instanceof QueueBusyError,
  )
  assert.equal(fs.existsSync(lockPath), true, "活着的持有者的锁不该被删")
  fs.rmSync(lockPath, { force: true })
})

check("业务抛错也会释放锁", async () => {
  const file = fileOf("throw")
  const lockPath = lockFileOf(file)
  await assert.rejects(
    () =>
      withFileLock(file, async () => {
        throw new Error("业务失败")
      }),
    /业务失败/,
  )
  assert.equal(fs.existsSync(lockPath), false, "抛错后锁文件应当已释放")
})

await finish()
fs.rmSync(dir, { recursive: true, force: true })
