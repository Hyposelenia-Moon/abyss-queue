/**
 * QQ 的形态与归一（机器人侧与编辑器侧同一份实现）
 *
 * **权限只认 QQ**（AQ-01）：群昵称是本人随时能改的展示名，拿它当权限等于谁都能改名冒充。
 * 所以两层的白名单都只认 5–12 位数字，从群里复制的 `@12345` 也认，其余条目一律解析失败。
 *
 * 这条正则原来在 `editor/acl.js` 与 `model/whitelist.js` 各写了一遍；现在只有这一份。
 */
/** QQ 的形态：5–12 位数字 */
export const ACL_QQ = /^\d{5,12}$/

/** 把一条配置归一成 QQ；不是 QQ 就返回空串（`@12345` 这种从群里复制的写法也认） */
export const aclQq = raw => {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  const bare = s.replace(/^@+/, "").trim()
  return ACL_QQ.test(bare) ? bare : ""
}