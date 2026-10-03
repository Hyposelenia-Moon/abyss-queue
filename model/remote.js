/**
 * 云端表：插件的数据来源
 *
 * 插件**不读本地 xlsx**：按 TTL 从云端编辑器拉一份快照
 * （`GET <remote.url>/api/snapshot?k=<remote.token>`），解析成 models 交给调用方。
 *
 * 四条规矩：
 *   1. **对比差异、有差异才换**：新快照与内存里那份逐表比 XML，只有真的变了才替换该表的 model，
 *      没变就沿用原来的引用（顺便让下游的缓存判断有意义），并记一条日志说明哪几张表变了
 *   2. **网络抖动不当失败**：拉取出错（超时 / 5xx / 网络不通）时继续用上一次成功的快照，只记日志；
 *      从来没有成功过才把错误抛给调用方，命令会回一句「云端不可达」
 *   3. **本地留一份备份**：数据以云端为准，每次成功拉取都往 `backup.dir` 写一份当日的 xlsx
 *      （同一天覆盖写），超过 `backup.days` 天的自动删掉——防手滑、防服务端事故
 *   4. **写表只发生在云端编辑器**：插件本身永远不写表
 */
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { openWorkbook } from "../lib/xlsx.js"
import { buildModel } from "../lib/schema.js"
import { log } from "../lib/logger.js"

/** 快照过小基本可以断定不是 xlsx（例如拿到了错误页） */
const MIN_SNAPSHOT_BYTES = 1024

/** 本地备份文件名里的日期（本地时区） */
const dayStamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

export class RemoteTable {
  #inflight = null

  constructor({ url = "", token = "", ttl = 30000, timeout = 15000, autostart = "", backupDir = "", backupKeep = 1 } = {}) {
    this.url = String(url ?? "").trim().replace(/\/+$/, "")
    this.token = String(token ?? "").trim()
    /** ttl = 0 表示不缓存（每次都拉，测试与排障用）；非法值回落到默认 30 秒 */
    this.ttl = Number(ttl) >= 0 ? Number(ttl) : 30000
    this.timeout = Number(timeout) > 0 ? Number(timeout) : 15000
    /** 本机联调用：拉不到时按这个路径把编辑器拉起来（.mjs 用 node 跑，.vbs 用 wscript） */
    this.autostart = String(autostart ?? "").trim()
    /** 本地备份目录（留空 = 不备份）与保留份数（默认只留最新一份） */
    this.backupDir = String(backupDir ?? "").trim()
    this.backupKeep = Number(backupKeep) >= 0 ? Number(backupKeep) : 1
    /** Map<表名, { xml, model }>：上一次成功拿到的快照 */
    this.sheets = null
    /** 上次成功拉取的时间戳 */
    this.fetchedAt = 0
  }

  get configured() {
    return Boolean(this.url)
  }

  get hint() {
    return [
      "插件还没配置好：请在 config/config.yaml 里填写 remote.url（云端编辑器地址）",
      "本机联调可以填 http://127.0.0.1:7788；口令要与编辑器的 ABYSS_EDITOR_TOKEN 一致",
    ].join("\n")
  }

  #snapshotUrl() {
    const u = new URL(`${this.url}/api/snapshot`)
    if (this.token) u.searchParams.set("k", this.token)
    return u
  }

  /**
   * 本地备份：把这次拿到的快照写一份到 `backup.dir`
   *
   * 只留最新的：按日期命名，写完把别的备份都删掉（防手滑用，留多份没意义）。
   * 备份失败只是少了一份兜底，不能影响命令，所以这里只记日志。
   */
  #backup(buf) {
    if (!this.backupDir || this.backupKeep <= 0) return
    try {
      fs.mkdirSync(this.backupDir, { recursive: true })
      const file = path.join(this.backupDir, `queue-${dayStamp()}.xlsx`)
      const fresh = !fs.existsSync(file)
      fs.writeFileSync(file, buf)
      if (fresh) log("mark", `[abyss-queue] 已把云端快照备份到 ${file}`)
      this.#pruneBackups(file)
    } catch (err) {
      log("warn", `[abyss-queue] 本地备份失败（不影响读表）：${err?.message ?? err}`)
    }
  }

  /**
   * 只留最新：把除 `keep` 之外的历史备份删掉
   *
   * 按日期排序取最新的 keep 份；只认 `queue-YYYY-MM-DD.xlsx` 这个命名，别的文件一律不碰。
   */
  #pruneBackups(keepFile) {
    const files = fs
      .readdirSync(this.backupDir)
      .filter(f => /^queue-\d{4}-\d{2}-\d{2}\.xlsx$/.test(f))
      .sort()
      .reverse()
    for (const name of files.slice(this.backupKeep)) {
      const full = path.join(this.backupDir, name)
      if (full === keepFile) continue
      try {
        fs.rmSync(full)
        log("info", `[abyss-queue] 本地备份只留最新，已删除：${name}`)
      } catch {
        /* 删不掉就下次再说 */
      }
    }
  }

  async #download() {
    const res = await fetch(this.#snapshotUrl(), {
      signal: AbortSignal.timeout(this.timeout),
      headers: { accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    })
    if (res.status === 403) throw new Error("云端口令不对（HTTP 403）：检查 remote.token 是否与编辑器的 ABYSS_EDITOR_TOKEN 一致")
    if (!res.ok) throw new Error(`云端返回 HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < MIN_SNAPSHOT_BYTES) throw new Error(`快照内容过小（${buf.length} 字节），拿到的可能不是 xlsx`)
    /** 拿到手就备份：后面解析失败（表结构不对等）时，这份备份正是排查用的原始证据 */
    this.#backup(buf)
    return buf
  }

  /** 拉一次 → 逐表对比 → 只换有差异的表 */
  async #fetch() {
    const wb = await openWorkbook(await this.#download())
    const next = new Map()
    const changed = []
    for (const sheet of wb.sheets) {
      const xml = await wb.sheetXml(sheet.name)
      const old = this.sheets?.get(sheet.name)
      /** 一模一样就沿用原来那份 model，不重新解析 */
      if (old && old.xml === xml) {
        next.set(sheet.name, old)
        continue
      }
      next.set(sheet.name, { xml, model: buildModel({ name: sheet.name, xml, shared: wb.shared }) })
      changed.push(sheet.name)
    }

    const first = this.sheets === null
    const gone = this.sheets ? [...this.sheets.keys()].filter(n => !next.has(n)) : []
    this.sheets = next
    this.fetchedAt = Date.now()

    if (first) log("mark", `[abyss-queue] 已连上云端表：${[...next.keys()].join(" / ")}`)
    else if (changed.length || gone.length) {
      const extra = changed.length + gone.length < next.size ? `（其余 ${next.size - changed.length} 张未变）` : ""
      const list = [...changed, ...gone.map(n => `${n}（已移除）`)].join("、")
      log("mark", `[abyss-queue] 云端表拉取完成，有变化：${list}${extra}`)
    } else log("info", "[abyss-queue] 云端表拉取完成，各表内容都没有变化")

    return this.#result()
  }

  #result() {
    const models = new Map()
    for (const [name, item] of this.sheets) models.set(name, item.model)
    return { models, names: [...this.sheets.keys()], fetchedAt: this.fetchedAt }
  }

  /**
   * 本机联调兜底：拉不到数据时把编辑器拉起来
   *
   * 只在配了 remote.autostart 时生效（正式部署在服务器上不需要这一步）。
   * 用 detached + windowsHide 起，避免控制台被关掉时把它一起带走。
   */
  #tryAutostart() {
    if (!this.autostart) return false
    try {
      if (!fs.existsSync(this.autostart)) {
        log("warn", `[abyss-queue] remote.autostart 指向的文件不存在：${this.autostart}`)
        return false
      }
      const isVbs = path.extname(this.autostart).toLowerCase() === ".vbs"
      const cmd = isVbs ? "wscript.exe" : process.execPath
      spawn(cmd, [this.autostart], { detached: true, stdio: "ignore", windowsHide: true }).unref()
      log("mark", `[abyss-queue] 拉不到云端表，已按配置启动本机编辑器：${path.basename(this.autostart)}`)
      return true
    } catch (err) {
      log("warn", `[abyss-queue] 启动本机编辑器失败：${err?.message ?? err}`)
      return false
    }
  }

  /**
   * 取当前的 models：TTL 内直接用内存里那份；过期就拉一次
   * 并发调用共用同一次请求；拉取失败时回落到上一次成功的快照
   */
  async load() {
    if (!this.configured) throw new Error(this.hint)
    if (this.sheets && Date.now() - this.fetchedAt < this.ttl) return this.#result()
    if (this.#inflight) return this.#inflight

    this.#inflight = (async () => {
      try {
        return await this.#fetch()
      } catch (err) {
        /** 从没成功过：先试着自己把编辑器拉起来（本机联调），再报错 */
        if (!this.sheets && this.#tryAutostart()) {
          await new Promise(r => setTimeout(r, Number(process.env.ABYSS_AUTOSTART_WAIT_MS) || 8000))
          try {
            return await this.#fetch()
          } catch (err2) {
            throw new Error(`云端表不可达（${this.url}）：${err2?.message ?? err2}`)
          }
        }
        /** 有旧快照就继续用，别让命令挂掉 */
        if (!this.sheets) throw new Error(`云端表不可达（${this.url}）：${err?.message ?? err}`)
        log("warn", `[abyss-queue] 云端表拉取失败，用上一次的快照继续：${err?.message ?? err}`)
        return this.#result()
      }
    })()

    try {
      return await this.#inflight
    } finally {
      this.#inflight = null
    }
  }

  /** 与本地 Table 同形的只读接口：read(fn) → fn({ models, names, fetchedAt }) */
  async read(fn) {
    return fn(await this.load())
  }
}
