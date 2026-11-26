/** 插件对编辑器的写命令：整理、插队、退队、清榜核查、周期清榜。 */
import crypto from "node:crypto"
import { log } from "../components/logger.js"
import { getEditorService } from "../editor/service.js"
import { snapshotBuffer } from "./local.js"
import { ROSTER_QQ } from "./roster.js"

const serviceOf = (name, need) => {
  const service = getEditorService()
  if (!service?.[name]) throw new Error(`编辑器没有在进程内挂载（${need}需要它）`)
  return service
}

export async function tidySheets({ sheet } = {}) {
  const out = await serviceOf("tidy", "整理").tidy({ qq: ROSTER_QQ, nick: "每日整理" }, { sheet: String(sheet ?? "") })
  const parts = (out.tidied ?? []).filter(t => t.moved).map(t => `${t.sheet} ${t.moved} 行`)
  log("info", `[abyss-queue] 每日整理完成：共挪 ${out.moved ?? 0} 行` + (parts.length ? `（${parts.join("、")}）` : "（本来就已经是有序的）"))
  return { ok: true, ...out }
}

export async function tidySheet(sheet = "") {
  try {
    return await tidySheets({ sheet: String(sheet ?? "") })
  } catch (err) {
    log("warn", `[abyss-queue] 退队后的整理失败（${sheet || "全部榜"}）：${err?.message ?? err}`)
    return null
  }
}

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

export async function leaveRow({ caller = {}, sheet, row } = {}) {
  const out = await serviceOf("save", "退队").save(
    { role: "admin", identity: { qq: String(caller.qq ?? ""), nick: String(caller.nick ?? "") } },
    {
      sheet,
      rows: [
        {
          row: Number(row),
          clear: true,
          values: { nickname: "", gameName: "", anchor: "", goal: "", note: "", status: "" },
        },
      ],
    },
  )
  log("info", `[abyss-queue] 退队已提交：${sheet} 第 ${row} 行（${caller.nick || caller.qq || "？"}）`)
  return { ok: true, ...out }
}

export async function tableVersion() {
  const buffer = await snapshotBuffer()
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

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

export async function cycleStatus(eventKey) {
  const key = String(eventKey ?? "").trim()
  if (!key) throw new Error("缺少 eventKey")
  const out = await serviceOf("cycleStatus", "清榜/开榜").cycleStatus({ qq: ROSTER_QQ, nick: "周期清榜" }, { eventKey: key })
  log("info", `[abyss-queue] 周期清榜状态：${key}（已完成 ${out?.done ? "是" : "否"}，未决 ${out?.pending ? "是" : "否"}）`)
  return { ok: true, done: Boolean(out?.done), pending: Boolean(out?.pending), protocol: Number(out?.protocol) }
}

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
