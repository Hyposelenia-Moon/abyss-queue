/**
 * 清榜前核查：把已确认完成的人批量改成「本人已完成」。
 *
 * **进程内直调**（`editor/service.js` 的注册表）：与 `#插队`、每日整理、退队同一条路——
 * 编辑器就挂在 bot 自己的 http.Server 上，两个进程其实是同一个，没有理由再绕一圈 HTTP + 口令 + 签名。
 * 编辑器没挂载时直接报错，不做 HTTP 兜底。
 *
 * 版本口径不变：`version` 交给编辑器，在写队列内做最终版本核验，期间有人改表就整批拒绝，
 * 不覆盖别人。
 */
import crypto from "node:crypto"
import { getEditorService } from "../editor/service.js"
import { log } from "../components/logger.js"
import { snapshotBuffer } from "./local.js"
import { ROSTER_QQ } from "./roster.js"

/** 当前完整源 XLSX 的摘要，编辑器用它判版本冲突 */
export async function tableVersion() {
  const buffer = await snapshotBuffer()
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

/**
 * @param {{sheet:string, version:string, rows:Array<{row:number, nickname:string, goal?:string}>}} opts
 * @returns {Promise<{ok:boolean, sheet:string, updated:number, rows:number[]}>}
 * @throws {Error} 编辑器未挂载 / 版本不合法 / 表格版本冲突
 */
export async function markChecked({ sheet, version, rows = [] } = {}) {
  const service = getEditorService()
  if (!service?.checkDone) throw new Error("编辑器没有在进程内挂载（标记完成需要它）")

  const sourceVersion = String(version ?? "").trim()
  if (!/^[0-9a-f]{64}$/i.test(sourceVersion)) throw new Error("清榜核查缺少有效版本")
  if (!rows.length) return { updated: 0, rows: [] }

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
