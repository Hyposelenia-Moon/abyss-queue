/** HTTP 分发：按路径把请求交给对应的处理段 */
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
  applySecurityHeaders(res)
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
  const pathname = innerPath(url.pathname)
  auditLog.install(req, res, pathname)
  if (pathname === "/" && url.pathname.length > 1 && !url.pathname.endsWith("/")) {
    res.writeHead(301, { location: `${url.pathname}/${url.search ?? ""}`, "cache-control": "no-store" })
    return res.end()
  }
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
      }
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    return res.end("favicon unavailable")
  }
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
  if (req.method === "GET" && pathname === "/api/link-code") {
    const ip = clientIpOf(req)
    if (!linkGuard.allow(ip)) {
      const wait = Math.ceil(linkGuard.retryAfterMs(ip) / 1000)
      res.setHeader("retry-after", String(Math.max(wait, 1)))
      return json(res, 429, { ok: false, error: "试得太频繁了，请过几分钟再回群里重新发一次 #排队" })
    }
    const code = String(paramOf(req, "code") ?? "").trim()
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
      const nonce = crypto.randomBytes(16).toString("base64url")
      applySecurityHeaders(res, { csp: cspForPage(nonce) })
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(entryPage(nonce))
    }
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
    return res.end("forbidden")
  }
  if (adminCookieOk) setAdminSession(req, res, adminSession.qq)
  {
    const w = paramOf(req, "w")
    const ws = paramOf(req, "ws")
    if (w || ws) {
      const linkQq = String(decodeIdentity(paramOf(req, "u"))?.qq ?? "")
      if (!verifyWindow(w, ws, { qq: linkQq }, SIGN_KEY)) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        return res.end(expiredLinkPage())
      }
      callerNow(req).windowed = true
      if (linkQq && roleOf({ qq: linkQq }).role === "admin") setAdminSession(req, res, linkQq)
    }
  }
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
      const prefix = String(url.pathname)
        .replace(/\/+$/, "")
        .replace(/\/index\.html$/, "")
      const nonce = crypto.randomBytes(16).toString("base64url")
      applySecurityHeaders(res, { csp: cspForPage(nonce) })
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
    if (req.method === "GET" && pathname === "/api/version")
      return json(res, 200, {
        ok: true,
        version: url.searchParams.get("fast") ? await fingerprintFast() : await table().fingerprint(),
      })
    if (req.method === "GET" && pathname === "/api/meta")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        footer: footerHtml(),
        versionsKeep: VERSIONS_KEEP,
      })
    if (req.method === "GET" && pathname === "/api/attack-versions")
      return json(res, 200, { ok: true, versions: attackVersions() })
    const caller = callerNow(req).value
    await ensureExtraNames()
    if (req.method === "GET" && pathname === "/api/data") {
      if (caller.identity) {
        const linkNick = String(caller.identity.nick ?? "").trim()
        const qq = String(caller.identity.qq ?? "").trim()
        if (!linkNick || linkNick === qq) {
          const latestNick = await nickOf(qq)
          if (latestNick) caller.identity.nick = latestNick
          else if (linkNick === qq) caller.identity.nick = ""
        }
      }
      await alignOwnership()
      const member = memberStateOf(caller)
      const readonly = caller.role === "guest" || member === false
      const sync = readonly ? { renamed: 0, bound: 0, dropped: 0 } : await syncIdentity(caller)
      const archived = await archiveOptions(caller)
      const opened = await catchUpOpenStatus(caller)
      const payload = await buildPayload(caller, req, { member })
      maybeAlertStaleRoster()
      return json(res, 200, { ...payload, sync: { ...sync, archived, opened } })
    }
    if (req.method === "POST" && pathname === "/api/save") {
      if (caller.role === "guest")
        return json(res, 403, {
          ok: false,
          error: "这个链接里没有你的身份，只能查看，不能修改（请在群里发 #排队 取你自己的链接）",
        })
      const body = await readBody(req)
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
      return json(res, 200, { ok: true, ...out, version: table().version })
    }
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
    if (req.method === "POST" && pathname === "/api/move-row") {
      if (caller.role !== "admin") return json(res, 403, { ok: false, error: "只有白名单管理员可以插队" })
      const body = await readBody(req)
      const out = await applyMoveRow(caller, body)
      auditLog.note(req, { sheet: body?.sheet, row: body?.row, from: out?.from, to: out?.to, moved: out?.moved })
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
    if (req.method === "POST" && pathname === "/api/tidy") {
      const fromBot = Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ
      if (!fromBot && !canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有机器人或主人能整理表格" })
      const body = await readBody(req)
      const out = await applyTidy(caller, body)
      auditLog.note(req, { sheet: body?.sheet, moved: out.moved })
      return json(res, 200, { ok: true, ...out })
    }
    const canRunCycle = () =>
      (Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ) || canManageAdmins(caller)
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
        if (!err?.statusCode) throw err
        return json(res, Number(err.statusCode), {
          ok: false,
          ...(err?.pending ? { pending: true } : {}),
          ...(err?.conflict ? { conflict: true } : {}),
          error: err?.message ?? String(err),
        })
      }
    }
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
    if (req.method === "POST" && pathname === "/api/anchors") {
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
    if (req.method === "POST" && pathname === "/api/status-names") {
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
    if (pathname === "/api/ownership") {
      if (!canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有主人能查看 / 重建归属状态" })
      if (req.method === "GET") {
        const audit = await ownershipAudit()
        const qqList = [...new Set((audit.sheets ?? []).flatMap(s => (s.entries ?? []).map(e => e.qq)).filter(Boolean))]
        const nicks = {}
        for (const qq of qqList) nicks[qq] = await nickOf(qq)
        return json(res, 200, { ok: true, ...audit, nicks, missing: await missingCandidates() })
      }
      if (req.method === "POST") {
        const body = await readBody(req)
        const action = String(body?.action ?? "").trim()
        if (action === "rebuild") {
          const out = await rebuildOwnershipNow()
          auditLog.note(req, { op: "rebuild", kept: out?.kept?.length, dropped: out?.dropped?.length })
          return json(res, 200, { ok: true, ...out })
        }
        if (action === "prune-missing") {
          const out = await pruneMissingRows(body?.rows)
          auditLog.note(req, { op: "prune-missing", removed: out.removed })
          return json(res, 200, { ok: true, ...out })
        }
        return json(res, 400, { ok: false, error: '请求格式不对：需要 { action: "rebuild" } 或 { action: "prune-missing", rows }' })
      }
    }
    if (req.method === "GET" && pathname === "/api/changes") {
      if (caller.role === "guest") return json(res, 403, { ok: false, error: "这个链接里没有你的身份，看不到改动记录" })
      const all = caller.role === "admin"
      const want = Number(url.searchParams.get("limit")) || 200
      const limit = Math.min(1000, Math.max(1, want))
      const mine = all ? null : await mineRows(caller)
      return json(res, 200, {
        ok: true,
        all,
        keep: CHANGES_KEEP,
        entries: changes.list({ limit, all, qq: caller.identity?.qq ?? "", mine }),
      })
    }
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
    if (req.method === "GET" && pathname === "/api/download") {
      if (!canManageAdmins(caller) && caller.role !== "admin")
        return json(res, 403, { ok: false, error: "只有主人或白名单管理员能下载历史版本/归档" })
      const id = path.basename(String(url.searchParams.get("id") ?? ""))
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
    if (req.method === "POST" && pathname === "/api/upload") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能覆盖云端表" })
      const bytes = await readRawBody(req)
      const out = await replaceTable(bytes, `上传的表（${caller.identity?.nick || caller.identity?.qq || "主人"}）`, {
        expect: url.searchParams.get("v") ?? "",
      })
      auditLog.note(req, { bytes: bytes.length, sheets: out?.sheets?.length })
      return json(res, 200, { ok: true, ...out })
    }
    if (req.method === "POST" && pathname === "/api/push-cloud") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能把本机的表传上云端" })
      if (!CLOUD_URL) return json(res, 400, { ok: false, error: "本机没配云端地址（--cloud / ABYSS_EDITOR_CLOUD）" })
      const bytes = await fsp.readFile(xlsxPath)
      const who = { qq: caller.identity?.qq ?? "", nick: caller.identity?.nick ?? "" }
      const id = signIdentity(who, SIGN_KEY)
      const win = signWindow(who, SIGN_KEY)
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
    if (pathname === "/api/admins") {
      if (!canManageAdmins(caller))
        return json(res, 403, {
          ok: false,
          error: ADMIN_TOKEN ? "只有主人或管理口令能维护白名单" : "服务端没设主人名单（owner / --owner），无法维护白名单",
        })
      const audit = aclAudit()
      const fromFile = adminFileList("admins")
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
        ignored: audit.ignored,
        suggestions: audit.suggestions,
      }
      if (req.method === "GET") return json(res, 200, payload)
      const body = await readBody(req)
      const add = Array.isArray(body?.add) ? body.add : []
      const remove = Array.isArray(body?.remove) ? body.remove : []
      const bad = add.map(s => String(s).trim()).filter(s => s && !aclQq(s))
      if (bad.length) {
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
    if (err instanceof BodyTooLarge) {
      await drainRequest(req)
      res.setHeader("connection", "close")
    }
    json(res, err?.conflict ? 409 : 400, {
      ok: false,
      conflict: Boolean(err?.conflict),
      rows: err?.conflictRows ?? undefined,
      error: err?.message ?? String(err),
    })
  }
  }
}
