/** 发送回执 → 撤回句柄 / message id（各适配器形状不一，统一在这里认） */

export function messageHandlesOf(res) {
  const list = Array.isArray(res) ? res : [res]
  const out = []
  const add = value => {
    if (value == null || value === "") return
    if (typeof value === "number" && !Number.isFinite(value)) return
    if (out.some(one => Object.is(one, value))) return
    out.push(value)
  }
  for (const one of list) {
    if (one == null) continue
    if (typeof one !== "object") {
      add(one)
      continue
    }
    const looksLikeSatoriMessage = one.channel != null || one.guild != null || one.content != null
    const satoriId = looksLikeSatoriMessage ? (one.id ?? null) : null
    const id = one.message_id ?? one.messageId ?? satoriId
    if (id != null) {
      add(id)
      continue
    }
    const data = one.data
    if (data != null) {
      if (typeof data !== "object") {
        add(data)
        continue
      }
      const nested = data.message_id ?? data.messageId ?? data.message_seq ?? data.messageSeq
      if (nested != null) {
        add(nested)
        continue
      }
      if (data.data != null && typeof data.data !== "object") {
        add(data.data)
        continue
      }
    }
    add(one)
  }
  return out
}

export function messageIdsOf(res) {
  const out = []
  for (const one of messageHandlesOf(res)) {
    if (one && typeof one === "object") continue
    const text = String(one).trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

export function messageIdOf(res) {
  return messageIdsOf(res)[0] ?? ""
}
