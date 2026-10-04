/**
 * 云端表：插件的数据来源
 *
 * 插件**不读本地 xlsx**：按 TTL 从云端编辑器拉一份快照
 * （`GET <remote.url>/api/snapshot?k=<remote.token>`），解析成 models 交给调用方。
 *
 * 四条规矩：
 *   1. **对比差异、有差异才换**：新快照与内存里那份逐表比 XML **加共享字符串指纹**，只有真的变了才替换该表的 model，
 *      没变就沿用原来的引用（顺便让下游的缓存判断有意义），并记一条日志说明哪几张表变了
 *   2. **网络抖动不当失败**：拉取出错（超时 / 5xx / 网络不通）时继续用上一次成功的快照，只记日志；
 *      从来没有成功过才把错误抛给调用方，命令会回一句「云端不可达」
 *   3. **本地留一份备份**：数据以云端为准，每次**解析验收通过**的拉取都往 `backup.dir` 原子写一份当日的 xlsx
 *      （同一天覆盖写），超出 `snapshot_backup.keep` 份的自动删掉——防手滑、防服务端事故
 *   4. **写表只发生在云端编辑器**：插件本身永远不写表
 *
 * 备份的更新时机是有讲究的（审核 AQ-10）：**解析与验收都通过之后**才用临时文件原子替换有效备份；
 * 解析不了的响应（HTML 错误页 / 损坏 ZIP / 表结构异常）另存到 `backup.dir/failed/` 作诊断，
 * 不碰最后一份可恢复的副本——否则一次服务端抽风就把兜底也毁掉，重启后什么都没了。
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { openWorkbook } from "../lib/xlsx.js"
import { buildModel } from "../lib/schema.js"
import { log } from "../components/logger.js"

/** 快照过小基本可以断定不是 xlsx（例如拿到了错误页） */
const MIN_SNAPSHOT_BYTES = 1024

/** 失败快照的诊断目录（相对 backup.dir）与保留份数：和有效备份分开，各自的保留策略互不影响 */
const FAILED_DIR = "failed"
const FAILED_KEEP = 5

/** 拉起后确认就绪的兜底等待与探测间隔（调用方没给 waitMs 时用） */
const READY_WAIT_MS = 5000
const READY_POLL_MS = 250

/** 本地时区的“年月日-时分秒-毫秒”，给诊断文件命名（同一秒内多次失败也不会互相覆盖） */
const stampOf = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
  `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}` +
  `-${String(d.getMilliseconds()).padStart(3, "0")}`

/**
 * 共享字符串表的指纹
 *
 * sheet XML 里 `t="s"` 的单元格存的是**下标**，文本在 `xl/sharedStrings.xml` 里。
 * 只比 sheet XML 会漏掉“内容换了、下标没换”的情况（审核 AQ-09），所以缓存键必须带上这个指纹。
 */
const sharedFingerprint = shared => createHash("sha1").update(JSON.stringify(shared ?? [])).digest("hex")

/** 诊断文件的后缀：能看出拿到的是什么（错误页 / 坏 ZIP / 别的二进制） */
const snapshotExt = buf => {
  if (buf.subarray(0, 4).toString("latin1") === "PK\u0003\u0004") return "xlsx"
  return /^\s*</.test(buf.subarray(0, 32).toString("utf8")) ? "html" : "bin"
}

/**
 * 启动器类型 → 用什么执行
 *
 * **必须和部署产物对上**：`tools/deploy-windows.ps1` 生成的是 `editor-launch.mjs`
 * （用跑机器人的那个 node 直接跑）。以前只区分 `.vbs`、其余一律丢给 Node，
 * 于是部署生成的 `.cmd` 被当 JavaScript 跑，第一行 `@echo off` 就语法错误（审核 AQ-11）。
 *
 * @returns {[string, string[]] | null} null = 不认识这种启动器（明确报告，不要瞎猜着执行）
 */
export function autostartCommand(file) {
  switch (path.extname(file).toLowerCase()) {
    case ".vbs":
      return ["wscript.exe", [file]]
    case ".cmd":
    case ".bat":
      return ["cmd.exe", ["/c", file]]
    case ".mjs":
    case ".js":
    case ".cjs":
      return [process.execPath, [file]]
    default:
      return null
  }
}

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
    /** 本机联调用：拉不到时按这个路径把编辑器拉起来（.mjs 用 node 跑，.vbs 用 wscript，.cmd 用 cmd.exe） */
    this.autostart = String(autostart ?? "").trim()
    /** 本地备份目录（留空 = 不备份）与保留份数（默认只留最新一份） */
    this.backupDir = String(backupDir ?? "").trim()
    this.backupKeep = Number(backupKeep) >= 0 ? Number(backupKeep) : 1
    /** Map<表名, { xml, sharedKey, model }>：上一次成功拿到的快照（sharedKey 见 sharedFingerprint） */
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
   * 本地备份：把**已通过解析与验收**的快照写成当日那份
   *
   * 先写临时文件再原子重命名：别的进程读到的永远是完整的 xlsx，不会撞上写了一半的文件。
   * 只留最新的：按日期命名，写完把别的备份都删掉（防手滑用，留多份没意义）。
   * 备份失败只是少了一份兜底，不能影响命令，所以这里只记日志。
   */
  #commitBackup(buf) {
    if (!this.backupDir || this.backupKeep <= 0) return
    try {
      fs.mkdirSync(this.backupDir, { recursive: true })
      const file = path.join(this.backupDir, `queue-${dayStamp()}.xlsx`)
      const fresh = !fs.existsSync(file)
      const tmp = `${file}.tmp-${process.pid}`
      try {
        fs.writeFileSync(tmp, buf)
        fs.renameSync(tmp, file)
      } finally {
        /** 失败时别把半截临时文件留在备份目录里 */
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          /* 清不掉就算了，下次覆盖 */
        }
      }
      if (fresh) log("mark", `[abyss-queue] 已把云端快照备份到 ${file}`)
      this.#pruneBackups(file)
    } catch (err) {
      log("warn", `[abyss-queue] 本地备份失败（不影响读表）：${err?.message ?? err}`)
    }
  }

  /**
   * 失败快照的诊断副本
   *
   * 保留异常原始响应有排查价值，但**不能和最后一份有效备份共用一个文件**：
   * 有效副本要能解析成表、能用来恢复数据；诊断副本只需要"原样留着"。
   * 所以写到 `backup.dir/failed/`，并按份数滚动（默认留最近 FAILED_KEEP 份）。
   * 写诊断本身也不能影响读表，出错只记日志。
   */
  #saveFailedSnapshot(buf, err) {
    if (!this.backupDir) return
    try {
      const dir = path.join(this.backupDir, FAILED_DIR)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `snapshot-${stampOf()}.${snapshotExt(buf)}`)
      fs.writeFileSync(file, buf)
      log(
        "warn",
        `[abyss-queue] 云端快照无法解析（${err?.message ?? err}），原始响应已另存诊断文件：${file}（有效备份未改动）`,
      )
      const keep = /^snapshot-\d{8}-\d{6}-\d{3}\.\w+$/
      const files = fs.readdirSync(dir).filter(f => keep.test(f)).sort().reverse()
      for (const name of files.slice(FAILED_KEEP)) {
        try {
          fs.rmSync(path.join(dir, name), { force: true })
        } catch {
          /* 删不掉就下次再说 */
        }
      }
    } catch (e) {
      log("warn", `[abyss-queue] 诊断文件写入失败（不影响读表）：${e?.message ?? e}`)
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
    /** 拿到手先不落盘：是不是有效快照要等解析验收（见 #fetch），失败的一律进 failed/ 当诊断 */
    return Buffer.from(await res.arrayBuffer())
  }

  /** 拉一次 → 逐表对比 → 只换有差异的表；解析验收通过后才更新有效备份 */
  async #fetch() {
    const buf = await this.#download()
    if (buf.length < MIN_SNAPSHOT_BYTES) {
      const err = new Error(`快照内容过小（${buf.length} 字节），拿到的可能不是 xlsx`)
      this.#saveFailedSnapshot(buf, err)
      throw err
    }

    let wb
    try {
      wb = await openWorkbook(buf)
    } catch (err) {
      /** 不是能打开的 xlsx（HTML 错误页 / 坏 ZIP）：只留诊断，有效备份原样不动 */
      this.#saveFailedSnapshot(buf, err)
      throw err
    }
    if (!wb.sheets.length) {
      const err = new Error("快照里没有任何工作表")
      this.#saveFailedSnapshot(buf, err)
      throw err
    }

    const sharedKey = sharedFingerprint(wb.shared)
    const next = new Map()
    const changed = []
    try {
      for (const sheet of wb.sheets) {
        const xml = await wb.sheetXml(sheet.name)
        const old = this.sheets?.get(sheet.name)
        /**
         * sheet XML **和共享字符串**都没变才沿用原来那份 model：
         * 只比 XML 会漏掉"下标没变、文本变了"（审核 AQ-09）。
         */
        if (old && old.xml === xml && old.sharedKey === sharedKey) {
          next.set(sheet.name, old)
          continue
        }
        next.set(sheet.name, { xml, sharedKey, model: buildModel({ name: sheet.name, xml, shared: wb.shared }) })
        changed.push(sheet.name)
      }
    } catch (err) {
      /** 表结构不对（缺表头 / 缺业务列）：同样只留诊断，不拿它顶掉有效备份 */
      this.#saveFailedSnapshot(buf, err)
      throw err
    }

    /** 到这里才算"这份快照能用"：此刻才原子更新有效备份并执行保留策略 */
    this.#commitBackup(buf)

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
   * 按配置把编辑器拉起来（`remote.autostart`）
   *
   * 单机部署（机器人 + 编辑器同一台）时用它让编辑器**跟着机器人一起起**，
   * 不必再单独注册 Windows 服务；用 detached + windowsHide 起，免得控制台关掉把它带走。
   * 分工见 `autostartCommand()`：.mjs 用同一个 node 跑（部署脚本生成的就是它），
   * .vbs 用 wscript，.cmd/.bat 交给 cmd.exe。
   *
   * @returns {boolean} 是否**发起了**启动；服务到底起没起由 `ensureEditor()` 探活判定
   */
  #tryAutostart() {
    if (!this.autostart) return false
    try {
      if (!fs.existsSync(this.autostart)) {
        log("warn", `[abyss-queue] remote.autostart 指向的文件不存在：${this.autostart}`)
        return false
      }
      const run = autostartCommand(this.autostart)
      if (!run) {
        log(
          "warn",
          `[abyss-queue] remote.autostart 的类型不被支持：${this.autostart}（支持 .mjs/.js/.cjs/.vbs/.cmd/.bat；部署脚本生成的是 editor-launch.mjs）`,
        )
        return false
      }
      const child = spawn(run[0], run[1], { detached: true, stdio: "ignore", windowsHide: true })
      /** spawn 的失败（可执行文件不存在等）是异步事件：不接住会变成未处理异常 */
      child.on("error", err => log("warn", `[abyss-queue] 启动编辑器失败：${err?.message ?? err}`))
      child.unref()
      log("mark", `[abyss-queue] 已按 remote.autostart 发起启动：${path.basename(this.autostart)}（等 /healthz 确认）`)
      return true
    } catch (err) {
      log("warn", `[abyss-queue] 启动编辑器失败：${err?.message ?? err}`)
      return false
    }
  }

  /** 编辑器活着吗（`/healthz` 只凭口令放行，所以带上口令探） */
  async editorAlive() {
    if (!this.url) return false
    try {
      const u = new URL(`${this.url}/healthz`)
      if (this.token) u.searchParams.set("k", this.token)
      const res = await fetch(u, { signal: AbortSignal.timeout(2500) })
      return res.ok
    } catch {
      return false
    }
  }

  /** 等 `/healthz` 通过（最多 ms 毫秒）：拉起成功与否以它为准，spawn 只代表进程起来了 */
  async #waitReady(ms) {
    const deadline = Date.now() + Math.max(0, Number(ms) || 0)
    for (;;) {
      if (await this.editorAlive()) return true
      if (Date.now() >= deadline) return false
      await new Promise(r => setTimeout(r, READY_POLL_MS))
    }
  }

  /**
   * 确保编辑器在跑：活着就什么都不做，没起来就按配置拉起来
   *
   * 插件加载时（`init()`）调一次 = 「编辑器随机器人启动」；回调返回是否**拉起并确认可用**。
   * 没配 `remote.autostart` 时直接跳过（云端单独跑的部署不需要它）。
   *
   * **拉起成功 ≠ 服务可用**：`spawn()` 只说明进程起来了（`.cmd` 被当 JS 跑时它也"成功"），
   * 所以这里必须等 `/healthz` 探到才算成功（审核 AQ-11）。等不到就记一条明确的告警，
   * 免得日志里写着"已拉起"、实际什么都没提供。
   *
   * @param {object} [opts]
   * @param {number} [opts.waitMs] 发起启动后最多等多久探到 `/healthz`；<=0 时用默认 5 秒
   * @returns {Promise<boolean>} true = 本次拉起并确认编辑器可用
   */
  async ensureEditor({ waitMs = 0 } = {}) {
    if (!this.autostart) return false
    if (await this.editorAlive()) return false
    if (!this.#tryAutostart()) return false

    const budget = Number(waitMs) > 0 ? Number(waitMs) : READY_WAIT_MS
    if (await this.#waitReady(budget)) {
      log("mark", `[abyss-queue] 编辑器已就绪（/healthz 通过）：${path.basename(this.autostart)}`)
      return true
    }
    log(
      "warn",
      `[abyss-queue] 已发起启动 ${path.basename(this.autostart)}，但 ${budget}ms 内 /healthz 未就绪：编辑器没起来、启动慢，或启动器类型与部署产物不匹配`,
    )
    return false
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
        /** 从没成功过：先试着自己把编辑器拉起来（本机联调），等它真的应答了再拉一次 */
        if (!this.sheets && this.#tryAutostart()) {
          await this.#waitReady(Number(process.env.ABYSS_AUTOSTART_WAIT_MS) || 8000)
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
