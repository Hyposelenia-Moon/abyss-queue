/**
 * 周期清榜：只签机器人身份，让编辑器执行"删行 / 翻等待行"。
 *
 * 与 `model/tidy.js` / `model/leave-row.js` 同一套出站口径：
 *   - 地址、口令取自 `config.remote`；
 *   - 身份用 `signedEditorQuery({ qq: ROSTER_QQ })` 现签，**必须带当期窗口**；
 *   - 非 2xx / `ok:false` 一律抛出，由上层决定私聊主人和重试。
 */
import { signedEditorQuery } from "./identity.js"
import { config } from "../components/config.js"
import { ROSTER_QQ } from "./roster.js"

const timeoutMs = () => (Number(config.remote?.timeout_ms) > 0 ? Number(config.remote.timeout_ms) : 15000)

const endpoint = () => {
  const base = String(config.remote?.url ?? "").trim().replace(/\/+$/, "")
  if (!base) throw new Error("还没配云端编辑器地址（config.yaml 的 remote.url）")
  const key = config.remote?.sign_key || config.remote?.token
  const query = signedEditorQuery({ qq: ROSTER_QQ, nick: "周期清榜", token: config.remote?.token, signKey: key })
  if (!query) throw new Error("没有可用的签名密钥（remote.sign_key / remote.token 都是空的）")
  return { base, query }
}

const parse = async res => {
  const text = await res.text()
  let out = null
  try {
    out = JSON.parse(text)
  } catch {
    /* 非 JSON：按 HTTP 状态报 */
  }
  if (!res.ok || !out?.ok) throw new Error(out?.error || `编辑器返回 HTTP ${res.status}`)
  return out
}

/**
 * 这一轮是否已经在服务端执行过。
 * 客户端**必须在下载/覆盖归档之前**调用，避免回执丢失后的重试覆盖归档。
 */
export async function cycleStatus(eventKey) {
  const { base, query } = endpoint()
  const key = String(eventKey ?? "").trim()
  if (!key) throw new Error("缺少 eventKey")
  const res = await fetch(
    `${base}/api/cycle/status?${query}&eventKey=${encodeURIComponent(key)}`,
    { signal: AbortSignal.timeout(timeoutMs()) },
  )
  const out = await parse(res)
  return { done: Boolean(out.done), pending: Boolean(out.pending), protocol: Number(out.protocol) }
}

/**
 * @param {{sheet:string, mode:"all"|"queued-done"|"done"|"promote", promote?:false|"all"|"future-real", eventKey:string, version:string}} opts
 * @returns {Promise<{sheet:string, cleared:number, promoted:number}>}
 */
export async function cycleWrite({ sheet, mode, promote = false, eventKey = "", version = "" } = {}) {
  const key = String(eventKey ?? "").trim()
  const sourceVersion = String(version ?? "").trim()
  if (!key) throw new Error("周期清榜缺少 eventKey")
  if (!/^[0-9a-f]{64}$/i.test(sourceVersion)) throw new Error("周期清榜缺少有效的归档源版本")
  const { base, query } = endpoint()
  const res = await fetch(`${base}/api/cycle?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sheet: String(sheet),
      mode,
      promote,
      eventKey: key,
      version: sourceVersion,
    }),
    signal: AbortSignal.timeout(timeoutMs()),
  })
  return parse(res)
}
