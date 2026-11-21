/**
 * 周期清榜：让编辑器执行"删行 / 翻等待行"。
 *
 * **进程内直调**（`editor/service.js` 的注册表）：与 `model/tidy.js` / `model/move-row.js` 同一条路——
 * 编辑器就挂在 bot 自己的 http.Server 上，两个进程其实是同一个，没有理由再绕一圈 HTTP + 口令 + 签名。
 * 编辑器没挂载时直接报错，不做 HTTP 兜底。
 *
 * 幂等账本（`abyss-editor-cycle.json`）与未决 intent 都在编辑器侧：进程内调用与原来的 HTTP
 * 调用走的是同一份协议——先 `cycleStatus` 查这一轮有没有执行过，再 `cycleWrite` 清榜，
 * 回执丢了重试也不会清第二次。
 */
import { getEditorService } from "../editor/service.js"
import { log } from "../components/logger.js"
import { ROSTER_QQ } from "./roster.js"

const caller = { qq: ROSTER_QQ, nick: "周期清榜" }

/**
 * 这一轮是否已经在服务端执行过。
 * 客户端**必须在下载/覆盖归档之前**调用，避免回执丢失后的重试覆盖归档。
 */
export async function cycleStatus(eventKey) {
  const key = String(eventKey ?? "").trim()
  if (!key) throw new Error("缺少 eventKey")
  const service = getEditorService()
  if (!service?.cycleStatus) throw new Error("编辑器没有在进程内挂载（清榜/开榜需要它）")
  const out = await service.cycleStatus(caller, { eventKey: key })
  log(
    "info",
    `[abyss-queue] 周期清榜状态：${key}（已完成 ${out?.done ? "是" : "否"}，未决 ${out?.pending ? "是" : "否"}）`,
  )
  return { ok: true, done: Boolean(out?.done), pending: Boolean(out?.pending), protocol: Number(out?.protocol) }
}

/**
 * @param {{sheet:string, mode:"all"|"queued-done"|"done"|"promote", promote?:false|"all"|"future-real", eventKey:string, version:string}} opts
 * @returns {Promise<{ok:boolean, sheet:string, cleared:number, promoted:number, rowMap?:Record<string, number>}>}
 * @throws {Error} 编辑器未挂载 / eventKey 或版本不合法 / 同一轮已有未决 intent / 表格版本冲突
 */
export async function cycleWrite({ sheet, mode, promote = false, eventKey = "", version = "" } = {}) {
  const key = String(eventKey ?? "").trim()
  const sourceVersion = String(version ?? "").trim()
  if (!key) throw new Error("周期清榜缺少 eventKey")
  if (!/^[0-9a-f]{64}$/i.test(sourceVersion)) throw new Error("周期清榜缺少有效的归档源版本")
  const service = getEditorService()
  if (!service?.cycle) throw new Error("编辑器没有在进程内挂载（清榜/开榜需要它）")
  const out = await service.cycle(caller, {
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
