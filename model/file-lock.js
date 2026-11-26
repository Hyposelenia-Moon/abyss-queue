/** 跨进程写锁（`queue.lock`） */
import fsp from "node:fs/promises"
import os from "node:os"

export const LOCK_STALE_MS = 2 * 60 * 1000

export const LOCK_WAIT_MS = 3000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class QueueBusyError extends Error {
  constructor(lockPath, holder) {
    super(`另一个编辑器正在写表（${lockPath}${holder?.pid ? `，PID ${holder.pid}` : ""}）；确认它没卡住后重试`)
    this.name = "QueueBusyError"
    this.code = "QUEUE_BUSY"
    this.holder = holder
  }
}

export const lockFileOf = file => (/\.json$/i.test(file) ? file.replace(/\.json$/i, ".lock") : `${file}.lock`)

const readHolder = async lockPath => {
  try {
    const raw = JSON.parse(await fsp.readFile(lockPath, "utf8"))
    return { pid: Number(raw?.pid) || 0, host: String(raw?.host ?? ""), at: Number(raw?.at) || 0 }
  } catch {
    return null
  }
}

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
  if (!holder.host || holder.host === os.hostname()) return !pidAlive(holder.pid)
  return Date.now() - holder.at > staleMs
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
    if (!holder || (holder.pid === process.pid && holder.host === os.hostname())) {
      await fsp.rm(lockPath, { force: true })
    }
  } catch {
  }
}

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
