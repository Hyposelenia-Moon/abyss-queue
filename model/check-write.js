/**
 * 清榜前核查：把已确认完成的人批量改成「本人已完成」。
 *
 * 与周期清榜同一套出站口径：只签机器人身份；编辑器在写队列内按 `version`
 * 做最终版本核验，期间有人改表就整批拒绝，不覆盖别人。
 */
import crypto from "node:crypto"
import { signedEditorQuery } from "./identity.js"
import { config } from "../components/config.js"
import { getRemote } from "./remote.js"
import { ROSTER_QQ } from "./roster.js"

const timeoutMs = () => (Number(config.remote?.timeout_ms) > 0 ? Number(config.remote.timeout_ms) : 15000)

const endpoint = () => {
  const base = String(config.remote?.url ?? "").trim().replace(/\/+$/, "")
  if (!base) throw new Error("还没配云端编辑器地址（config.yaml 的 remote.url）")
  const key = config.remote?.sign_key || config.remote?.token
  const query = signedEditorQuery({ qq: ROSTER_QQ, nick: "清榜核查", token: config.remote?.token, signKey: key })
  if (!query) throw new Error("没有可用的签名密钥（remote.sign_key / remote.token 都是空的）")
  return { base, query }
}

/** 当前完整源 XLSX 的摘要，编辑器用它判版本冲突 */
export async function tableVersion() {
  const buffer = await getRemote().snapshotBuffer({ force: true })
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

/**
 * @param {{sheet:string, version:string, rows:Array<{row:number, nickname:string, goal?:string}>}} opts
 * @returns {Promise<{updated:number, rows:number[]}>}
 */
export async function markChecked({ sheet, version, rows = [] } = {}) {
  const sourceVersion = String(version ?? "").trim()
  if (!/^[0-9a-f]{64}$/i.test(sourceVersion)) throw new Error("清榜核查缺少有效版本")
  if (!rows.length) return { updated: 0, rows: [] }
  const { base, query } = endpoint()
  const res = await fetch(`${base}/api/check-done?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sheet: String(sheet),
      version: sourceVersion,
      rows: rows.map(r => ({ row: Number(r.row), nickname: String(r.nickname), goal: r.goal })),
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
  return out
}
