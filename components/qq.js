/** QQ 的形态与归一（机器人侧与编辑器侧同一份实现） */

export const ACL_QQ = /^\d{5,12}$/

export const aclQq = raw => {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  const bare = s.replace(/^@+/, "").trim()
  return ACL_QQ.test(bare) ? bare : ""
}
