/**
 * 套件专用：拼一条带身份的编辑器查询串
 *
 * 以前这个拼法住在 `model/identity.js`（`signedEditorQuery`），是给**插件**出站请求用的。
 * 插件侧的写操作全部改成进程内直调之后，生产代码里已经没有调用者——只剩这几个套件
 * 需要"以某个 QQ 的身份去打编辑器的 HTTP 端点"（验的是编辑器自己的路由与权限闸）。
 *
 * 所以它搬到这里：口径仍是编辑器认的那一套（`k` + `u/s` + 当期 `w/ws`），
 * 但不再混在插件的身份模块里，避免下一个人以为生产链路还在用它。
 *
 * 注意：文件名以 `_` 开头且不是 `*.test.mjs`，运行器不会把它当套件。
 */
import { signIdentity, signWindow } from "../../model/identity.js"

const secretOf = value => {
  const v = String(value ?? "").trim()
  return v || ""
}

/**
 * @param {object} opts
 * @param {string|number} opts.qq   身份（谁在发这条请求）
 * @param {string} [opts.nick]      身份里的群昵称
 * @param {string} [opts.token]     访问口令（`k=`）
 * @param {string} [opts.signKey]   身份签名密钥（缺省退回用口令签，与插件侧同口径）
 * @param {number} [opts.now]       签发时刻（可选）
 * @returns {string} 查询串（不带 `?`）
 */
export function signedQuery({ qq = "", nick = "", token = "", signKey = "", now = Date.now() } = {}) {
  const pass = secretOf(token)
  const key = secretOf(signKey) || pass
  const id = signIdentity({ qq, nick }, key, now)
  if (!id) return ""
  const params = []
  if (pass) params.push(`k=${encodeURIComponent(pass)}`)
  params.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
  const win = signWindow({ qq }, key, now)
  if (win) params.push(`w=${win.w}`, `ws=${encodeURIComponent(win.ws)}`)
  return params.join("&")
}
