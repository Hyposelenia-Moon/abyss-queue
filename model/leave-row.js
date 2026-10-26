/**
 * 退队：让**编辑器**清空调用者在本榜的那一行，并立刻整理该榜
 *
 * 插件对表只读；退队要清行、压紧、整理，只有编辑器能做。这里按调用者身份签名发：
 *   1. `/api/save`：整行字段全空 = 删除该行（编辑器内部会清行、压紧、留历史版本）；
 *   2. `/api/tidy`：机器人身份，立刻把该榜整理成「已完成在前、排队中在后」。
 *
 * 失败只抛错，调用方决定怎么回话；不重试。
 */
import { signedEditorQuery } from "./identity.js"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"

const timeoutMs = () => (Number(config.remote?.timeout_ms) > 0 ? Number(config.remote.timeout_ms) : 15000)
const baseUrl = () => String(config.remote?.url ?? "").trim().replace(/\/+$/, "")
const signKey = () => config.remote?.sign_key || config.remote?.token || ""

/** 与编辑器 ROSTER_QQ 同一口径 */
const ROSTER_QQ = "0"

const queryOf = (qq, nick) => {
  const q = signedEditorQuery({ qq, nick, token: config.remote?.token, signKey: signKey() })
  if (!q) throw new Error("没有可用的签名密钥（remote.sign_key / remote.token 都是空的）")
  return q
}

/**
 * 清空某一行
 * @returns {Promise<object>} 编辑器回执
 */
export async function leaveRow({ caller = {}, sheet, row } = {}) {
  const base = baseUrl()
  if (!base) throw new Error("还没配云端编辑器地址（config.yaml 的 remote.url）")
  const q = queryOf(caller.qq ?? "", caller.nick ?? "")
  const res = await fetch(`${base}/api/save?${q}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sheet,
      rows: [
        {
          row: Number(row),
          /** 退队专用：编辑器跳过必填校验，整行清空 */
          clear: true,
          values: { nickname: "", gameName: "", anchor: "", goal: "", strength: "", note: "", status: "" },
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs()),
  })
  const text = await res.text()
  let out = null
  try {
    out = JSON.parse(text)
  } catch {
    /* 非 JSON：按 HTTP 状态报 */
  }
  if (!res.ok || !out?.ok) throw new Error(out?.error || `编辑器返回 HTTP ${res.status}`)
  log("info", `[abyss-queue] 退队已提交：${sheet} 第 ${row} 行（${caller.nick || caller.qq || "？"}）`)
  return out
}

/**
 * 整理一个榜；不传 `sheet` 整理全部榜。
 * 用机器人身份（编辑器只让机器人或主人整理）；失败只记日志，不改变退队结果。
 */
export async function tidySheet(sheet = "") {
  const base = baseUrl()
  if (!base) return null
  try {
    const q = queryOf(ROSTER_QQ, "群成员名单")
    const res = await fetch(`${base}/api/tidy?${q}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sheet ? { sheet } : {}),
      signal: AbortSignal.timeout(timeoutMs()),
    })
    const text = await res.text()
    let out = null
    try {
      out = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    if (!res.ok || !out?.ok) throw new Error(out?.error || `编辑器返回 HTTP ${res.status}`)
    return out
  } catch (err) {
    log("warn", `[abyss-queue] 退队后的整理失败（${sheet || "全部榜"}）：${err?.message ?? err}`)
    return null
  }
}
