/** 「主播=公共队列，完成情况恰好只有一位主播」时，把公共选择收窄到这个人。 */
const FIXED_STATUS = new Set(["排队中", "等待开启", "本人已完成"])

export const autoAnchorOfStatus = (labels, nickname, anchors) => {
  const self = String(nickname ?? "").trim()
  const known = (anchors ?? []).map(anchor => String(anchor?.name ?? "").trim()).filter(Boolean)
  const anchorSet = new Set(known)
  const unique = [
    ...new Set(
      (Array.isArray(labels) ? labels : [])
        .map(label => String(label ?? "").trim())
        .filter(label => label && !FIXED_STATUS.has(label)),
    ),
  ]
  const picked = known.filter(name => name !== self && unique.includes(name))
  if (!picked.length) return { mode: "none", anchors: [] }
  const mixed = unique.some(label => label === self || !anchorSet.has(label))
  return mixed ? { mode: "public", anchors: [] } : { mode: "anchors", anchors: picked }
}

export const singleAnchorOfStatus = (labels, nickname, anchors) => {
  const self = String(nickname ?? "").trim()
  const unique = [
    ...new Set(
      (Array.isArray(labels) ? labels : [])
        .map(label => String(label ?? "").trim())
        .filter(label => label && !FIXED_STATUS.has(label)),
    ),
  ]
  if (unique.length !== 1) return ""
  const name = unique[0]
  if (name === self) return ""
  if (!(anchors ?? []).some(anchor => String(anchor?.name ?? "").trim() === name)) return ""
  return name
}
