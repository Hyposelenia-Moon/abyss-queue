/**
 * 插队：让**编辑器**把表里某一行挪到它上方最近的一位「排队中」前面
 *
 * 为什么是编辑器干这件事：插件对表**只读**（见 model/remote.js）——挪行要动整张表、
 * 还要把绑定与完成情况锁里的行号一起搬走，只有拿着那张表的编辑器做得到。
 * 所以这条路只负责一件事：按调用者的身份签一个名，把"哪一榜、哪一行、怎么挪"发过去。
 *
 * 三条与 `model/roster.js` 同一口径的约定：
 *   - 地址与口令取自 `config.remote`（插件侧的唯一来源），身份用 `model/identity.js` 现签；
 *   - 非 2xx / `ok:false` / 非 JSON 一律当失败抛出（调用方按"没改成"回话），**不重试**；
 *   - 失败只由调用方决定怎么说，这里不吞错、也不把编辑器的原始响应塞进群消息。
 */
import { signIdentity } from "./identity.js"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"

/** 超时：与拉快照同一档（`remote.timeout_ms`），非法值回落到 15 秒 */
const timeoutMs = () => (Number(config.remote?.timeout_ms) > 0 ? Number(config.remote.timeout_ms) : 15000)

/**
 * 调 `/api/move-row`：把 `row` 那一行挪到它上方最近的一位「排队中」前面
 *
 * @param {object} opts
 * @param {{qq?: string|number, nick?: string}} opts.caller 发起这次插队的人（签进身份）
 * @param {string} opts.sheet 榜名（表里的全名）
 * @param {number} opts.row 要挪的那一行的行号
 * @param {string} [opts.nick] 目标成员的群昵称（只进编辑器日志，不影响判定）
 * @returns {Promise<object>} 编辑器的回执：`{ ok, moved, from, to, nickname, crossed, reason? }`
 * @throws {Error} 没配地址 / 签不出身份 / 编辑器拒绝 / 网络不通
 */
export async function moveRow({ caller = {}, sheet, row, nick = "" } = {}) {
  const base = String(config.remote?.url ?? "").trim().replace(/\/+$/, "")
  if (!base) throw new Error("还没配云端编辑器地址（config.yaml 的 remote.url）")

  const key = config.remote?.sign_key || config.remote?.token
  const id = signIdentity({ qq: caller.qq ?? "", nick: caller.nick ?? "" }, key)
  if (!id) throw new Error("没有可用的签名密钥（remote.sign_key / remote.token 都是空的）")

  const url = `${base}/api/move-row?k=${encodeURIComponent(config.remote?.token ?? "")}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheet, row: Number(row), mode: "before-last-queued", nick }),
    signal: AbortSignal.timeout(timeoutMs()),
  })
  const text = await res.text()
  let out = null
  try {
    out = JSON.parse(text)
  } catch {
    /* 非 JSON（错误页 / 代理页面）：按 HTTP 状态报 */
  }
  if (!res.ok || !out?.ok) throw new Error(out?.error || `编辑器返回 HTTP ${res.status}`)

  log("info", `[abyss-queue] 插队已提交：${sheet} 第 ${row} 行${nick ? `（${nick}）` : ""} → ${out.moved ? `第 ${out.to} 行` : "未移动"}`)
  return out
}
