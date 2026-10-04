/**
 * 第 3 步：口令 / 签名密钥 —— 为空才生成，且**只改 remote 段那两行**
 *
 * 为什么不用 YAML.stringify 整份重写：那会丢掉全部注释、重排键序。主人的配置里写满了
 * "为什么这么填"的注释，重写一遍等于毁掉它。这里逐行处理，并保留每行自己的行尾。
 */
import { FAIL, OK, SKIP, mask, randomHex, rel } from "./common.js"

/**
 * remote 段的行范围
 *
 * 只在 `remote:` 这一层里动键：配置文件里别处也可能有 `token` 之类的键，
 * 全局正则替换会连带改错（tools/deploy-windows.ps1 的老写法就是这么干的）。
 */
function remoteBlockRange(lines) {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const top = /^([A-Za-z0-9_.-]+):/.exec(lines[i].replace(/\r$/, ""))
    if (!top) continue
    if (top[1] === "remote") {
      start = i
      continue
    }
    if (start >= 0) return { start, end: i }
  }
  return start >= 0 ? { start, end: lines.length } : null
}

/** 读 remote 段的三个键（口令 / 签名密钥 / 云端地址） */
export function readRemoteKeys(text) {
  const lines = String(text ?? "").split("\n")
  const range = remoteBlockRange(lines)
  if (!range) return null
  const out = { token: "", sign_key: "", url: "" }
  for (let i = range.start + 1; i < range.end && i < lines.length; i++) {
    const m = /^\s+([A-Za-z0-9_]+):(\s*)(.*)$/.exec(lines[i].replace(/\r$/, ""))
    if (!m) continue
    const key = m[1]
    if (!(key in out)) continue
    out[key] = /^"(.*)"\s*$/.exec(m[3])?.[1] ?? m[3].trim()
  }
  return out
}

/**
 * 改（或补）remote 段里的 token / sign_key，**其余部分一个字节都不动**
 *
 * 逐行处理，并保留每行自己的行尾（按 `\n` 切分，CRLF 行尾的 `\r` 留在行里）。
 * @returns {string|null} 新文本；没有 remote 段时返回 null
 */
export function patchRemoteSecrets(text, { token, signKey }) {
  const lines = String(text ?? "").split("\n")
  const range = remoteBlockRange(lines)
  if (!range) return null

  const scan = key => {
    for (let i = range.start + 1; i < range.end && i < lines.length; i++) {
      const raw = lines[i]
      const m = /^(\s+)([A-Za-z0-9_]+):(\s*)(.*)$/.exec(raw.replace(/\r$/, ""))
      if (m && m[2] === key) return { i, indent: m[1], eol: raw.endsWith("\r") ? "\r" : "" }
    }
    return null
  }
  const tokenAt = scan("token")
  const signAt = scan("sign_key")
  const eol = lines[range.start]?.endsWith("\r") ? "\r" : ""

  /** 先改既有行（改内容不影响下标），再补缺行（插入会挪下标，所以要累计偏移） */
  if (tokenAt) lines[tokenAt.i] = `${tokenAt.indent}token: "${token}"${tokenAt.eol}`
  if (signAt) lines[signAt.i] = `${signAt.indent}sign_key: "${signKey}"${signAt.eol}`

  const values = { token, sign_key: signKey }
  const inserts = []
  let offset = 0
  for (const key of ["token", "sign_key"]) {
    if (key === "token" ? tokenAt : signAt) continue
    const anchor = key === "sign_key" ? tokenAt : null
    const indent = anchor?.indent ?? signAt?.indent ?? "  "
    inserts.push({
      at: (anchor ? anchor.i + 1 : range.start + 1) + offset,
      line: `${indent}${key}: "${values[key]}"${anchor?.eol ?? eol}`,
    })
    offset += 1
  }
  for (const ins of inserts) lines.splice(ins.at, 0, ins.line)
  return lines.join("\n")
}

/** 3) 口令 / 签名密钥：为空才生成，且只改这两行 */
export function stepSecrets(ctx) {
  const { configPath } = ctx.paths
  if (!ctx.fs.existsSync(configPath))
    return FAIL(`找不到配置文件：${rel(ctx, configPath)}（先启动一次机器人，它会从 config.yaml.example 生成一份）`)
  const text = ctx.fs.readFileSync(configPath, "utf8")
  const cur = readRemoteKeys(text)
  if (!cur) return FAIL(`config.yaml 里没有 remote: 段（口令与签名密钥写在它下面）：${rel(ctx, configPath)}`)

  const token = cur.token || randomHex(16)
  const signKey = cur.sign_key || randomHex(24)
  /** 云端地址行：本机地址（127.0.0.1/localhost）不写进去 —— 让启动器"从自己拉快照"没有意义 */
  const cloud = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(cur.url) ? "" : cur.url
  ctx.secrets = { token, signKey, cloud }

  const made = []
  if (!cur.token) made.push("remote.token（16 字节随机）")
  if (!cur.sign_key) made.push("remote.sign_key（24 字节随机）")
  if (!made.length) return SKIP(`已有 remote.token ${mask(token)} 与 remote.sign_key ${mask(signKey)}，未改动`)

  const next = patchRemoteSecrets(text, { token, signKey })
  if (next === null) return FAIL(`改不了 remote 段（没有它）：${rel(ctx, configPath)}`)
  ctx.fs.writeFileSync(configPath, next, "utf8")
  return OK(`已生成并只改这两行：${made.join("、")}；其余注释与内容原样保留`)
}
