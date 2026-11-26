/** 写操作的**请求级审计**：谁、什么时候、对哪个接口做了什么、成没成 */

export const oneLine = value => String(value ?? "").replace(/\s+/g, " ")

export const makeAuditLog = ({ log, callerOf }) => {
  const details = new WeakMap()
  const whoOf = req => {
    try {
      const caller = callerOf(req)
      if (caller?.identity?.qq) return String(caller.identity.qq)
      return caller?.adminTokenOk ? "(管理口令)" : "-"
    } catch {
      return "?"
    }
  }
  return {
    note(req, extra) {
      if (!extra) return
      details.set(req, { ...(details.get(req) ?? {}), ...extra })
    },
    install(req, res, action) {
      if (req.method === "GET" || req.method === "HEAD") return
      res.on("finish", () => {
        const parts = [`qq=${whoOf(req)}`, `action=${action}`, `status=${res.statusCode}`]
        for (const [key, value] of Object.entries(details.get(req) ?? {})) {
          if (value === undefined || value === null || value === "") continue
          parts.push(`${key}=${oneLine(value).slice(0, 80)}`)
        }
        try {
          log(`[abyss-editor] ${parts.join(" ")}`)
        } catch {
        }
      })
    },
  }
}
