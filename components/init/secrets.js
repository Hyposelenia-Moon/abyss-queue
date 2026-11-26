/** 第 1 步：口令 / 签名密钥 —— 为空才生成，且**只改 editor 段那两行** */
import YAML from "yaml"
import { FAIL, OK, SKIP, describeSecret, randomHex, rel } from "./common.js"

const SECRET_KEYS = ["token", "sign_key"]
const EDITOR_KEYS = [...SECRET_KEYS, "public_url"]

const emptyKeys = () => ({ token: "", sign_key: "", public_url: "" })

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

export function stepSecrets(ctx) {
  const { configPath } = ctx.paths
  if (!ctx.fs.existsSync(configPath))
    return FAIL(`找不到配置文件：${rel(ctx, configPath)}（先启动一次机器人，它会从 config.yaml.example 生成一份）`)
  const text = ctx.fs.readFileSync(configPath, "utf8")
  const cur = readEditorKeys(text)
  if (cur.error) return FAIL(`${cur.error}；已停下，一个字都没写（先修好这份配置）`)
  if (!cur.hasEditor) return FAIL(`config.yaml 里没有 editor: 段（口令与签名密钥写在它下面）：${rel(ctx, configPath)}`)
  if (cur.wrongShape)
    return FAIL(`config.yaml 的 editor: 不是一个映射段（下面该逐行写 public_url / token / sign_key）：${rel(ctx, configPath)}`)
  const token = cur.keys.token || randomHex(16)
  const signKey = cur.keys.sign_key || randomHex(24)
  ctx.secrets = { token, signKey }
  const made = []
  if (!cur.keys.token) made.push("editor.token（16 字节随机）")
  if (!cur.keys.sign_key) made.push("editor.sign_key（24 字节随机）")
  if (!made.length)
    return SKIP(`已有 editor.token ${describeSecret(token)} 与 editor.sign_key ${describeSecret(signKey)}，未改动`)
  const next = patchEditorSecrets(text, { token, signKey })
  if (next === null) return FAIL(`改不了 editor 段（读不出来或形状不对）：${rel(ctx, configPath)}`)
  const back = readEditorKeys(next)
  if (back.error || back.keys.token !== token || back.keys.sign_key !== signKey)
    return FAIL(
      `改写后的 config.yaml 校验不过（${back.error ?? "口令 / 签名密钥读回来不是刚生成的这两个值"}），已放弃写入，原文件没有被改动`,
    )
  ctx.fs.writeFileSync(configPath, next, "utf8")
  return OK(`已生成并只改这两行：${made.join("、")}；其余注释与内容原样保留`)
}
