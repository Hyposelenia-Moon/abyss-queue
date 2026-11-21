/**
 * 每日整理：让**编辑器**把每个「等待开启」挡位之间的顺序排成"已完成的在前、排队中的在后"
 *
 * **进程内直调**（`editor/service.js` 的注册表）：与 `#插队`（`model/move-row.js`）同一条路——
 * 编辑器就挂在 bot 自己的 http.Server 上，两个进程其实是同一个，没有理由再绕一圈 HTTP + 口令 + 签名。
 * 编辑器没挂载时直接报错，不做 HTTP 兜底。
 *
 * 为什么是编辑器干这件事：插件对表**只读**（见 `model/local.js`），换内容要动整张表、还要把
 * 绑定与完成情况锁里的行号一起搬走，只有拿着那张表的编辑器做得到。
 *
 * 约定：
 *   - 整理哪几个榜由 `sheet` 决定（不给 = 所有榜），规则在编辑器那侧（`editor/actions.js` 的 `tidy`）；
 *   - 抛错一律由调用方决定怎么回话，这里不吞错、也不把内部细节塞进群消息。
 */
import { getEditorService } from "../editor/service.js"
import { log } from "../components/logger.js"
import { ROSTER_QQ } from "./roster.js"

/**
 * 整理所有榜（给 `sheet` 就只整理那一个）
 *
 * @param {{sheet?: string}} [opts]
 * @returns {Promise<{ok: boolean, moved: number, tidied: Array<{sheet: string, moved: number, reason?: string}>, shiftRows?: Record<string, Record<string, number>>}>}
 *   `moved` = 一共挪了几行（0 = 本来就是这个顺序，**表与版本都没动**）
 * @throws {Error} 编辑器未挂载 / 整理失败
 */
export async function tidySheets({ sheet } = {}) {
  const service = getEditorService()
  if (!service?.tidy) throw new Error("编辑器没有在进程内挂载（整理需要它）")

  const out = await service.tidy({ qq: ROSTER_QQ, nick: "每日整理" }, { sheet: String(sheet ?? "") })

  const parts = (out.tidied ?? []).filter(t => t.moved).map(t => `${t.sheet} ${t.moved} 行`)
  log("info", `[abyss-queue] 每日整理完成：共挪 ${out.moved ?? 0} 行` + (parts.length ? `（${parts.join("、")}）` : "（本来就已经是有序的）"))
  return { ok: true, ...out }
}
