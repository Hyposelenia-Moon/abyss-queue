/**
 * 插件对编辑器的写命令：整理、插队、退队、清榜核查、周期清榜。
 *
 * **为什么都在这一个文件**：五个命令原先是五个薄壳（各 36–61 行），每个都只有
 * 「取进程内服务 → 判挂载 → 传参 → 记一行日志」这四步。它们走的是同一条路——
 * 编辑器就挂在 bot 自己的 http.Server 上（`editor/service.js` 的注册表），两个进程
 * 其实是同一个，没有理由绕 HTTP + 口令 + 签名，也没有理由复制四遍样板。
 *
 * 约定（五个命令一致）：
 *   - 插件对表只读，换内容只有拿着那张表的编辑器做得到；编辑器没挂载时直接报错，
 *     不做 HTTP 兜底、不吞错——怎么回话由调用方决定；
 *   - 权限由编辑器那侧判（`caller.role`）；走机器人身份的命令用 `ROSTER_QQ`；
 *   - 回执原样带回（`{ ok: true, ...out }`），日志只记人话，不把内部细节塞进群消息。
 */
import crypto from "node:crypto"
import { log } from "../components/logger.js"
import { getEditorService } from "../editor/service.js"
import { snapshotBuffer } from "./local.js"
import { ROSTER_QQ } from "./roster.js"

/**
 * 取进程内编辑器，顺带把「没挂载」这句话统一成人话。
 *
 * @param {string} name `service` 上的方法名（`tidy` / `moveRow` / `save` / `checkDone` / `cycle` / `cycleStatus`）
 * @param {string} need 补在括号里的用途（「整理需要它」）
 * @returns {object} 编辑器服务
 * @throws {Error} 编辑器未挂载
 */
const serviceOf = (name, need) => {
  const service = getEditorService()
  if (!service?.[name]) throw new Error(`编辑器没有在进程内挂载（${need}需要它）`)
  return service
}

/**
 * 整理所有榜（给 `sheet` 就只整理那一个）
 *
 * 整理哪几个榜由 `sheet` 决定，规则在编辑器那侧（`editor/actions.js` 的 `tidy`）；
 * 回执里的 `moved` = 0 表示本来就是这个顺序，**表与版本都没动**。
 *
 * @param {{sheet?: string}} [opts]
 * @returns {Promise<{ok: boolean, moved: number, tidied: Array<{sheet: string, moved: number, reason?: string}>, shiftRows?: Record<string, Record<string, number>>}>}
 * @throws {Error} 编辑器未挂载 / 整理失败
 */
export async function tidySheets({ sheet } = {}) {
  const out = await serviceOf("tidy", "整理").tidy({ qq: ROSTER_QQ, nick: "每日整理" }, { sheet: String(sheet ?? "") })

  const parts = (out.tidied ?? []).filter(t => t.moved).map(t => `${t.sheet} ${t.moved} 行`)
  log("info", `[abyss-queue] 每日整理完成：共挪 ${out.moved ?? 0} 行` + (parts.length ? `（${parts.join("、")}）` : "（本来就已经是有序的）"))
  return { ok: true, ...out }
}

/**
 * 整理一个榜；不传 `sheet` 整理全部榜。失败只记日志，不改变调用方的结果。
 *
 * @param {string} [sheet]
 * @returns {Promise<object|null>} 失败返回 `null`
 */
export async function tidySheet(sheet = "") {
  try {
    return await tidySheets({ sheet: String(sheet ?? "") })
  } catch (err) {
    log("warn", `[abyss-queue] 退队后的整理失败（${sheet || "全部榜"}）：${err?.message ?? err}`)
    return null
  }
}

/**
 * 插队：把某一行挪到这一榜所有「排队中」的人最前面
 *
 * 权限由编辑器那侧判（`caller.role` 必须是 admin），这里只负责把发起人带过去。
 *
 * @param {object} opts
 * @param {{qq?: string|number, nick?: string}} [opts.caller] 发起这次插队的人
 * @param {string} opts.sheet 榜名
 * @param {number} opts.row 要挪的那一行的行号
 * @param {string} [opts.nick] 目标成员的群昵称（只进日志，不影响判定）
 * @returns {Promise<object>} 回执：`{ ok, moved, from, to, nickname, crossed, reason? }`
 * @throws {Error} 编辑器未挂载 / 权限不足 / 行号不合法
 */
export async function moveRow({ caller = {}, sheet, row, nick = "" } = {}) {
  const out = await serviceOf("moveRow", "插队").moveRow(
    { role: "admin", qq: String(caller.qq ?? ""), nick: String(caller.nick ?? "") },
    { sheet: String(sheet ?? ""), row: Number(row), mode: "queue-front", nick: String(nick ?? "") },
  )

  log(
    "info",
    `[abyss-queue] 插队：${sheet} 第 ${row} 行${nick ? `（${nick}）` : ""} → ${out?.moved ? `第 ${out.to} 行` : "未移动"}`,
  )
  return { ok: true, ...out }
}

/**
 * 退队：清空调用者在本榜的那一行（编辑器内部会清行、压紧、留历史版本）
 *
 * 按管理员走：要清哪一行是插件侧（`apps/leaver.js` 的 `findOwnRow`）认过的，
 * 用 `self` 反而会被**额度与两条红线**拦下（那是给别人用的约束），详见 `editor/actions.js`。
 *
 * @param {{caller?: {qq?: string|number, nick?: string}, sheet: string, row: number}} opts
 * @returns {Promise<object>} 编辑器回执
 * @throws {Error} 编辑器未挂载 / 清行失败
 */
export async function leaveRow({ caller = {}, sheet, row } = {}) {
  const out = await serviceOf("save", "退队").save(
    { role: "admin", identity: { qq: String(caller.qq ?? ""), nick: String(caller.nick ?? "") } },
    {
      sheet,
      rows: [
        {
          row: Number(row),
          /** 退队专用：编辑器跳过必填校验，整行清空 */
          clear: true,
          values: { nickname: "", gameName: "", anchor: "", goal: "", note: "", status: "" },
        },
      ],
    },
  )
  log("info", `[abyss-queue] 退队已提交：${sheet} 第 ${row} 行（${caller.nick || caller.qq || "？"}）`)
  return { ok: true, ...out }
}

/** 当前完整源 XLSX 的摘要，编辑器用它判版本冲突 */
export async function tableVersion() {
  const buffer = await snapshotBuffer()
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

/**
 * 清榜前核查：把已确认完成的人批量改成「本人已完成」
 *
 * @param {{sheet:string, version:string, rows:Array<{row:number, nickname:string, goal?:string}>}} opts
 * @returns {Promise<{ok:boolean, sheet:string, updated:number, rows:number[]}>}
 * @throws {Error} 编辑器未挂载 / 版本不合法 / 表格版本冲突
 */
export async function markChecked({ sheet, version, rows = [] } = {}) {
  const sourceVersion = String(version ?? "").trim()
  if (!/^[0-9a-f]{64}$/i.test(sourceVersion)) throw new Error("清榜核查缺少有效版本")
  if (!rows.length) return { updated: 0, rows: [] }

  const service = serviceOf("checkDone", "标记完成")
  const out = await service.checkDone(
    { qq: ROSTER_QQ, nick: "清榜核查" },
    {
      sheet: String(sheet),
      version: sourceVersion,
      rows: rows.map(r => ({ row: Number(r.row), nickname: String(r.nickname), goal: r.goal })),
    },
  )

  log("info", `[abyss-queue] 清榜核查：${sheet} 标记完成 ${out?.updated ?? 0} 行`)
  return { ok: true, ...out }
}

/**
 * 这一轮是否已经在服务端执行过。
 * 客户端**必须在下载/覆盖归档之前**调用，避免回执丢失后的重试覆盖归档。
 *
 * @param {string} eventKey
 * @returns {Promise<{ok:boolean, done:boolean, pending:boolean, protocol:number}>}
 */
export async function cycleStatus(eventKey) {
  const key = String(eventKey ?? "").trim()
  if (!key) throw new Error("缺少 eventKey")

  const out = await serviceOf("cycleStatus", "清榜/开榜").cycleStatus({ qq: ROSTER_QQ, nick: "周期清榜" }, { eventKey: key })
  log("info", `[abyss-queue] 周期清榜状态：${key}（已完成 ${out?.done ? "是" : "否"}，未决 ${out?.pending ? "是" : "否"}）`)
  return { ok: true, done: Boolean(out?.done), pending: Boolean(out?.pending), protocol: Number(out?.protocol) }
}

/**
 * 周期清榜：让编辑器执行「删行 / 翻等待行」。
 *
 * 幂等账本（`abyss-editor-cycle.json`）与未决 intent 都在编辑器侧：先 `cycleStatus` 查
 * 这一轮有没有执行过，再 `cycleWrite` 清榜，回执丢了重试也不会清第二次。
 *
 * @param {{sheet:string, mode:"all"|"queued-done"|"done"|"promote", promote?:false|"all"|"future-real", eventKey:string, version:string}} opts
 * @returns {Promise<{ok:boolean, sheet:string, cleared:number, promoted:number, rowMap?:Record<string, number>}>}
 * @throws {Error} 编辑器未挂载 / eventKey 或版本不合法 / 同一轮已有未决 intent / 表格版本冲突
 */
export async function cycleWrite({ sheet, mode, promote = false, eventKey = "", version = "" } = {}) {
  const key = String(eventKey ?? "").trim()
  const sourceVersion = String(version ?? "").trim()
  if (!key) throw new Error("周期清榜缺少 eventKey")
  if (!/^[0-9a-f]{64}$/i.test(sourceVersion)) throw new Error("周期清榜缺少有效的归档源版本")

  const out = await serviceOf("cycle", "清榜/开榜").cycle({ qq: ROSTER_QQ, nick: "周期清榜" }, {
    sheet: String(sheet),
    mode,
    promote,
    eventKey: key,
    version: sourceVersion,
  })
  log(
    "info",
    out?.skipped
      ? `[abyss-queue] 周期清榜：${out?.sheet ?? sheet} 这一轮已经执行过，跳过`
      : `[abyss-queue] 周期清榜：${out?.sheet ?? sheet} 清除 ${out?.cleared ?? 0} 行${out?.promoted ? `，翻排队 ${out.promoted} 行` : ""}`,
  )
  return { ok: true, ...out }
}