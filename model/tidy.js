/**
 * 每日整理：让**编辑器**把每个「等待开启」挡位之间的顺序排成"已完成的在前、排队中的在后"
 *
 * 为什么是编辑器干这件事：与 `#插队`（`model/move-row.js`）同一条理由——插件对表**只读**
 * （见 `model/remote.js`），换内容要动整张表、还要把绑定与完成情况锁里的行号一起搬走，
 * 只有拿着那张表的编辑器做得到。所以这里只负责一件事：签一个**机器人身份**，把请求发过去。
 *
 * 三条与 `model/roster.js` / `model/move-row.js` 同一口径的约定：
 *   - 地址与口令取自 `config.remote`（插件侧的唯一来源），身份用 `model/identity.js` 现签；
 *   - 非 2xx / `ok:false` / 非 JSON 一律当失败抛出（调用方按"这次没整理成"处理），**不重试**；
 *   - 失败只由调用方决定怎么说，这里不吞错、也不把编辑器的原始响应塞进群消息。
 */
import { signIdentity } from "./identity.js"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"
import { ROSTER_QQ } from "./roster.js"

/** 超时：与拉快照同一档（`remote.timeout_ms`），非法值回落到 15 秒 */
const timeoutMs = () => (Number(config.remote?.timeout_ms) > 0 ? Number(config.remote.timeout_ms) : 15000)

/**
 * 调 `/api/tidy`：整理所有榜（给 `sheet` 就只整理那一个）
 *
 * @param {{sheet?: string}} [opts]
 * @returns {Promise<{moved: number, tidied: Array<{sheet: string, moved: number, reason?: string}>}>}
 *   编辑器的回执：`moved` = 一共挪了几行（0 = 本来就是这个顺序，**表与版本都没动**）
 * @throws {Error} 没配地址 / 签不出身份 / 编辑器拒绝 / 网络不通
 */
export async function tidySheets({ sheet } = {}) {
  const base = String(config.remote?.url ?? "").trim().replace(/\/+$/, "")
  if (!base) throw new Error("还没配云端编辑器地址（config.yaml 的 remote.url）")

  const key = config.remote?.sign_key || config.remote?.token
  const id = signIdentity({ qq: ROSTER_QQ, nick: "每日整理" }, key)
  if (!id) throw new Error("没有可用的签名密钥（remote.sign_key / remote.token 都是空的）")

  const url = `${base}/api/tidy?k=${encodeURIComponent(config.remote?.token ?? "")}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sheet ? { sheet: String(sheet) } : {}),
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

  const parts = (out.tidied ?? []).filter(t => t.moved).map(t => `${t.sheet} ${t.moved} 行`)
  log("info", `[abyss-queue] 每日整理完成：共挪 ${out.moved ?? 0} 行` + (parts.length ? `（${parts.join("、")}）` : "（本来就已经是有序的）"))
  return out
}
