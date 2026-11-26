/**
 * HTTP 分发：按路径把请求交给对应的处理段
 *
 * 这里只做分发与请求级装配，业务实现仍在装配根与各域模块里——它们经 `deps` 注入，
 * 这样本文件不用 import 装配根（会成环），也不用碰进程内的服务单例。
 */
export const createHandler = deps => {
  const {
    ADMIN_TOKEN,
    ARCHIVES_DIR,
    ARCHIVE_DAYS,
    AVATAR_CACHE_MAX,
    AVATAR_CACHE_MS,
    BIND,
    BodyTooLarge,
    CHANGES_KEEP,
    CLOUD_URL,
    ENV_ADMINS,
    FEATURES,
    FIELDS,
    FONT_FILES,
    MOUNT,
    OWNER_ONLY,
    PLUGIN_DIR,
    PORT,
    RE_VERSION,
    ROSTER_QQ,
    SIGN_KEY,
    TEMPLATE,
    TOKEN,
    VERSIONS_DIR,
    VERSIONS_KEEP,
    aclAudit,
    aclQq,
    addExtraName,
    adminFileList,
    adminSessionOf,
    adminSessionOk,
    alignOwnership,
    applyAnchorCall,
    applyAnchors,
    applyCall,
    applyCheckDone,
    applyCycle,
    applyCycleStatus,
    applyLinkCode,
    applyMoveRow,
    applyRoster,
    applySave,
    applySecurityHeaders,
    applyTidy,
    archiveOptions,
    attackVersions,
    auditLog,
    authorized,
    avatarCache,
    buildPayload,
    callerNow,
    canManageAdmins,
    catchUpOpenStatus,
    changeAuthor,
    changes,
    clientIpOf,
    cloudVersion,
    compileAliases,
    config,
    crypto,
    cspForPage,
    decodeIdentity,
    drainRequest,
    ensureExtraNames,
    entryPage,
    expiredLinkPage,
    fetchAvatar,
    fingerprintFast,
    footerHtml,
    fs,
    fsp,
    http,
    innerPath,
    json,
    linkGuard,
    listArchives,
    listVersions,
    loadAdmins,
    loadOwners,
    loadRoster,
    logThrottled,
    maybeAlertStaleRoster,
    memberStateOf,
    mineRows,
    missingCandidates,
    nickOf,
    ownerOnlyPage,
    ownership,
    ownershipAudit,
    paramOf,
    path,
    pluginVersion,
    pruneMissingRows,
    readBody,
    readRawBody,
    rebuildOwnershipNow,
    recordChanges,
    replaceTable,
    resolveStoredFile,
    roleOf,
    roster,
    rosterQqOfNick,
    saveAdmins,
    sendAvatar,
    sendText,
    setAdminSession,
    signIdentity,
    signWindow,
    store,
    syncIdentity,
    table,
    verifyWindow,
    versions,
    xlsxPath,
  } = deps
  return async (req, res) => {
  /**
   * 安全响应头在**路由之前**设好：301 / 403 / 410 / 500 这些提前返回的路径也全部带上
   * （三个头是什么、为什么不加整份 CSP，见 `http/respond.js` 的 `SECURITY_HEADERS`）
   */
  applySecurityHeaders(res)
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
  const pathname = innerPath(url.pathname)
  /** 审计：非 GET 的请求在响应结束时记一行（成功与失败都记；行里**不含** query，所以不会带口令） */
  auditLog.install(req, res, pathname)

  /**
   * 尾斜杠规范化：`<前缀>` → `<前缀>/`（301）
   *
   * 首页里的请求全是**相对路径**（`api/data`、`api/meta`、`font/cn.woff`）：地址栏不以 `/` 结尾时，
   * 浏览器会把它们解析到**站根**（`/api/data`），在子路径部署下就是一连串 404（数据、字体、页脚全没了）。
   * 把规范形式固定下来，页面自己不用再拼前缀。
   */
  if (pathname === "/" && url.pathname.length > 1 && !url.pathname.endsWith("/")) {
    res.writeHead(301, { location: `${url.pathname}/${url.search ?? ""}`, "cache-control": "no-store" })
    return res.end()
  }

  /**
   * 网页标签页图标（favicon）——**先于口令校验**
   *
   * 浏览器请求 favicon 时**不带 `?k=`**（页面口令存在 localStorage 里，不是 cookie），
   * 所以这条必须排在 `authorized()` 之前，否则正式部署会拿到 403、标签页图标根本不显示。
   * 它只是随插件入库的一张图（`resources/image/`），不含任何数据，公开无妨。
   *
   * **为什么用 256 那版**：favicon 会被浏览器按 16/32/48 画到标签页，还会被"固定到任务栏"
   * 或当 apple-touch-icon 用（可达 180），64 那版在这些位置只能靠插值放大、发虚。
   * 代价是首次访问多下 ~264KB（`max-age=86400`，之后一天内走缓存）；
   * 面板那边的图标由锅巴直接读 64 那版（显示尺寸小，够用）。
   *
   * 按自己算出的插件根去读，**不需要单独的启动参数**；两份都拿不到时回落 64 那版，再不行 404。
   */
  if (req.method === "GET" && pathname === "/favicon.ico") {
    const candidates = ["HuTao_LeLouvre_256.ico", "HuTao_LeLouvre.ico"]
    for (const name of candidates) {
      try {
        const buf = await fsp.readFile(path.join(PLUGIN_DIR, "resources", "image", name))
        res.writeHead(200, {
          "content-type": "image/x-icon",
          "content-length": String(buf.length),
          "cache-control": "public, max-age=86400",
        })
        return res.end(buf)
      } catch {
        /* 换下一份候选 */
      }
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    return res.end("favicon unavailable")
  }

  /**
   * 头像代理：**公开**（与 favicon 同一个理由）
   *
   * 页面里的 `<img src>` 带不了 `x-abyss-*` 请求头，而口令存在 localStorage（不是 cookie），
   * 所以这条必须排在 `authorized()` 之前；CSP 又是 `img-src 'self' data:`，外链头像根本进不来
   * ——只能从自己的源把图转出去。
   *
   * 安全边界：只认纯数字 QQ（5–12 位），上游地址按 `AVATAR_HOSTS` 白名单挑，
   * **没有任意 URL 参数**；公开也拿不到表里的数据（QQ 头像本来就是公开图）。
   */
  if (req.method === "GET" && pathname === "/api/avatar") {
    const qq = String(paramOf(req, "qq") ?? "").trim()
    if (!/^\d{5,12}$/.test(qq)) return json(res, 400, { ok: false, error: "qq 不对" })
    const hit = avatarCache.get(qq)
    if (hit && Date.now() - hit.at < AVATAR_CACHE_MS) return sendAvatar(res, hit)
    const got = await fetchAvatar(qq)
    if (!got) return json(res, 404, { ok: false, error: "没取到这个人的头像" })
    const entry = { ...got, at: Date.now() }
    avatarCache.set(qq, entry)
    if (avatarCache.size > AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value)
    return sendAvatar(res, entry)
  }

  /**
   * 固定入口页的口令兑换：**公开**（页面本身不带口令）
   *
   * 群消息里只有 6 位数字口令，没有完整 URL；用户在这里换成完整链接再跳转。
   * 这能避开 QQ 对群消息里每条新 URL 的风控，同时不需要另建一套编号表：`v` 本来就在
   * `model/editor-links.js` 的登记簿里，机器人发链接时把完整链接一起记进去。
   *
   * **口令只有 6 位数字、这个端点又是公开的**，所以必须防枚举（两轮见 `http/link-guard.js`）：
   *   1. 同一来源 IP 失败太多次 ⇒ 冷却期内一律 429（`retry-after` 给出还要等几秒）；
   *   2. 无效 / 过期回**同一句** 410，不让枚举者从响应里区分"差一点"。
   *
   * 成功兑换**不计数、不作废**（维护者 2026-11-26：链接面向所有群成员，要允许多名成员重复点）：
   * 同一条口令在 `LINK_CODE_TTL_MS`（5 分钟）内来多少次都换回同一条完整链接，过期后自然 410。
   * 失败只 `fail`，不消耗口令（否则一个问题口令就能把好的挤掉）。
   */
  if (req.method === "GET" && pathname === "/api/link-code") {
    const ip = clientIpOf(req)
    if (!linkGuard.allow(ip)) {
      const wait = Math.ceil(linkGuard.retryAfterMs(ip) / 1000)
      res.setHeader("retry-after", String(Math.max(wait, 1)))
      return json(res, 429, { ok: false, error: "试得太频繁了，请过几分钟再回群里重新发一次 #排队" })
    }
    const code = String(paramOf(req, "code") ?? "").trim()
    /** 实现已搬到 `editor/actions.js` 的 `linkCode`（进程内同一份），端点只做请求解析与响应映射 */
    const { url } = code ? await applyLinkCode(null, { code }) : { url: null }
    if (!url) {
      linkGuard.fail(ip)
      return json(res, 410, { ok: false, error: "口令不对或已过期，请回群里重新发一次 #排队" })
    }
    linkGuard.succeed(ip)
    return json(res, 200, { ok: true, url })
  }

  const adminSession = adminSessionOf(req)
  const adminCookieOk = Boolean(adminSession && roleOf({ qq: adminSession.qq }).role === "admin")

  if (!authorized(req) && !adminCookieOk) {
    if (pathname === "/" || pathname === "/index.html") {
      /** 入口页有脚本（口令兑换 / 记着的访问口令自动补回），CSP 用一次一换的 nonce */
      const nonce = crypto.randomBytes(16).toString("base64url")
      applySecurityHeaders(res, { csp: cspForPage(nonce) })
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(entryPage(nonce))
    }
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
    return res.end("forbidden")
  }

  /** 管理员用 cookie 直接回来时，顺手把这 24 小时续期 */
  if (adminCookieOk) setAdminSession(req, res, adminSession.qq)

  /**
   * 链接的**时间窗**：带 `w/ws` 的链接要在当期窗口内（管理员 / 私聊链接用）
   *
   * 身份签名（`u/s`）管 30 天，这层窗口管 5 分钟（`model/identity.js` 的 `WINDOW_MS`）：
   * 机器人每 5 分钟换一批链接，旧链在路上超过一个窗口就作废。过期时刻**签在链接里**
   * （`w/ws`），所以这里不需要服务器记住"这条链是什么时候发的"。
   *
   * 这几层共存时谁先说话：
   *   1. 带 `w/ws`：验不过就**拒绝**（410 + 可读页）——旧窗口的链接一律作废；
   *   2. **没带 `w/ws` 的身份链接：照旧放行**（群友的 `#code=` 短码兑换出来的就是这一档）。
   *
   * **页面自身的请求不带窗口**：编辑器页面打开链接时把 `k/u/s/a` 收进存储、把地址栏清干净
   * （见 `editor.html` 的 `withToken()`），之后每一次 `/api/*` 都只带身份不带窗口；
   * 这些请求**按第 2 条放行**。
   *
   * 拒绝给的是 410 + 可读页面（与链接失效同一份文案）：拿到旧链的人需要知道的是
   * "回群里重新取一条"，而不是"口令错了"。
   */
  {
    /** 时间窗与身份都走 `paramOf`：**请求头优先、query 兜底**（页面自己发的请求走头，见审核 S-04） */
    const w = paramOf(req, "w")
    const ws = paramOf(req, "ws")
    if (w || ws) {
      const linkQq = String(decodeIdentity(paramOf(req, "u"))?.qq ?? "")
      if (!verifyWindow(w, ws, { qq: linkQq }, SIGN_KEY)) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        return res.end(expiredLinkPage())
      }
      /**
       * 记一笔"这条链接带的是当期的窗口"（只作诊断用）；**管理员在这里进门**并种下 24 小时的会话
       * （见 `ADMIN_SESSION_COOKIE` 的说明：窗口过了之后，管理员不再能靠"删掉 w/ws"继续当管理员）
       */
      callerNow(req).windowed = true
      if (linkQq && roleOf({ qq: linkQq }).role === "admin") setAdminSession(req, res, linkQq)
    }
    /**
     * **没带 `w/ws` 却有身份链接（`u/s` 那一档）：照旧放行**
     *
     * 群友的 `#code=` 短码兑换出来的就是这一档：身份签名本身管 30 天，没有 5 分钟窗口。
     * 能写多少不在这里判——由**本群守卫**（`memberStateOf`）、额度与三条红线决定。
     */
  }

  /**
   * **管理员身份必须有当期窗口、或者窗口进门时种下的会话**（2026-10-18 审核 P1）
   *
   * 管理链接的 `w/ws` 只有 5 分钟，而"带身份、不带窗口"是放行的 ⇒ 把窗口参数删掉，就能让一条
   * 老管理链接在身份签名的 30 天里一直当管理员。现在：管理员只能从"窗口刚验过的那一刻"进门
   * （那一刻已种下 24 小时的会话 cookie，见 `setAdminSession`）；这之后不带窗口的管理员请求
   * 要么带会话 cookie，要么按**过期链接**处理（410 + 提示页，让用户回群里重新取链接）。
   *
   * 管理口令（`?a=`）不走这条路：它是独立的静态凭证，由页面存起来按请求头带，与时间窗无关。
   */
  {
    const state = callerNow(req)
    const qq = String(state.value?.identity?.qq ?? "").trim()
    if (state.value?.role === "admin" && !state.windowed && !state.value?.adminTokenOk && qq && !adminSessionOk(req, qq)) {
      logThrottled(
        `admin-window|${qq}`,
        `[editor] 管理员身份没有当期窗口、也没有会话 cookie（qq=${qq}，${pathname}）：按过期链接处理`,
      )
      res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(expiredLinkPage())
    }
  }

  /**
   * 只给主人用（本机编辑器用这个开关开着）
   *
   * 本机那份是云端数据的备份/工作副本，只让主人碰：其他人一律挡在门外，
   * 免得群友在本机界面上改到备份、又被传回云端。
   * 例外是几个**只读且不含表格数据**的口子，它们本来就只凭口令放行：
     *   - `/api/version`：推表前问一版（只回表指纹）
   *   - `/api/meta`：页面元信息（页脚 HTML / 版本 / 版本份数）——不给的话"需要口令"页也拉不到页脚
   *   - `/healthz`：启动器 / 运维探活
   */
  if (
    OWNER_ONLY &&
    pathname !== "/api/version" &&
    pathname !== "/api/meta" &&
    pathname !== "/healthz"
  ) {
    const owner = callerNow(req).value
    if (!owner.owner && !owner.adminTokenOk) {
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" })
        return res.end(ownerOnlyPage())
      }
      return json(res, 403, { ok: false, error: "本机编辑器只有主人能打开；群友请用群里 #排队 拿到的链接（云端编辑器）" })
    }
  }

  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await fsp.readFile(TEMPLATE, "utf8")
      /**
       * 模板里的 `__MOUNT__` 换成**这次请求实际带的前缀**（nginx 原样转发时就是它；剥掉前缀时是空串，
       * 那时图标就是 `/favicon.ico`）。页面里的图标 href 因此不再是"站根绝对路径"——
       * 挂在 `/queue` 下时指到站根会被框架 404，那条路径不归编辑器。
       */
      const prefix = String(url.pathname)
        .replace(/\/+$/, "")
        .replace(/\/index\.html$/, "")
      /**
       * `__NONCE__` 换成**这一次响应现生成**的随机串，并把首页那份 CSP 换成"只认这个 nonce"的版本
       * （审核 S-03）：页面里两段内联 `<script>` 都带 `nonce="__NONCE__"`，被塞进来的第三方脚本
       * 没有这个 nonce 就执行不起来——这是 S-01/S-02 两个 innerHTML 面之外的最后兜底。
       * 每次响应都换：nonce 一旦可预测（比如写成常量）就等于没有。
       */
      const nonce = crypto.randomBytes(16).toString("base64url")
      applySecurityHeaders(res, { csp: cspForPage(nonce) })
      /**
       * 走 `sendText`：这是 200 KB 级的单文件页，按 `Accept-Encoding` 回 gzip / br。
       * 每响应现生成 nonce，同一 URL 的字节每次都不同，所以压不了静态副本、只能现压（见 `respond.js`）。
       */
      return sendText(
        req,
        res,
        200,
        html
          .replaceAll("__MOUNT__", prefix)
          .replaceAll("__NONCE__", nonce),
        { headers: { "cache-control": "no-store" } },
      )
    }
    /**
     * 编辑器页面的中文字体（原神标准字体：汉仪文黑-65W）
     *
     * 字体**随源码入库**（`resources/common/font/`，与 Axiu-Plugin / Atlas-Plugin 同位置），
     * 这里只是把它按固定路径吐出去，**没有任何下载或缓存逻辑**；
     * 拿不到就 404，页面自动回落到系统中文（英文数字由页面的 Times New Roman 负责）。
     */
    if (req.method === "GET" && FONT_FILES.has(pathname)) {
      try {
        const buf = await fsp.readFile(path.join(PLUGIN_DIR, "resources", "common", "font", FONT_FILES.get(pathname)))
        res.writeHead(200, {
          "content-type": "font/woff",
          "content-length": String(buf.length),
          "cache-control": "public, max-age=604800",
        })
        return res.end(buf)
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        return res.end("font unavailable")
      }
    }

    /**
     * 当前表版本（只凭口令）
     *
     * "本机 → 云端"推表之前先问一句云端现在是哪一版，再由上传把它带回来：
     * 中间要是有人改过云端，上传会被拒（冲突），而不是把别人的改动盖掉（AQ-06）。
     *
     * **`?fast=1` 给页面轮询用**（实时刷新那条路，见 `editor.html` 的 `pollVersion`）：
     * 它在内存里按 `mtime:size` 认一版，没变就直接回上次算出来的指纹（省掉每次读盘 + sha256 的
     * 几百 KB I/O）。**默认（不带 `fast`）照旧现读现算**——推表那条路要的是准，不是快。
     * 两者的差别只在"同一个毫秒里写了两次同样大小的内容"这种极限情况下才看得见，
     * 而轮询只是"要不要去拉一份新的"，晚一轮发现是自愈的。
     */
    if (req.method === "GET" && pathname === "/api/version")
      return json(res, 200, {
        ok: true,
        version: url.searchParams.get("fast") ? await fingerprintFast() : await table().fingerprint(),
      })

    /**
     * 页面元信息：**只凭口令**（与 /api/version 同一档）
     *
     * 只回"画页面要用"的东西，不碰表格数据：
     *   - `footer`：插件配置 `footer.html` 的自由 HTML + 编辑器追加的**规范署名行**（空串 = 不显示页脚）。
     *     它是维护者自己写的内容，不是群友输入，所以前端**故意用 innerHTML 插进去**；
     *     别把用户可控的字符串接到这里（那等于给公网页面开一个 XSS 口子）。
     *   - `versionsKeep`：页面上「历史版本」那句提示里的份数。
     *
     * 为什么不并进 /api/data：那一份是表格数据（含按身份裁剪的行），
     * 而页脚在"还没有表格数据"时也该画得出来；分开也让这个响应天然可缓存。
     */
    if (req.method === "GET" && pathname === "/api/meta")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        footer: footerHtml(),
        versionsKeep: VERSIONS_KEEP,
      })

    /**
     * 枪战版本表是锅巴配置的一部分，编辑器页面可能在配置改动前就打开了。
     * 单独给一个轻量接口，让页面回到前台/打开选择器时只刷新这一小块，
     * 不重读整张表，也不把用户正在编辑的草稿冲掉。
     */
    if (req.method === "GET" && pathname === "/api/attack-versions")
      return json(res, 200, { ok: true, versions: attackVersions() })

    /** 身份判定**只用一份**（见上面的 `resolvedCallers`：链接身份优先，没有链接才看 24 小时会话 cookie） */
    const caller = callerNow(req).value
    /** 手动收录名单（「帮帮完成情况」的临时成员）：首个请求读一次，之后走内存 */
    await ensureExtraNames()
    if (req.method === "GET" && pathname === "/api/data") {
      /**
       * 链接身份里的 `n` 只带签发那一刻的群名片；浏览器里没有 QQ 的本地缓存时，
       * 页面就只能拿这个旧值显示。它偶尔会是 QQ 号（现场：复制到浏览器后
       * 「群昵称」变成 QQ 号）。群名单/绑定里如果有这个 QQ 的现用名，以现用名为准，
       * 避免页面、`syncIdentity` 把表里的昵称也一起改回 QQ 号。
       *
       * 只补空值和 QQ 号：链接里带着有效群昵称时仍以它为准，不能拿旧名单把
       * 「刚改的新名片」又改回去。
       */
      if (caller.identity) {
        const linkNick = String(caller.identity.nick ?? "").trim()
        const qq = String(caller.identity.qq ?? "").trim()
        if (!linkNick || linkNick === qq) {
          const latestNick = await nickOf(qq)
          if (latestNick) caller.identity.nick = latestNick
          else if (linkNick === qq) caller.identity.nick = ""
        }
      }
      /**
       * 先确认绑定/锁是**对着这一版表**的（整表替换或外部改表之后就不是了）：
       * 对不上就按群昵称重新对账，绝不拿旧行号认人（AQ-03）
       */
      await alignOwnership()
      /**
       * 只读的那几档（访客 / 名单不可信 / 名单里没有他）**只查不写**：
       * 身份同步会改表里的群昵称、完成情况署名和绑定，不能让人"看一眼表"就顺手落盘。
       *
       * 判定口径与 `buildPayload` 里的 `perm.readonly` 是同一个式子，这里先算好再传进去；
       * 两处各算一遍的话，以后改一处就会漂移。
       */
      const member = memberStateOf(caller)
      const readonly = caller.role === "guest" || member === false
      /** 再按 QQ 认人（顺手同步改了名片的昵称、记下绑定），最后按身份裁剪数据 */
      const sync = readonly ? { renamed: 0, bound: 0, dropped: 0 } : await syncIdentity(caller)
      /** 管理员打开时，把表里手填、下拉里没有的名字归档成选项 */
      const archived = await archiveOptions(caller)
      /** 管理员打开时，到点的榜把残留的「等待开启」翻成「排队中」 */
      const opened = await catchUpOpenStatus(caller)
      const payload = await buildPayload(caller, req, { member })
      /** 有人打开页面时顺手看一眼群名单新不新（名单不新 ⇒ 新的权限口径静默失效，得让主人知道） */
      maybeAlertStaleRoster()
      return json(res, 200, { ...payload, sync: { ...sync, archived, opened } })
    }

    if (req.method === "POST" && pathname === "/api/save") {
      /**
       * **先判角色再读请求体**：访客（只有口令、没有签名身份）一条也写不了，
       * 角色判定又不用看 body —— 先读就等于白白替没权限的人扛带宽与内存。
       * 判不出权限的接口（比如上传）才只能先读。
       */
      if (caller.role === "guest")
        return json(res, 403, {
          ok: false,
          error: "这个链接里没有你的身份，只能查看，不能修改（请在群里发 #排队 取你自己的链接）",
        })
      const body = await readBody(req)
      /**
       * 被拒绝的保存**也要留痕**（`kind: "reject"`）：拒绝对审计最有价值——"谁在试"和"谁改成了"一样重要。
       *
       * 位置放在这里（拿到 body 之后、`applySave` 之外）：拒绝时那个"逐字段差异"还没算完就被拦下了，
       * 所以记的是**试图改哪几行 + 原因**。没有 body 的那一档（访客 403）不记——那一条由
       * `editor/audit.js` 的请求级审计覆盖，记在这里只是重复。
       */
      let out = null
      try {
        out = await applySave(caller, body, req)
      } catch (err) {
        recordChanges([
          {
            kind: "reject",
            at: Date.now(),
            sheet: String(body?.sheet ?? ""),
            rows: (Array.isArray(body?.rows) ? body.rows : []).map(r => Number(r?.row)).filter(Boolean),
            reason: err?.conflict ? "版本冲突（表被改过，这一份一个字都没写）" : String(err?.message ?? err),
            version: table().version,
            ...changeAuthor(caller),
          },
        ])
        throw err
      }
      auditLog.note(req, {
        sheet: body?.sheet,
        rows: Array.isArray(body?.rows) ? body.rows.length : undefined,
        written: out?.written,
        cleared: out?.cleared,
      })
      /**
       * 回执里带上**写完之后**那一版的 `version`：页面拿它立刻更新自己的版本号，
       * 于是"保存成功但重读失败"时再点重试不会撞 409（数据早落表了）——2026-10-10 审核 B-07。
       */
      return json(res, 200, { ok: true, ...out, version: table().version })
    }

    /**
     * 呼叫某一行的绑定 QQ（`POST /api/call`）
     *
     * 只给管理员：编辑器本身发不出群消息，真正发送走宿主注入的
     * `injectGroupCall`。无绑定 / 多绑定 / 绑定与当前昵称对不上都直接拒绝。
     */
    if (req.method === "POST" && pathname === "/api/call") {
      if (caller.role !== "admin") return json(res, 403, { ok: false, error: "只有主人或白名单管理员可以呼叫" })
      const body = await readBody(req)
      try {
        const out = await applyCall(caller, body)
        auditLog.note(req, { op: "call", sheet: body?.sheet, row: body?.row, group: out.group })
        return json(res, 200, out)
      } catch (err) {
        return json(res, Number(err?.statusCode) || 400, { ok: false, error: err.message })
      }
    }

    /**
     * 呼叫主播区某一位（`POST /api/anchor-call`）
     *
     * 所有人可用：有身份即可；普通成员由 `applyAnchorCall` 做 5 分钟限频，
     * 管理员/主人不限。与成员行的 `/api/call` 分开。
     */
    if (req.method === "POST" && pathname === "/api/anchor-call") {
      const body = await readBody(req)
      try {
        const out = await applyAnchorCall(caller, body)
        auditLog.note(req, { op: "anchor-call", sheet: body?.sheet, row: body?.row, group: out.group })
        return json(res, 200, out)
      } catch (err) {
        return json(res, Number(err?.statusCode) || 400, { ok: false, error: err.message })
      }
    }

    /**
     * 插队：把某一行挪到这一榜所有「排队中」的人最前面（`#插队` 调的就是这里）
     *
     * 位置由**编辑器**算（插件只给"哪一榜、哪一行、怎么挪"）：见 `applyMoveRow`。
     * 权限只认白名单管理员 / 主人；本人与访客一律 403——一条消息就能改全表的顺序，
     * 不该由"能改自己那一行"的身份来触发。
     */
    if (req.method === "POST" && pathname === "/api/move-row") {
      if (caller.role !== "admin") return json(res, 403, { ok: false, error: "只有白名单管理员可以插队" })
      const body = await readBody(req)
      const out = await applyMoveRow(caller, body)
      auditLog.note(req, { sheet: body?.sheet, row: body?.row, from: out?.from, to: out?.to, moved: out?.moved })
      /** 留痕：**顺序**也是数据的一部分（谁把谁插到第几位），一次插队记一条 */
      recordChanges([
        {
          kind: "order",
          at: Date.now(),
          sheet: String(body?.sheet ?? ""),
          row: Number(body?.row) || 0,
          current: out?.moved ? Number(out.to) : Number(body?.row) || 0,
          from: Number(out?.from) || 0,
          to: Number(out?.to) || 0,
          moved: Number(out?.moved) || 0,
          version: table().version,
          ...changeAuthor(caller),
        },
      ])
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 每日整理：按「已完成 → 等待开启 → 排队中」分组，
     * 组内按难度/目标/强度排序（规则见 `reorder.js`）
     *
     * 位置与顺序都由**编辑器**算（见 `applyTidy` / `tidyOrder`）；插件每天到点调一次。
     * 权限与 `/api/roster` 同一套：**机器人身份**（插件签的 `ROSTER_QQ`）或主人——
     * 一次就能重排全表，不该由"能改自己那一行"的身份来触发。
     */
    if (req.method === "POST" && pathname === "/api/tidy") {
      const fromBot = Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ
      if (!fromBot && !canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有机器人或主人能整理表格" })
      const body = await readBody(req)
      const out = await applyTidy(caller, body)
      auditLog.note(req, { sheet: body?.sheet, moved: out.moved })
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 周期清榜 / 等待行翻排队中：**只认机器人身份或主人**
     *
     * 机器人先下载完整快照、在本地归档成功后才调这里；失败不推进状态，下一轮重试。
     */
    const canRunCycle = () =>
      (Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ) || canManageAdmins(caller)

    /** 先问“这一轮清过没有”：客户端在归档前先查，避免重试覆盖归档 */
    if (req.method === "GET" && pathname === "/api/cycle/status") {
      if (!canRunCycle()) return json(res, 403, { ok: false, error: "只有机器人或主人能查询周期清榜状态" })
      const eventKey = String(url.searchParams.get("eventKey") ?? "").trim()
      if (!eventKey) return json(res, 400, { ok: false, error: "缺少 eventKey" })
      const out = await applyCycleStatus(caller, { eventKey })
      return json(res, 200, { ok: true, ...out })
    }

    if (req.method === "POST" && pathname === "/api/cycle") {
      if (!canRunCycle()) return json(res, 403, { ok: false, error: "只有机器人或主人能执行周期清榜" })
      const body = await readBody(req)
      try {
        const out = await applyCycle(caller, body)
        if (!out?.skipped)
          auditLog.note(req, {
            op: "cycle",
            sheet: body?.sheet,
            mode: body?.mode,
            eventKey: String(body?.eventKey ?? "").trim().slice(0, 200),
            cleared: out?.cleared,
            promoted: out?.promoted,
          })
        return json(res, 200, { ok: true, ...out })
      } catch (err) {
        /** 不是清榜协议的错误（账本 / intent 读不出来）照旧交给外层：与搬走前同一个 400 口径 */
        if (!err?.statusCode) throw err
        return json(res, Number(err.statusCode), {
          ok: false,
          ...(err?.pending ? { pending: true } : {}),
          ...(err?.conflict ? { conflict: true } : {}),
          error: err?.message ?? String(err),
        })
      }
    }

    /** 清榜前核查：仅机器人/主人可写；只改仍排队的行，不做清榜/归档 */
    if (req.method === "POST" && pathname === "/api/check-done") {
      if (!canRunCycle()) return json(res, 403, { ok: false, error: "只有机器人或主人能写清榜核查结果" })
      const body = await readBody(req)
      try {
        const out = await applyCheckDone(caller, body)
        auditLog.note(req, { op: "check-done", sheet: body?.sheet, updated: out.updated })
        return json(res, 200, { ok: true, ...out })
      } catch (err) {
        if (err?.conflict) return json(res, 409, { ok: false, conflict: true, error: err?.message ?? "表格版本冲突" })
        return json(res, 400, { ok: false, error: err?.message ?? String(err) })
      }
    }

    /** 表头上方的「主播列表」：只有白名单管理员能改（带 `version` 就做版本冲突检测） */
    if (req.method === "POST" && pathname === "/api/anchors") {
      /** 同上：不是管理员就没必要先收请求体（角色判定不用看 body） */
      if (caller.role !== "admin") return json(res, 403, { ok: false, error: "只有白名单管理员可以改主播列表" })
      const body = await readBody(req)
      const out = await applyAnchors(caller, body)
      auditLog.note(req, {
        sheet: body?.sheet,
        rows: Array.isArray(body?.rows) ? body.rows.length : undefined,
        inserted: out?.inserted,
      })
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 「帮帮完成情况」的手动收录（白名单管理员 / 主人）
     *
     * 用于收录**临时成员**：既不在主播区、也不是这一行的本人（例如临时帮忙打了一次的朋友）。
     * POST { sheet, name } → 记进表旁的收录名单；**只在当前月、当前榜有效**，
     * 下个月自动失效（不是永久候选，也不会写进表里的下拉验证）。
     */
    if (req.method === "POST" && pathname === "/api/status-names") {
      /**
       * 收录本月临时成员：**本群成员都能用**（主播编辑仍限管理员）
       *
       * 拦访客与只读：访客没有身份、只读（不在群）本来也不能改表，
       * 让他们往名单里塞名字只会让下拉里长出查无此人的选项。
       */
      const readonlyCaller = caller.role === "guest" || memberStateOf(caller) === false
      if (readonlyCaller) return json(res, 403, { ok: false, error: "只有本群成员可以收录名字" })
      const body = await readBody(req)
      const sheetName = String(body?.sheet ?? "").trim()
      if (!sheetName) return json(res, 400, { ok: false, error: "缺少 sheet" })
      try {
        const names = await addExtraName(sheetName, body?.name)
        auditLog.note(req, { sheet: sheetName, name: body?.name, names: names?.length })
        return json(res, 200, { ok: true, names })
      } catch (err) {
        return json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    }

    /**
     * 归属状态（**主人专用**，与 /api/admins 同一口径）
     *
     *   GET  → 当前 QQ → 行 的绑定到底还可不可信（stale / conflict / 记的昵称 vs 表里现在的昵称）+ 锁的摘要
     *   POST { action: "rebuild" } → 按当前表 + 群名单重建（能确认的保留、对不上账的作废），回报做了什么
     *
     * 为什么不给表加"稳定成员 ID"列（方案 B）与这个接口补上了什么，见 editor/README.md。
     * 权限**只认主人**：白名单管理员与本人链接都拿不到（他们要么不该看到全表的归属，
     * 要么本来就只该看到自己那一行）。
     */
    if (pathname === "/api/ownership") {
      if (!canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有主人能查看 / 重建归属状态" })
      if (req.method === "GET") {
        const audit = await ownershipAudit()
        /**
         * QQ → 群昵称（查不到就是空串）
         *
         * 归属页要并排显示「QQ 号」和「群昵称」两列：只给 QQ 的话，
         * 主人得自己拿号去群名单里翻，一条一条对着看根本认不出是谁。
         * 同一份映射也给退群候选（没有 QQ 的行），那边昵称来自表格本身，不查群名单。
         */
        const qqList = [...new Set((audit.sheets ?? []).flatMap(s => (s.entries ?? []).map(e => e.qq)).filter(Boolean))]
        const nicks = {}
        for (const qq of qqList) nicks[qq] = await nickOf(qq)
        return json(res, 200, { ok: true, ...audit, nicks, missing: await missingCandidates() })
      }
      if (req.method === "POST") {
        const body = await readBody(req)
        const action = String(body?.action ?? "").trim()
        /** 只认显式动作：不写 action 就当参数错误，免得一个手滑的 POST 就把归属全重建了 */
        if (action === "rebuild") {
          const out = await rebuildOwnershipNow()
          auditLog.note(req, { op: "rebuild", kept: out?.kept?.length, dropped: out?.dropped?.length })
          return json(res, 200, { ok: true, ...out })
        }
        /** 删掉主人确认过的"退群候选行"（只删他点名的那几行，见 `pruneMissingRows`） */
        if (action === "prune-missing") {
          const out = await pruneMissingRows(body?.rows)
          auditLog.note(req, { op: "prune-missing", removed: out.removed })
          return json(res, 200, { ok: true, ...out })
        }
        return json(res, 400, { ok: false, error: '请求格式不对：需要 { action: "rebuild" } 或 { action: "prune-missing", rows }' })
      }
    }

    /**
     * 改动记录（留痕）：谁在什么时候改了哪一行的哪个字段
     *
     * **可见范围按身份分**（与 `/api/data` 的裁剪同一套思路）：
     *   - 主人 / 管理口令 / 白名单管理员 → 全部记录；
     *   - 本人（`self`）→ **自己发的** + **改到自己名下那些行的**（别人动了我的行，我得看得见）；
     *   - 访客 → 403（没有身份就没有"我的行"这个概念）。
     *
     * `limit` 只做上限（默认 200、最多 1000）：返回**新的在前**，页面直接顺着渲染。
     */
    if (req.method === "GET" && pathname === "/api/changes") {
      if (caller.role === "guest") return json(res, 403, { ok: false, error: "这个链接里没有你的身份，看不到改动记录" })
      const all = caller.role === "admin"
      const want = Number(url.searchParams.get("limit")) || 200
      const limit = Math.min(1000, Math.max(1, want))
      /** 本人视角要"我那些行"：与页面看到的行是同一份口径（`mineRows`） */
      const mine = all ? null : await mineRows(caller)
      return json(res, 200, {
        ok: true,
        all,
        keep: CHANGES_KEEP,
        entries: changes.list({ limit, all, qq: caller.identity?.qq ?? "", mine }),
      })
    }

    /**
     * 历史版本 + 归档清单（主人或管理口令）
     *
     * 版本目录默认是空的——从第一次写表开始攒，不预置任何版本。
     * 归档里：`queue-YYYY-MM.xlsx` = 每月最后一次修改；`queue-YYYY-MM-DD.xlsx` = 每日起始状态（只留最近几天）。
     */
    if (req.method === "GET" && pathname === "/api/versions") {
      if (!canManageAdmins(caller) && caller.role !== "admin")
        return json(res, 403, { ok: false, error: "只有主人或白名单管理员能看历史版本" })
      const st = fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath) : null
      return json(res, 200, {
        ok: true,
        keep: VERSIONS_KEEP,
        archiveDays: ARCHIVE_DAYS,
        dir: VERSIONS_DIR,
        archivesDir: ARCHIVES_DIR,
        current: st ? { at: st.mtime.toISOString(), size: st.size } : null,
        versions: listVersions(),
        archives: listArchives(),
      })
    }

    /**
     * 下载某个历史版本 / 归档（主人、管理口令或白名单管理员）—— 归档可以随身带走
     *
     * id 只允许是版本或归档目录里的文件名（挡掉路径穿越）。
     */
    if (req.method === "GET" && pathname === "/api/download") {
      if (!canManageAdmins(caller) && caller.role !== "admin")
        return json(res, 403, { ok: false, error: "只有主人或白名单管理员能下载历史版本/归档" })
      const id = path.basename(String(url.searchParams.get("id") ?? ""))
      /** 认不认这个文件名，只由 `editor/versions.js` 的两条正则决定（与列表/存版本同一份口径） */
      const target = resolveStoredFile(VERSIONS_DIR, ARCHIVES_DIR, id)
      if (!target.kind || !fs.existsSync(target.file)) return json(res, 404, { ok: false, error: `没有这一份：${id}` })
      const buf = await fsp.readFile(target.file)
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-length": String(buf.length),
        "content-disposition": `attachment; filename="${id}"`,
        "cache-control": "no-store",
      })
      return res.end(buf)
    }

    /**
     * 回退到某个历史版本（主人、管理口令或白名单管理员）
     *
     * 替换前会先把"当前状态"也存成一个版本，所以回退错了还能再退回来。
     */
    if (req.method === "POST" && pathname === "/api/restore") {
      if (!canManageAdmins(caller) && caller.role !== "admin")
        return json(res, 403, { ok: false, error: "只有主人或白名单管理员能回退版本" })
      const body = await readBody(req)
      const id = path.basename(String(body?.id ?? ""))
      if (!RE_VERSION.test(id)) return json(res, 400, { ok: false, error: "版本号不对" })
      const file = path.join(VERSIONS_DIR, id)
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: `没有这个版本：${id}` })
      const out = await replaceTable(await fsp.readFile(file), `历史版本 ${id}`, { expect: body?.version })
      auditLog.note(req, { version: id })
      return json(res, 200, { ok: true, restored: id, ...out })
    }

    /**
     * 覆盖当前表（云端上传入口，主人或管理口令）
     *
     * 本机编辑器把「本机那份表」直接 POST 上来：校验 → 存底（版本 + 归档）→ 原子替换。
     */
    if (req.method === "POST" && pathname === "/api/upload") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能覆盖云端表" })
      const bytes = await readRawBody(req)
      /** `?v=<读到的版本>`：上传方声明"我是照着哪一版改的"，对不上就报冲突，不覆盖别人刚提交的改动（AQ-06） */
      const out = await replaceTable(bytes, `上传的表（${caller.identity?.nick || caller.identity?.qq || "主人"}）`, {
        expect: url.searchParams.get("v") ?? "",
      })
      auditLog.note(req, { bytes: bytes.length, sheets: out?.sheets?.length })
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 本机编辑器 → 云端：把本机这份表推上去覆盖云端（只有配了 --cloud 的本机才有）
     *
     * 认证用同一套口令与签名密钥：本机按调用者的身份重新签一次，云端验签后按主人放行。
     * **身份要连当期时间窗一起签**：这样签出来的身份与"当期链接"完全同形，云端用同一套验签；
     * 注意 2026-10 之后已经**没有**"没带 `w/ws` 就按旧链 410"这条门了（链接身份自己就是凭证），
     * 带上窗口只是把身份签得更完整、不依赖任何豁免分支。
     * 推之前先问一下云端当前版本并原样带回去：中间云端有人写过就变成冲突，而不是把人家的改动盖掉。
     */
    if (req.method === "POST" && pathname === "/api/push-cloud") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能把本机的表传上云端" })
      if (!CLOUD_URL) return json(res, 400, { ok: false, error: "本机没配云端地址（--cloud / ABYSS_EDITOR_CLOUD）" })
      const bytes = await fsp.readFile(xlsxPath)
      const who = { qq: caller.identity?.qq ?? "", nick: caller.identity?.nick ?? "" }
      const id = signIdentity(who, SIGN_KEY)
      const win = signWindow(who, SIGN_KEY)
      /** 调用者的 24 小时管理员会话 cookie 原样转给云端：云端据此认得"这是主人本人登进来的那台浏览器" */
      const forwarded = req.headers.cookie ? { cookie: String(req.headers.cookie) } : {}
      const remoteVersion = await cloudVersion(req)
      const target =
        `${CLOUD_URL}/api/upload?k=${encodeURIComponent(TOKEN)}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}` +
        (win ? `&w=${win.w}&ws=${encodeURIComponent(win.ws)}` : "") +
        (remoteVersion ? `&v=${encodeURIComponent(remoteVersion)}` : "")
      const res2 = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...forwarded },
        body: bytes,
        signal: AbortSignal.timeout(60000),
      })
      const text = await res2.text()
      let out = null
      try {
        out = JSON.parse(text)
      } catch {
        out = { ok: false, error: `云端返回了非 JSON（HTTP ${res2.status}）：${text.slice(0, 200)}` }
      }
      console.log(
        `[editor] 上传覆盖云端 ${CLOUD_URL}：HTTP ${res2.status} ${out?.ok ? "成功" : out?.error ?? ""}` +
          (remoteVersion ? `（推之前云端版本 ${remoteVersion.slice(0, 12)}）` : ""),
      )
      auditLog.note(req, { cloud: CLOUD_URL, cloud_status: res2.status })
      return json(res, res2.status === 200 && out?.ok ? 200 : 400, { ...out, cloud: CLOUD_URL })
    }

    /**
     * 群成员名单推送（机器人 → 编辑器）
     *
     * 只认机器人身份（ROSTER_QQ）或主人：成员拿不到机器人身份的签名，所以推不动。
     * 收到后就地按 QQ 对账：改名同步表里的群昵称；退群删行并压紧（删前自动存底）。
     * 实现与规则在 `editor/actions.js` 的 `roster`（`applyRoster`），这里只留权限门与审计。
     */
    if (req.method === "POST" && pathname === "/api/roster") {
      const fromBot = Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ
      if (!fromBot && !canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有机器人或主人能推送群成员名单" })
      const body = await readBody(req)
      try {
        const out = await applyRoster(caller, body)
        auditLog.note(req, { group: body?.group, members: out.total })
        return json(res, 200, out)
      } catch (err) {
        if (!err?.statusCode) throw err
        return json(res, Number(err.statusCode), { ok: false, error: err?.message ?? String(err) })
      }
    }

    /** 白名单维护：主人（或管理口令 ?a=），普通管理员与个人链接都不行 */
    if (pathname === "/api/admins") {
      if (!canManageAdmins(caller))
        return json(res, 403, {
          ok: false,
          error: ADMIN_TOKEN ? "只有主人或管理口令能维护白名单" : "服务端没设主人名单（owner / --owner），无法维护白名单",
        })
      const audit = aclAudit()
      /** fromFile 是**原始条目**：历史昵称条目要能被主人删掉，所以不先过滤 */
      const fromFile = adminFileList("admins")
      /**
       * QQ → 群昵称（查不到就是空串）
       *
       * 白名单只存 QQ，页面上「成员」一列得显示人名字，否则整行只有一串数字，
       * 与「角色」列并排时看着像两列重复（这个 bug 就是这么来的）。
       */
      const qqList = [...new Set([...loadOwners(), ...loadAdmins(), ...ENV_ADMINS])]
      const nicks = {}
      for (const qq of qqList) nicks[qq] = await nickOf(qq)
      const payload = {
        ok: true,
        admins: loadAdmins(),
        owners: loadOwners(),
        env: ENV_ADMINS,
        file: fromFile,
        nicks,
        /** 当不了权限的历史条目（群昵称等）+ "该改成哪个 QQ"的建议（仍要主人确认）（AQ-01） */
        ignored: audit.ignored,
        suggestions: audit.suggestions,
      }
      if (req.method === "GET") return json(res, 200, payload)
      const body = await readBody(req)
      const add = Array.isArray(body?.add) ? body.add : []
      const remove = Array.isArray(body?.remove) ? body.remove : []
      /** 加人只收 QQ：群昵称本人随时能改，收进来就等于留了一条越权口子（AQ-01） */
      const bad = add.map(s => String(s).trim()).filter(s => s && !aclQq(s))
      if (bad.length) {
        /**
         * 被拒的那几个值**当场去群名单里查一次 QQ**：填昵称的人多半就是"不知道 QQ"，
         * 只回一句"解析不出 QQ"等于让人自己去翻群资料。查得到就直说「要加就填这个号」，
         * 查不到（不在名单里 / 重名）就照旧只说规则。
         */
        const fresh = {}
        for (const name of bad) {
          const qq = rosterQqOfNick(name)
          if (qq) fresh[name] = qq
        }
        const merged = { ...audit.suggestions, ...fresh }
        const hints = Object.entries(fresh).map(([name, qq]) => `「${name}」在群名单里的 QQ 是 ${qq}，要加就填这个号`)
        return json(res, 400, {
          ok: false,
          error:
            `白名单只能填 QQ 号：「${bad.join("、")}」解析不出 QQ。` +
            "群昵称是可修改的展示名，不能当权限（改了名片就顶替别人的权限了）。" +
            (hints.length ? ` ${hints.join("；")}。` : ""),
          ignored: audit.ignored,
          suggestions: merged,
        })
      }
      const next = fromFile
        .map(s => String(s).trim())
        .filter(s => s && !remove.some(x => String(x).trim().toLowerCase() === s.toLowerCase()))
      for (const item of add) {
        const qq = aclQq(item)
        if (qq && !next.includes(qq) && !ENV_ADMINS.some(e => aclQq(e) === qq)) next.push(qq)
      }
      saveAdmins(next)
      auditLog.note(req, { add: add.length, remove: remove.length, admins: next.length })
      return json(res, 200, { ...payload, file: next })
    }

    /**
     * 健康检查：部署时用来确认服务活着，也用来确认"跑的是哪一版"（升级后忘了重启会在这里看出来）
     *
     * **只凭口令就能看**，所以这里不回吐服务器路径与云端地址（那两样对排障没帮助，泄露了反而多余）；
     * 只给布尔开关与计数。
     */
    if (req.method === "GET" && pathname === "/healthz")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        features: FEATURES,
        fields: FIELDS.map(f => f.key),
        bind: BIND,
        port: PORT,
        mount: MOUNT,
        auth: Boolean(TOKEN),
        sign_key: SIGN_KEY !== TOKEN,
        owner_only: OWNER_ONLY,
        /** 只数"能当权限的 QQ"（AQ-01）；解析不出来的历史昵称条目在 acl_invalid 里 */
        admins: loadAdmins().length,
        owners: loadOwners().length,
        acl_invalid: aclAudit().ignored.length,
        roster: (loadRoster().members ?? []).length,
        roster_group: loadRoster().group || "",
        versions_keep: VERSIONS_KEEP,
        archive_days: ARCHIVE_DAYS,
        admin_api: Boolean(ADMIN_TOKEN),
        aliases: compileAliases(config.anchor_aliases).length,
      })
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  } catch (err) {
    /** 版本冲突（表在保存期间被换掉了）要能和普通参数错误区分开：409 + 明确提示（AQ-06） */
    /**
     * 请求体超限：错误响应本身就是"这次连接上的最后一句"，写完就断开。
     * 声明 `connection: close` 是为了让读不完的请求体到此为止（不关的话客户端会一直往里灌字节）
     */
    if (err instanceof BodyTooLarge) {
      /**
       * 先把剩余请求体读掉，再回 400：客户端还在灌字节时立刻关连接，响应会被 RST 吃掉。
       * drain 只丢弃、不保留分块；最多等 5 秒，不能为了一个坏请求把连接一直挂着。
       */
      await drainRequest(req)
      res.setHeader("connection", "close")
    }
    /**
     * 冲突分两种，都回 409，但页面要区别对待：
     *   - `conflictRows` 非空：**行级冲突**（你改的那几行被人动过）——页面只把那几行挂起，其余照旧能存；
     *   - 没有 `conflictRows`：**整表冲突**（表被整表替换过）——页面暂停自动保存，等用户核对。
     */
    json(res, err?.conflict ? 409 : 400, {
      ok: false,
      conflict: Boolean(err?.conflict),
      rows: err?.conflictRows ?? undefined,
      error: err?.message ?? String(err),
    })
  }
  }
}
