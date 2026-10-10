/**
 * HTTP 收发的基本动作：回 JSON、读请求体、取口令
 *
 * 这一层**不碰任何业务与配置**：只认 `req` / `res` / 入参，方便单独推敲边界
 * （请求体上限、JSON 解析失败、口令从 query 的哪个键取）。权限判定见同目录 `auth.js`。
 */

/**
 * 每个响应都带上的三个安全头（口径见 `editor/README.md` 与 `AGENTS.md` §3.10）
 *
 * 编辑器**公网可达、拿着口令就能改表**，所以：
 *   - `X-Frame-Options: DENY`：不许任何站点把它 iframe 套住——否则可以钓鱼，
 *     把编辑器套在诱饵页里、诱导已存口令的主人点"保存"（点击劫持）；
 *   - `Referrer-Policy: no-referrer`：口令在地址栏与 `?k=` 里，别让它顺着外链的 Referer 漏出去；
 *   - `X-Content-Type-Options: nosniff`：提示页是 HTML、接口是 JSON，别让浏览器猜类型（猜错就是 XSS 面）。
 *
 * **外加一份 CSP**（2026-10-10 审核 S-03 的落地）：页面里的两个内联 `<script>` 由首页路由注入
 * **每次响应都换的 nonce**（模板占位符 `__NONCE__`），所以脚本不必开 `unsafe-inline`；
 * 内联 `<style>` / `style=` 属性保留 `style-src 'unsafe-inline'`（页面本来就是内联样式写的）。
 * 这一条是 S-01/S-02（innerHTML 面）之外的**最后兜底**：真被塞进一段脚本，也执行不起来。
 */
export const SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

/**
 * 首页那份 CSP：脚本只认这个 nonce
 * @param {string} nonce 每次响应现生成（`editor.mjs` 注入模板）
 */
export const cspForPage = nonce =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")

/**
 * 其余 HTML（失效页 / 口令页 / 归属页）那份 CSP：**一条脚本都不许**
 *
 * 那些页面只有文字与内联样式，没有脚本，所以给最紧的一份；把它们和首页分开，
 * 首页的 nonce 就不会因为"顺手复用"而变成常量。
 */
export const CSP_PLAIN =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"

/**
 * 在任何响应写出**之前**调一次（`handler` 开头）：301 / 403 / 410 / 500 这些提前返回的路径同样受保护。
 * 首页那条路由会用 `cspForPage(nonce)` **再设一次**（同名头后者覆盖前者），其余路径留在 `CSP_PLAIN`。
 */
export const applySecurityHeaders = (res, { csp = CSP_PLAIN } = {}) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  if (csp) res.setHeader("content-security-policy", csp)
}

/** 回一坨 JSON：长度先算好再写（避免分块传输，也让前端能直接看 content-length） */
export const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body), "utf8")
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    /**
     * 接口响应里是**按身份裁剪过的行数据**：别让浏览器或中间代理缓存住。
     * `/api/meta`（页脚 / 版本）内容虽然公开，也一并 no-store——少一条例外就少一个坑。
     */
    "cache-control": "no-store",
  })
  res.end(buf)
}

/** JSON 请求体上限（4MB）：声明的是**接收量**的上限，别拿它当"存下来的量" */
export const JSON_BODY_LIMIT = 4 * 1024 * 1024

/** 超过声明上限：与"请求体不是合法 JSON"分开，上层才分得清是哪一种坏请求 */
export class BodyTooLarge extends Error {
  constructor(message) {
    super(message)
    this.name = "BodyTooLarge"
  }
}

/**
 * 按上限收请求体，超了就**停止保留**并只结算一次
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {number} limit 累计字节上限
 * @param {(chunks: Buffer[]) => any} receive 收全之后怎么解释这些分块（超限时不会被调用）
 * @returns {Promise<any>} 只 resolve / reject 一次
 */
const collectBody = (req, limit, receive) =>
  new Promise((resolve, reject) => {
    const chunks = []
    /** 累计字节数：分块长度之和。**不靠 Buffer.concat 的长度判断**——那等于每来一块就整份复制一次 */
    let size = 0
    /** 结算标志：第一次 reject 就是唯一一次；之后到达的分块一律不保留、也不再看 */
    let settled = false

    req.on("data", c => {
      if (settled) return
      size += c.length
      if (size > limit) {
        settled = true
        /**
         * 超限之后**不再把分块挂到数组里**，并立刻结算。
         *
         * 这里**不** `req.pause()`、也**不**主动 `req.destroy()`：两者都会让"已经写出去的错误响应"
         * 到不了对端（客户端只拿到 ECONNRESET，看起来像服务端崩了）。连接由 `connection: close`
         * 与 `res.end()` 收尾：剩下的字节照旧流过 socket，但既不进数组、也不再参与判断，
         * 所以内存占用与"声明上限"一致。真正的带宽截断交给反向代理的请求体限制。
         */
        reject(new BodyTooLarge(`请求体过大（>${Math.round(limit / 1024 / 1024)}MB）`))
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      try {
        resolve(receive(chunks))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", err => {
      if (settled) return
      settled = true
      /** 连接中断：把失败如实交出去（上层转成错误响应），不要在这里抛，否则会变成未捕获异常 */
      reject(err)
    })
  })

/** JSON 请求体（上限 4MB）：空体当 `{}`，解析不了就报错，由上层转成 400 */
export const readBody = req =>
  collectBody(req, JSON_BODY_LIMIT, chunks => (chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})).catch(
    err => {
      /** 超限的原因要原样带上去；解析失败则换成上层认识的那句 400 文案 */
      if (err instanceof BodyTooLarge) throw err
      throw new Error(`请求体不是合法 JSON：${err.message}`)
    },
  )

/** 原始字节的请求体（上传整张表用）：上限 32MB，与 replaceTable 的校验一致 */
export const readRawBody = (req, limit = 32 * 1024 * 1024) =>
  collectBody(req, limit, chunks => Buffer.concat(chunks))

/**
 * 访问口令 + 身份
 *
 * 口令（`?k=`）决定「能不能用这个服务」，身份签名（`?u=` `?s=`）决定「你是谁」。
 * 两者都在链接里，前端存进 localStorage 后随请求带上。
 *
 * **也能从请求头取**（2026-10-10 审核 S-04）：页面自己发的 `/api/*` 现在一律走请求头
 * （`x-abyss-token` / `x-abyss-identity` / `x-abyss-sign` / `x-abyss-admin`），
 * query 只在**导航**（首页 / 短链 302 / 下载链接 / 字体）里出现——那些请求改不了头。
 * 为什么重要：query 会进 nginx access log，等于每个 API 请求都往日志里写一遍完整凭证；
 * 头不会。**取法是"头优先、query 兜底"**：老的地址与老页面照旧能用（部署不必两头同时更新）。
 */
export const queryOf = req => new URL(req.url, "http://localhost")

/** query 里的某个键，没有就取请求头（`k` 对应 `x-abyss-token` 一类，见 `HEADER_OF`） */
export const HEADER_OF = {
  k: "x-abyss-token",
  u: "x-abyss-identity",
  s: "x-abyss-sign",
  a: "x-abyss-admin",
  w: "x-abyss-window",
  ws: "x-abyss-window-sign",
  /**
   * 链接的**唯一标记**（`?v=<nonce>`，签在短链的新鲜度那一段里，见 `model/identity.js` 的 `signFreshness`）
   *
   * 页面从地址里把它收进存储、之后每次请求用这个头带上：**"这条链接是不是该 QQ 最新那一条"
   * 由它说了算**（见 `editor/editor.mjs` 的 `linkStateOf`）。与时间窗同理——走头才不进 nginx 日志。
   */
  v: "x-abyss-link",
}
export const paramOf = (req, key) => {
  const header = String(req?.headers?.[HEADER_OF[key] ?? ""] ?? "").trim()
  if (header) return header
  return queryOf(req).searchParams.get(key) ?? ""
}

export const tokenOf = req => paramOf(req, "k") || paramOf(req, "token")

/**
 * 功能清单：写进 /healthz，用来比对「在线编辑器」与「本地编辑器」是不是同一版
 * 加了新功能就补一条，两台机器的 healthz 一比就知道谁落后了
 */
export const FEATURES = [
  "identity", // 个人链接签名身份
  "acl", // 白名单（可热改）
  "status-lock", // 主播改过的完成情况锁定
  "anchors", // 表头主播列表可维护
  "anchor-add", // 主播列表可新增主播（在最后一位下面插一行，下方整体下移）
  "anchor-options", // 下拉以主播列表为准
  "alias", // 主播别名
  "multi-select", // 选择主播 / 完成情况多选
  "exclusive-done", // 等待开启·排队中 与完成人互斥
  "self-done-nick", // 本人已完成 落成群昵称
  "archive-options", // 手填名字自动归档进下拉
  "warning-validation", // 表格下拉放宽为 warning（允许手写多值）
  "fields-status", // 完成情况字段
  "owner", // 主人（能维护白名单、看历史版本）
  "owner-only", // 本机编辑器：只有主人能打开
  "sign-key", // 身份签名密钥与访问口令分开
  "versions", // 历史版本 + 回退
  "archives", // 每月最后一次修改 + 每日归档（可下载）
  "upload", // 上传覆盖当前表 / 本机推云端
  "roster", // 群成员名单（群昵称候选 + 按 QQ 对账）
  "required4", // 必填四项：群昵称/游戏名/选择主播/难度
  "auto-status", // 完成情况按各榜开榜时间自动填
  "open-catchup", // 到点自动把「等待开启」翻成「排队中」
  "acl-qq", // 权限只认 QQ（群昵称只是展示名，白名单里的昵称条目会被拒绝并提示）
  "table-version", // 表版本（文件指纹）：/api/data 下发，保存/上传可带回来做冲突检测
  "replace-transition", // 整表替换时绑定与完成情况锁一起对账（换表不转移归属）
  "upload-validate", // 上传前逐表校验表头与必要列（空模板可以，空表壳不行）
  "lock-owner", // 完成情况锁带群昵称，压紧/换表时校验归属
  "anchor-version", // 主播列表保存也带表版本（与成员保存同一套 409 冲突检测）
  "reload-keep-drafts", // 「重新读取」默认保留草稿并列差异；丢草稿要显式点「丢弃草稿并重读」
  "ownership-audit", // 主人专用：归属状态审计 + 按当前表重建（方案 B：不给表加成员 ID 列）
]
