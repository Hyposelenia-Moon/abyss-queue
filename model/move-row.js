/**
 * 插队：把某一行挪到这一榜所有「排队中」的人最前面
 *
 * **进程内直调**（`editor/service.js` 的注册表）：编辑器就挂在 bot 自己的 http.Server 上，
 * 两个进程其实是同一个，没有理由再绕一圈 HTTP + 口令 + 签名。
 * 编辑器没挂载时直接报错，不做 HTTP 兜底——消费者的铁律是"只有 abyss-queue 自己"。
 *
 * 三条约定：
 *   - 权限由编辑器那侧判（`caller.role` 必须是 admin），这里只负责把发起人带过去；
 *   - 抛错一律由调用方决定怎么回话，这里不吞错、也不把内部细节塞进群消息；
 *   - 不再需要签名：进程内没有"网关"，也就没有可冒充的身份。
 */
import { getEditorService } from "../editor/service.js"
import { log } from "../components/logger.js"

/**
 * @param {object} opts
 * @param {{qq?: string|number, nick?: string}} [opts.caller] 发起这次插队的人
 * @param {string} opts.sheet 榜名
 * @param {number} opts.row 要挪的那一行的行号
 * @param {string} [opts.nick] 目标成员的群昵称（只进日志，不影响判定）
 * @returns {Promise<object>} 回执：`{ ok, moved, from, to, nickname, crossed, reason? }`
 * @throws {Error} 编辑器未挂载 / 权限不足 / 行号不合法
 */
export async function moveRow({ caller = {}, sheet, row, nick = "" } = {}) {
  const service = getEditorService()
  if (!service?.moveRow) throw new Error("编辑器没有在进程内挂载（插队需要它）")

  const out = await service.moveRow(
    { role: "admin", qq: String(caller.qq ?? ""), nick: String(caller.nick ?? "") },
    { sheet: String(sheet ?? ""), row: Number(row), mode: "queue-front", nick: String(nick ?? "") },
  )

  log(
    "info",
    `[abyss-queue] 插队：${sheet} 第 ${row} 行${nick ? `（${nick}）` : ""} → ${out?.moved ? `第 ${out.to} 行` : "未移动"}`,
  )
  return { ok: true, ...out }
}
