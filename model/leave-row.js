/**
 * 退队：让**编辑器**清空调用者在本榜的那一行，并立刻整理该榜
 *
 * 插件对表只读；退队要清行、压紧、整理，只有编辑器能做。这里是进程内直调（与 `#插队` 同一条路）：
 *   1. `save`：整行字段全空 = 删除该行（编辑器内部会清行、压紧、留历史版本）；
 *   2. `tidySheets`：机器人身份，立刻把该榜整理成「已完成在前、排队中在后」。
 *
 * 失败只抛错，调用方决定怎么回话；不重试。
 */
import { getEditorService } from "../editor/service.js"
import { log } from "../components/logger.js"
import { tidySheets } from "./tidy.js"

/**
 * 清空某一行
 * @returns {Promise<object>} 编辑器回执
 */
export async function leaveRow({ caller = {}, sheet, row } = {}) {
  const service = getEditorService()
  if (!service?.save) throw new Error("编辑器没有在进程内挂载（退队需要它）")
  /**
   * 按管理员走：要清哪一行是插件侧（`apps/leaver.js` 的 `findOwnRow`）认过的，
   * 用 `self` 反而会被**额度与两条红线**拦下（那是给别人用的约束），详见 `editor/actions.js`。
   */
  const out = await service.save(
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

/**
 * 整理一个榜；不传 `sheet` 整理全部榜。
 * 用机器人身份（编辑器只让机器人或主人整理）；失败只记日志，不改变退队结果。
 */
export async function tidySheet(sheet = "") {
  try {
    return await tidySheets({ sheet: String(sheet ?? "") })
  } catch (err) {
    log("warn", `[abyss-queue] 退队后的整理失败（${sheet || "全部榜"}）：${err?.message ?? err}`)
    return null
  }
}
