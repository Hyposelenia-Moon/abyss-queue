/**
 * 启动期的一次性补齐：编辑器凭证与管理员白名单
 *
 * 以前这两件事要主人手动做一次（还得记着做）。现在并入启动：**只在缺失时写一次**，
 * 写完以后每次启动都只是读一下，不再碰配置文件——主人手改过的值不会被覆盖。
 */
import fsSync from "node:fs"
import { randomBytes } from "node:crypto"
import YAML from "yaml"
import { pluginRoot } from "./config.js"
import { log } from "./logger.js"

const SECRET_KEYS = ["token", "sign_key"]
const EDITOR_KEYS = [...SECRET_KEYS, "public_url"]

const emptyKeys = () => ({ token: "", sign_key: "", public_url: "" })

const randomHex = n => randomBytes(n).toString("hex")

/**
 * 读出 `editor:` 段里的三个键（只读，不改）
 * @returns {{ error: string|null, hasEditor: boolean, wrongShape: boolean, keys: object, doc: object|null }}
 */
export function readEditorKeys(text) {
  const doc = YAML.parseDocument(String(text ?? ""), { keepSourceTokens: true })
  const errors = doc.errors ?? []
  if (errors.length)
    return {
      error: `config.yaml 解析不了：${String(errors[0]?.message ?? errors[0]).split("\n")[0]}`,
      hasEditor: false,
      wrongShape: false,
      keys: emptyKeys(),
      doc: null,
    }
  const editor = doc.getIn(["editor"])
  if (editor === undefined || editor === null)
    return { error: null, hasEditor: false, wrongShape: false, keys: emptyKeys(), doc }
  if (typeof editor !== "object" || Array.isArray(editor))
    return { error: null, hasEditor: true, wrongShape: true, keys: emptyKeys(), doc }
  const keys = emptyKeys()
  for (const key of EDITOR_KEYS) {
    const v = doc.getIn(["editor", key])
    if (v === undefined || v === null) continue
    if (typeof v === "object") return { error: null, hasEditor: true, wrongShape: true, keys: emptyKeys(), doc }
    keys[key] = String(v)
  }
  return { error: null, hasEditor: true, wrongShape: false, keys, doc }
}

function insertAnchor(lines, where) {
  const bare = lines.map(l => l.replace(/\r$/, ""))
  const at = bare.findIndex(l => (where === "token" ? /^\s+token:/.test(l) : /^editor:/.test(l)))
  if (at < 0) return null
  const own = /^([ \t]+)\S/.exec(bare[at])?.[1]
  const indent = own ?? /^([ \t]+)\S/.exec(bare[at + 1] ?? "")?.[1] ?? "  "
  return { at: at + 1, indent, eol: lines[at].endsWith("\r") ? "\r" : "" }
}

/**
 * 只改 `editor.token` / `editor.sign_key` 两行，其余注释与内容按原文保留
 * @returns {string|null} 改不了（读不出 / 形状不对）时返回 null
 */
export function patchEditorSecrets(text, { token, signKey }) {
  const src = String(text ?? "")
  const cur = readEditorKeys(src)
  if (cur.error || !cur.hasEditor || cur.wrongShape) return null
  const wanted = { token: String(token ?? ""), sign_key: String(signKey ?? "") }
  let out = src
  const missing = SECRET_KEYS.filter(key => !cur.doc.getIn(["editor", key], true))
  if (missing.length) {
    const lines = out.split("\n")
    const anchor = insertAnchor(lines, missing.includes("token") ? "editor" : "token")
    if (!anchor) return null
    lines.splice(anchor.at, 0, ...missing.map(key => `${anchor.indent}${key}: ""${anchor.eol}`))
    out = lines.join("\n")
  }
  const doc = YAML.parseDocument(out, { keepSourceTokens: true })
  const edits = []
  for (const key of SECRET_KEYS) {
    const node = doc.getIn(["editor", key], true)
    if (!node?.range) return null
    edits.push({ start: node.range[0], end: node.range[1], text: JSON.stringify(wanted[key]) })
  }
  edits.sort((a, b) => b.start - a.start)
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

const failed = detail => ({ status: "fail", detail })
const skipped = detail => ({ status: "skip", detail })
const done = (detail, extra = {}) => ({ status: "done", detail, ...extra })

/**
 * 缺 `editor.token` / `editor.sign_key` 就补上（两个都已有就一个字都不写）
 * @returns {{ status: "done"|"skip"|"fail", detail: string, token?: string, signKey?: string }}
 */
export function ensureEditorSecrets({ fs = fsSync, configPath } = {}) {
  if (!configPath) return failed("没有配置文件路径")
  if (!fs.existsSync(configPath)) return skipped("还没有 config.yaml")
  let text
  try {
    text = fs.readFileSync(configPath, "utf8")
  } catch (err) {
    return failed(`读不了 config.yaml：${err?.message ?? err}`)
  }
  const cur = readEditorKeys(text)
  if (cur.error) return failed(cur.error)
  if (!cur.hasEditor) return failed("config.yaml 里没有 editor: 段")
  if (cur.wrongShape) return failed("config.yaml 的 editor: 不是一个映射段")
  const missing = []
  if (!cur.keys.token) missing.push("editor.token")
  if (!cur.keys.sign_key) missing.push("editor.sign_key")
  const token = cur.keys.token || randomHex(16)
  const signKey = cur.keys.sign_key || randomHex(24)
  if (!missing.length) return skipped("凭证已有")
  const next = patchEditorSecrets(text, { token, signKey })
  if (next === null) return failed("改不了 editor 段（读不出来或形状不对）")
  const back = readEditorKeys(next)
  if (back.error || back.keys.token !== token || back.keys.sign_key !== signKey)
    return failed("改写后的 config.yaml 校验不过，已放弃写入")
  fs.writeFileSync(configPath, next, "utf8")
  return done(`已生成 ${missing.join("、")}`, { token, signKey })
}

/**
 * 白名单文件缺失、或里面还没有 owner 时，把框架配置里的主人写进去
 * @returns {{ status: "done"|"skip"|"fail", detail: string }}
 */
export function ensureAdminWhitelist({ fs = fsSync, dataDir, adminsFile, owners = [] } = {}) {
  if (!dataDir || !adminsFile) return failed("没有白名单路径")
  const qqs = [
    ...new Set(
      (Array.isArray(owners) ? owners : [owners])
        .map(v => String(v ?? "").trim())
        .filter(v => /^\d{5,12}$/.test(v)),
    ),
  ]
  if (!qqs.length) return skipped("框架没有配置主人 QQ")
  let cur = null
  if (fs.existsSync(adminsFile)) {
    try {
      cur = JSON.parse(fs.readFileSync(adminsFile, "utf8").replace(/^\uFEFF/, ""))
    } catch (err) {
      return failed(`白名单文件不是合法 JSON，插件不敢覆盖：${err?.message ?? err}`)
    }
    const have = (Array.isArray(cur?.owner) ? cur.owner : []).map(String).filter(Boolean)
    if (have.length) return skipped("白名单已有 owner")
  }
  const admins = [...new Set([...(Array.isArray(cur?.admins) ? cur.admins.map(String) : []), ...qqs])]
  const next = { ...(cur ?? {}), owner: qqs, admins }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(adminsFile, JSON.stringify(next, null, 2) + "\n", "utf8")
  return done(`已写入 owner = ${qqs.join("、")}`)
}

/**
 * 启动时跑一次：两步各自独立，谁读写不了都只记一行日志，绝不让 bot 起不来
 * @returns {{ secrets: object, whitelist: object }}
 */
export function bootstrap({ fs = fsSync, root = pluginRoot, owners = globalThis.cfg?.masterQQ, say = log } = {}) {
  const dataDir = `${root}/data`
  const out = {}
  try {
    out.secrets = ensureEditorSecrets({ fs, configPath: `${root}/config/config.yaml` })
  } catch (err) {
    out.secrets = failed(`${err?.message ?? err}`)
  }
  try {
    out.whitelist = ensureAdminWhitelist({ fs, dataDir, adminsFile: `${dataDir}/abyss-editor-admins.json`, owners })
  } catch (err) {
    out.whitelist = failed(`${err?.message ?? err}`)
  }
  for (const [key, res] of Object.entries(out)) {
    if (!res) continue
    if (res.status === "done") say("info", `[abyss-queue] 启动补齐（${key}）：${res.detail}`)
    else if (res.status === "fail") say("warn", `[abyss-queue] 启动补齐（${key}）没做：${res.detail}`)
  }
  return out
}