/**
 * 写操作的**请求级审计**：谁、什么时候、对哪个接口做了什么、成没成
 *
 * ## 为什么需要它
 *
 * 编辑器是公网可达、而且**能改表**的接口；宿主化之后它连自己的日志文件都没有了
 * （`setupLogFile` 只在独立跑时装），所以"表被改坏了"没法回溯是谁干的。
 *
 * ## 两条纪律
 *
 * 1. **只写显式给出的字段**：绝不把 `req.url` / query 拼进这一行——那里有口令 `?k=`。
 *    出口由宿主注入（宿主模式 = 框架 logger；独立模式 = `console`，独立跑时会落 `data/editor.log`）。
 * 2. **一行一条**：值里的空白压成一个空格、超长截断，免得把日志撑成多行。
 *
 * 口径见 `AGENTS.md` §3.10 与 `editor/README.md`；不在白名单里的写接口不会记（GET 一律不记）。
 */
export const makeAuditLog = ({ log, callerOf }) => {
  /** 本次请求要补的细节（由路由在成功点 `note()`）：req → {...} */
  const details = new WeakMap()

  /** 调用者标识：优先 QQ，管理口令入口标成 `(管理口令)`，拿不到就 `-` */
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
    /** 路由在成功点补一句细节（表名 / 行数 / 版本号…）；只放不会泄口令的东西 */
    note(req, extra) {
      if (!extra) return
      details.set(req, { ...(details.get(req) ?? {}), ...extra })
    },

    /**
     * 在 `handler` 开头装一次（此时才知道挂载前缀剥掉之后的 `action`）
     *
     * 记在响应 `finish` 上：**成功与失败都会记**（403/400 同样是有价值的审计——
     * "谁在试"和"谁改成了"一样重要）。
     */
    install(req, res, action) {
      if (req.method === "GET" || req.method === "HEAD") return
      res.on("finish", () => {
        const parts = [`qq=${whoOf(req)}`, `action=${action}`, `status=${res.statusCode}`]
        for (const [key, value] of Object.entries(details.get(req) ?? {})) {
          if (value === undefined || value === null || value === "") continue
          parts.push(`${key}=${String(value).replace(/\s+/g, " ").slice(0, 80)}`)
        }
        try {
          log(`[abyss-editor] ${parts.join(" ")}`)
        } catch {
          /* 日志出口自己出错不影响业务 */
        }
      })
    },
  }
}
