/**
 * 跨进程写锁（`queue.lock`）
 *
 * 同一台机器上可能同时跑着两个编辑器（bot 里挂的 `/queue`、外加一个独立调试实例）。
 * `JsonTable` 的串行队列只保证**单个进程内**不打架；跨进程靠这份锁文件：
 *
 *   1. 用 `O_EXCL` 创建 `<状态文档去 .json>.lock`，内容 `{pid, host, at}` —— 原子抢占；
 *   2. 抢不到时读持有者：同主机看 pid 还活不活，跨主机（网络盘）只看时间；
 *      pid 已死或超过 `staleMs` 视为残留，删掉重抢；
 *   3. 等满 `waitMs` 还抢不到就抛 `QueueBusyError`，让调用方明确告诉用户“另一个编辑器在写”。
 *
 * 锁只圈住“读文档 → 写文档 → 写镜像”这一整段，读接口（`read()` / `fingerprint()`）不拿锁。
 */
import fsp from "node:fs/promises"
import os from "node:os"

/** 锁超过这么久没更新就认为持有者已崩（同一段写表通常在秒级内完成） */
export const LOCK_STALE_MS = 2 * 60 * 1000
/** 抢占锁的默认等待上限 */
export const LOCK_WAIT_MS = 3000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 另一个编辑器正占着表 */
export class QueueBusyError extends Error {
  constructor(lockPath, holder) {
    super(`另一个编辑器正在写表（${lockPath}${holder?.pid ? `，PID ${holder.pid}` : ""}）；确认它没卡住后重试`)
    this.name = "QueueBusyError"
    this.code = "QUEUE_BUSY"
    this.holder = holder
  }
}

/** `data/queue.json` → `data/queue.lock`；其他扩展名就补一个 `.lock` */
export const lockFileOf = file => (/\.json$/i.test(file) ? file.replace(/\.json$/i, ".lock") : `${file}.lock`)

const readHolder = async lockPath => {
  try {
    const raw = JSON.parse(await fsp.readFile(lockPath, "utf8"))
    return { pid: Number(raw?.pid) || 0, host: String(raw?.host ?? ""), at: Number(raw?.at) || 0 }
  } catch {
    return null
  }
}

/** `process.kill(pid, 0)`：ESRCH = 已退出，EPERM = 还在但没权限（一样算活着） */
const pidAlive = pid => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

const isStale = (holder, staleMs) => {
  if (!holder) return true
  if (Date.now() - holder.at > staleMs) return true
  if (holder.host && holder.host !== os.hostname()) return false // 跨主机：pid 不可比，只按时间
  return !pidAlive(holder.pid)
}

const tryCreate = async lockPath => {
  const fd = await fsp.open(lockPath, "wx")
  try {
    await fd.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }))
  } finally {
    await fd.close()
  }
}

const release = async lockPath => {
  try {
    const holder = await readHolder(lockPath)
    // 只删自己的锁：被接管后别把下一个持有者的锁误删
    if (!holder || (holder.pid === process.pid && holder.host === os.hostname())) {
      await fsp.rm(lockPath, { force: true })
    }
  } catch {
    /* 释放失败留给 stale 兜底，不掩盖业务结果 */
  }
}

/**
 * 在排他锁里跑 `fn`（`fn` 正常返回或抛错都会释放锁）
 *
 * @template T
 * @param {string} file 状态文档路径（锁文件由它派生）
 * @param {() => T | Promise<T>} fn
 * @param {{waitMs?: number, staleMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withFileLock(file, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lockPath = lockFileOf(file)
  const deadline = Date.now() + waitMs

  for (;;) {
    try {
      await tryCreate(lockPath)
      break
    } catch (err) {
      if (err?.code !== "EEXIST") throw err
      const holder = await readHolder(lockPath)
      if (isStale(holder, staleMs)) {
        await fsp.rm(lockPath, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) throw new QueueBusyError(lockPath, holder)
      await sleep(50)
    }
  }

  try {
    return await fn()
  } finally {
    await release(lockPath)
  }
}
