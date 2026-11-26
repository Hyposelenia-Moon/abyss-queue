/** 编辑器启动配置：**所有路径与开关的唯一口径** */
import fs from "node:fs"
import path from "node:path"

import { makeBoolFlag, makeFlag, setupLogFile } from "./cli.js"
import { isHostMode } from "./injected.js"
import { TEMPLATE, attributionLine, makeShared, pluginRoot, resolvePluginDir } from "./plugin-root.js"

export const DEFAULTS = {
  port: 7788,
  bind: "127.0.0.1",
  mount: "/queue",
  rosterQq: "0",
  versionsKeep: 20,
  archiveDays: 7,
  archivesKeep: 12,
  changesKeep: 2000,
  quotaMaxPerSave: 3,
  quotaWindowMs: 10 * 60 * 1000,
  quotaMaxPerWindow: 10,
  rosterTrustMs: 48 * 60 * 60 * 1000,
  footerHtml:
    '<div>© 2026 <a href="https://github.com/Hyposelenia-Moon">缄月</a> &amp; <a href="https://github.com/AxiuCN">阿修Axiu</a> · 由 <a href="https://github.com/Hyposelenia-Moon/abyss-queue">abyss-queue</a> 提供</div>',
}

const FOOTER_DROP_TAGS = ["script", "iframe", "object", "embed", "link", "meta", "base", "form"]

const TAG_RE = /<\/?([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g

const ATTR_RE = /([^\s/>=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g

const SCRIPT_URL_ATTR = new Set(["href", "src", "xlink:href"])

const BAD_SCHEME = /^(?:javascript|vbscript|data):/

const unmaskValue = raw => {
  let s = String(raw ?? "")
  const quoted = s.length > 1 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))
  if (quoted) s = s.slice(1, -1)
  s = s.replace(/&#(x?)([0-9a-f]+);?/gi, (_, hex, num) => {
    const code = Number.parseInt(num, hex ? 16 : 10)
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ""
    try {
      return String.fromCodePoint(code)
    } catch {
      return ""
    }
  })
  return s.replace(/&colon;/gi, ":").replace(/[\s\u0000-\u001f\u007f]/g, "").toLowerCase()
}

const cutSpans = (text, patterns) => {
  let out = String(text ?? "")
  for (let guard = 0; guard < 20; guard++) {
    const spans = []
    for (const re of patterns) {
      const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`
      for (const m of out.matchAll(new RegExp(re.source, flags))) spans.push([m.index, m.index + m[0].length])
    }
    if (!spans.length) return out
    spans.sort((a, b) => a[0] - b[0])
    let next = ""
    let cursor = 0
    for (const [start, end] of spans) {
      if (start < cursor) continue
      next += out.slice(cursor, start)
      cursor = end
    }
    out = next + out.slice(cursor)
  }
  return out
}

const rebuildTag = tag => {
  const [raw, name, rawAttrs = ""] = tag
  if (raw.startsWith("</")) return raw
  const attrs = []
  for (const [, attrName, value = ""] of rawAttrs.replace(/\/\s*$/, "").matchAll(ATTR_RE)) {
    const lower = attrName.toLowerCase()
    if (lower.startsWith("on")) continue
    if (SCRIPT_URL_ATTR.has(lower) && BAD_SCHEME.test(unmaskValue(value))) continue
    if (!value) attrs.push(attrName)
    else {
      const quoted = value.length > 1 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))
      const bare = quoted ? value.slice(1, -1) : value
      attrs.push(`${attrName}="${bare.replace(/"/g, "&quot;")}"`)
    }
  }
  const selfClose = /\/>$/.test(raw) ? "/" : ""
  return `<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}${selfClose}>`
}

export const sanitizeFooter = html => {
  const drop = FOOTER_DROP_TAGS.flatMap(tag => [
    new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
    new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"),
  ])
  const withoutDanger = cutSpans(html, drop)
  let out = ""
  let cursor = 0
  for (const m of withoutDanger.matchAll(TAG_RE)) {
    out += withoutDanger.slice(cursor, m.index) + rebuildTag(m)
    cursor = m.index + m[0].length
  }
  return out + withoutDanger.slice(cursor)
}

const withFooterLine = (html, line) => {
  const free = sanitizeFooter(html)
    .replace(/\\[rn]/g, "\n")
    .trim()
  return free ? `${free}\n<div>${line}</div>` : ""
}

const FILES = {
  admins: "abyss-editor-admins.json",
  locks: "abyss-editor-locks.json",
  roster: "abyss-editor-roster.json",
  bindings: "abyss-editor-bindings.json",
  changes: "abyss-editor-changes.json",
  quota: "abyss-editor-quota.json",
  links: "abyss-editor-links.json",
  versionsDir: "versions",
  archivesDir: "archives",
}

export class EditorConfigError extends Error {
  constructor(lines) {
    super(lines[0] ?? "编辑器配置不合法")
    this.name = "EditorConfigError"
    this.lines = lines
  }
}

function failClosed(lines) {
  if (isHostMode()) throw new EditorConfigError(lines)
  for (const line of lines) console.error(line)
  process.exit(1)
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const splitList = raw =>
  String(raw ?? "")
    .split(/[,，\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
const isLoopbackBind = bind => {
  const raw = String(bind ?? "").trim().toLowerCase()
  const host = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0]
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.")
}

const secretsIndependent = ({ token, signKey, adminToken }) => {
  const shared = []
  if (!signKey) shared.push("缺少独立的 SIGN_KEY（--sign-key / ABYSS_EDITOR_SIGN_KEY）")
  else if (signKey === token) shared.push("SIGN_KEY 与 TOKEN 相同（会退回用链接里的口令签身份）")
  if (adminToken && adminToken === token) shared.push("ADMIN_TOKEN 与 TOKEN 相同（普通链接持有者直接拿到主人口令）")
  if (adminToken && signKey && adminToken === signKey) shared.push("ADMIN_TOKEN 与 SIGN_KEY 相同（签名密钥不是独立凭证）")
  return { ok: shared.length === 0, shared }
}

export async function createConfig({ flag = makeFlag(), boolFlag = makeBoolFlag() } = {}) {
  if (!isHostMode()) setupLogFile(flag("--log", process.env.ABYSS_EDITOR_LOG ?? ""))
  const pluginDir = resolvePluginDir(flag)
  const shared = makeShared(pluginDir)
  const { config, insidePlugin } = await shared("components/config.js")
  const footerLine = await attributionLine(pluginDir)
  const dataDir = path.join(pluginDir, "data")
  const testPaths = /^(1|true|yes|on)$/i.test(String(process.env.ABYSS_EDITOR_TEST_PATHS ?? "").trim())
  const fromFlag = flag("--file", process.env.ABYSS_EDITOR_FILE ?? "")
  const xlsxPath = fromFlag ? path.resolve(fromFlag) : ""
  if (!xlsxPath) {
    failClosed([
      "没有指定表格文件：用 --file <xlsx> 或环境变量 ABYSS_EDITOR_FILE",
      `表必须放在 ${dataDir} 里（数据目录固定、不可配置）`,
    ])
  }
  if (!testPaths && !insidePlugin(xlsxPath, dataDir)) {
    const from = "--file / ABYSS_EDITOR_FILE"
    failClosed([
      `[editor] 数据必须留在插件目录内：表格只能待在 ${dataDir}`,
      `  解析出的路径：${xlsxPath}（来源：${from}）`,
      `  插件根：${pluginDir}`,
      "  数据一旦落到插件外面，`#更新 abyss`（只动代码）与备份/迁移就会各按各的路径找，哪一份都不是完整的；",
      `  把表放进 ${dataDir} 再启动。回归套件要指临时目录，请显式设 ABYSS_EDITOR_TEST_PATHS=1。`,
    ])
  }
  const statePath = /\.xlsx$/i.test(xlsxPath) ? xlsxPath.replace(/\.xlsx$/i, ".json") : `${xlsxPath}.json`
  if (!fs.existsSync(xlsxPath) && !fs.existsSync(statePath))
    failClosed([
      `表格不存在：${xlsxPath}（状态文档 ${path.basename(statePath)} 也没有）`,
      `  从插件自带的空模板起一份：把 ${path.join(pluginDir, "resources", "空模板.xlsx")} 复制成 ${xlsxPath}`,
      `  或者把已有的 ${path.basename(statePath)} 放进来（起始表会按它重新导出）`,
      "  两份都没有时编辑器不提供服务（机器人照常跑）",
    ])
  const dataBase = testPaths ? path.dirname(xlsxPath) : dataDir
  const sibling = name => path.join(dataBase, name)
  const pathOverride = (label, value) => {
    const raw = String(value ?? "").trim()
    if (!raw) return ""
    if (testPaths) return raw
    console.warn(`[editor] 忽略 ${label}（生产模式：数据文件固定在 ${dataBase}，不允许指到别处）`)
    return ""
  }
  const nonNegative = (flagName, envName, fallback) => {
    const raw = Number(flag(flagName, process.env[envName] ?? fallback))
    return raw >= 0 ? raw : fallback
  }
  const cfg = {
    pluginDir,
    dataDir,
    testPaths,
    xlsxPath,
    dataBase,
    template: TEMPLATE,
    token: String(flag("--token", process.env.ABYSS_EDITOR_TOKEN ?? "")).trim(),
    allowNoToken: boolFlag("--allow-no-token", process.env.ABYSS_EDITOR_ALLOW_NO_TOKEN ?? ""),
    signKey: String(flag("--sign-key", process.env.ABYSS_EDITOR_SIGN_KEY ?? "")).trim(),
    adminToken: String(flag("--admin-token", process.env.ABYSS_EDITOR_ADMIN_TOKEN ?? "")).trim(),
    ownerOnly: boolFlag("--owner-only", process.env.ABYSS_EDITOR_OWNER_ONLY ?? ""),
    port: Number(flag("--port", process.env.ABYSS_EDITOR_PORT ?? DEFAULTS.port)),
    bind: flag("--bind", process.env.ABYSS_EDITOR_BIND ?? DEFAULTS.bind),
    mount: String(flag("--mount", process.env.ABYSS_EDITOR_MOUNT ?? DEFAULTS.mount)).replace(/\/+$/, ""),
    cloudUrl: String(flag("--cloud", process.env.ABYSS_EDITOR_CLOUD ?? "")).trim().replace(/\/+$/, ""),
    footerHtml: withFooterLine(config.footer?.html ?? DEFAULTS.footerHtml, footerLine),
    adminsFile: path.resolve(
      pathOverride("--admins / ABYSS_EDITOR_ADMINS_FILE", flag("--admins", process.env.ABYSS_EDITOR_ADMINS_FILE ?? "")) ||
        sibling(FILES.admins),
    ),
    locksFile: path.resolve(
      pathOverride("ABYSS_EDITOR_LOCKS_FILE", process.env.ABYSS_EDITOR_LOCKS_FILE ?? "") || sibling(FILES.locks),
    ),
    rosterFile: path.resolve(
      pathOverride("ABYSS_EDITOR_ROSTER_FILE", process.env.ABYSS_EDITOR_ROSTER_FILE ?? "") || sibling(FILES.roster),
    ),
    bindingsFile: sibling(FILES.bindings),
    changesFile: sibling(FILES.changes),
    changesKeep: nonNegative("--changes-keep", "ABYSS_EDITOR_CHANGES_KEEP", DEFAULTS.changesKeep),
    quotaFile: sibling(FILES.quota),
    quotaMaxPerSave: nonNegative("--quota-per-save", "ABYSS_EDITOR_QUOTA_PER_SAVE", DEFAULTS.quotaMaxPerSave),
    quotaWindowMs: nonNegative("--quota-window-ms", "ABYSS_EDITOR_QUOTA_WINDOW_MS", DEFAULTS.quotaWindowMs),
    quotaMaxPerWindow: nonNegative("--quota-per-window", "ABYSS_EDITOR_QUOTA_PER_WINDOW", DEFAULTS.quotaMaxPerWindow),
    rosterTrustMs: nonNegative("--roster-trust-ms", "ABYSS_EDITOR_ROSTER_TRUST_MS", DEFAULTS.rosterTrustMs),
    linksFile: sibling(FILES.links),
    rosterQq: String(flag("--roster-qq", process.env.ABYSS_EDITOR_ROSTER_QQ ?? DEFAULTS.rosterQq)).trim() || DEFAULTS.rosterQq,
    versionsDir: path.resolve(
      pathOverride("ABYSS_EDITOR_VERSIONS_DIR", process.env.ABYSS_EDITOR_VERSIONS_DIR ?? "") || sibling(FILES.versionsDir),
    ),
    versionsKeep: nonNegative("--versions-keep", "ABYSS_EDITOR_VERSIONS_KEEP", DEFAULTS.versionsKeep),
    archivesDir: path.resolve(
      pathOverride("ABYSS_EDITOR_ARCHIVES_DIR", process.env.ABYSS_EDITOR_ARCHIVES_DIR ?? "") || sibling(FILES.archivesDir),
    ),
    archiveDays: nonNegative("--archive-days", "ABYSS_EDITOR_ARCHIVE_DAYS", DEFAULTS.archiveDays),
    archivesKeep: nonNegative("--archives-keep", "ABYSS_EDITOR_ARCHIVES_KEEP", DEFAULTS.archivesKeep),
  }
  if (!cfg.signKey) cfg.signKey = cfg.token
  const envOwners = splitList(flag("--owner", process.env.ABYSS_EDITOR_OWNER ?? ""))
  const envAdmins = splitList(process.env.ABYSS_EDITOR_ADMINS ?? "")
  if (!cfg.token && !cfg.allowNoToken) {
    failClosed([
      "[editor] 拒绝了启动：没有设置访问口令（谁拿到地址谁就是管理员，能覆盖整张表）。",
      "  正式部署：--token <口令> 或 ABYSS_EDITOR_TOKEN=<口令>；",
      "  本机测试确实不需要口令时，请显式加 --allow-no-token（或 ABYSS_EDITOR_ALLOW_NO_TOKEN=1）。",
    ])
  }
  if (cfg.ownerOnly) {
    const fileOwners = readJsonFile(cfg.adminsFile)?.owner
    const hasOwner = envOwners.length > 0 || (Array.isArray(fileOwners) && fileOwners.some(v => String(v ?? "").trim()))
    if (!hasOwner) {
      failClosed([
        "[editor] 拒绝了启动：开了 --owner-only 但没给主人（--owner / ABYSS_EDITOR_OWNER，或白名单文件里的 owner）。",
        "  否则「只有主人能开」会退化成「谁都能开」；要么补上主人，要么去掉 --owner-only。",
      ])
    }
  }
  {
    const { ok, shared } = secretsIndependent({ token: cfg.token, signKey: cfg.signKey, adminToken: cfg.adminToken })
    const loopback = isLoopbackBind(cfg.bind)
    if (!ok && !(cfg.testPaths && loopback)) {
      failClosed([
        "[editor] 拒绝了启动：访问口令被复用成了特权凭证。",
        ...shared.map(s => `  - ${s}`),
        `  监听地址：${cfg.bind}${loopback ? "（回环）" : "（对外）"}${cfg.testPaths ? "" : "；测试开关未开"}`,
        "  口令会出现在每个人的链接里，拿它当签名密钥/管理口令等于任何人拿到链接就能冒充主人。",
        "  正式部署请另配一段随机串：--sign-key <随机串>（或 ABYSS_EDITOR_SIGN_KEY），例：openssl rand -hex 24；",
        "  确实要在本机联调时退回用口令签，必须同时满足：绑定回环地址（--bind 127.0.0.1）+ ABYSS_EDITOR_TEST_PATHS=1。",
      ])
    }
    cfg.sharedSecrets = ok ? [] : shared
  }
  return { cfg, internal: { config, insidePlugin }, envOwners, envAdmins }
}

export { makeShared, pluginRoot }
