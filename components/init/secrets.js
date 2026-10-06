/**
 * 第 1 步：口令 / 签名密钥 —— 为空才生成，且**只改 remote 段那两行**
 *
 * 为什么不用 YAML.stringify 整份重写：那会丢掉全部注释、重排键序。主人的配置里写满了
 * "为什么这么填"的注释，重写一遍等于毁掉它。
 *
 * 所以这一步骤守两条：
 *   1. **取值交给 YAML 解析器**——它天然剥掉行尾注释、正确解开引号。手写正则剥不掉注释，
 *      会把「值 + 注释」整段当成值（`token: ""  # 说明` 读成一个 55 字符的"口令"）。
 *   2. **写值只替换那个标量占的字符区间**（`yaml` 给的 `node.range`）——缩进、行尾注释、
 *      行尾符与其余每一个字节都不动。
 * 两条合起来才能保证：不论值里有什么，写出来的始终是一份**读得回来**的配置。
 */
import YAML from "yaml"
import { FAIL, OK, SKIP, describeSecret, randomHex, rel } from "./common.js"

/** 本步骤要读写的三个键（前两个会写，`url` 只读来算云端地址） */
const SECRET_KEYS = ["token", "sign_key"]
const REMOTE_KEYS = [...SECRET_KEYS, "url"]

/** 本机地址：不写进启动器的云端行（让它"从自己拉快照"没有意义） */
const LOCAL_URL = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i

const emptyKeys = () => ({ token: "", sign_key: "", url: "" })

/**
 * 读 remote 段的三个键
 *
 * @param {string} text 配置文件原文
 * @returns {{error: string|null, hasRemote: boolean, wrongShape: boolean, keys: {token: string, sign_key: string, url: string}, doc: object|null}}
 *   `error` 非空 = **这份文件读不出来**。调用方必须停下来：坏文件上做行级改写只会越改越糟。
 */
export function readRemoteKeys(text) {
  const doc = YAML.parseDocument(String(text ?? ""), { keepSourceTokens: true })
  const errors = doc.errors ?? []
  if (errors.length)
    return {
      error: `config.yaml 解析不了：${String(errors[0]?.message ?? errors[0]).split("\n")[0]}`,
      hasRemote: false,
      wrongShape: false,
      keys: emptyKeys(),
      doc: null,
    }
  const remote = doc.getIn(["remote"])
  if (remote === undefined || remote === null)
    return { error: null, hasRemote: false, wrongShape: false, keys: emptyKeys(), doc }
  if (typeof remote !== "object" || Array.isArray(remote))
    return { error: null, hasRemote: true, wrongShape: true, keys: emptyKeys(), doc }
  const keys = emptyKeys()
  for (const key of REMOTE_KEYS) {
    const v = doc.getIn(["remote", key])
    if (v === undefined || v === null) continue
    /** 三个键都只该是标量；写成对象 / 数组的一律按"形状不对"处理，不做字符串化硬凑 */
    if (typeof v === "object") return { error: null, hasRemote: true, wrongShape: true, keys: emptyKeys(), doc }
    keys[key] = String(v)
  }
  return { error: null, hasRemote: true, wrongShape: false, keys, doc }
}

/**
 * 补缺行时的插入点：插在 `where` 那一行**之后**
 *
 * `where` 只给键名（`remote` / `token`）——这里只在**物理行**里定位它，不解析值。
 * 缩进照抄那一行（没有缩进时照抄它下面第一行），行尾符按被插入那行自己的。
 */
function insertAnchor(lines, where) {
  const bare = lines.map(l => l.replace(/\r$/, ""))
  const at = bare.findIndex(l => (where === "token" ? /^\s+token:/.test(l) : /^remote:/.test(l)))
  if (at < 0) return null
  const own = /^([ \t]+)\S/.exec(bare[at])?.[1]
  const indent = own ?? /^([ \t]+)\S/.exec(bare[at + 1] ?? "")?.[1] ?? "  "
  return { at: at + 1, indent, eol: lines[at].endsWith("\r") ? "\r" : "" }
}

/**
 * 改（或补）remote 段里的 token / sign_key，**其余部分一个字节都不动**
 *
 * 已有行：只替换标量占的字符区间（`node.range`），缩进与行尾注释原样留下；
 * 缺行：补进 remote 段（token 缺就补在最前，sign_key 缺就补在 token 之后）。
 *
 * @returns {string|null} 新文本；文件读不出来、没有 remote 段、或 remote 不是映射时返回 null
 */
export function patchRemoteSecrets(text, { token, signKey }) {
  const src = String(text ?? "")
  const cur = readRemoteKeys(src)
  if (cur.error || !cur.hasRemote || cur.wrongShape) return null

  const wanted = { token: String(token ?? ""), sign_key: String(signKey ?? "") }

  /** 先补缺行（改行数），再统一按字符区间替换（不动行数）——分成两步各自都好推理 */
  let out = src
  const missing = SECRET_KEYS.filter(key => !cur.doc.getIn(["remote", key], true))
  if (missing.length) {
    const lines = out.split("\n")
    const anchor = insertAnchor(lines, missing.includes("token") ? "remote" : "token")
    if (!anchor) return null
    lines.splice(anchor.at, 0, ...missing.map(key => `${anchor.indent}${key}: ""${anchor.eol}`))
    out = lines.join("\n")
  }

  /** 从后往前替换：改前面的区间不会让后面记下的下标失效 */
  const doc = YAML.parseDocument(out, { keepSourceTokens: true })
  const edits = []
  for (const key of SECRET_KEYS) {
    const node = doc.getIn(["remote", key], true)
    if (!node?.range) return null
    edits.push({ start: node.range[0], end: node.range[1], text: JSON.stringify(wanted[key]) })
  }
  edits.sort((a, b) => b.start - a.start)
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

/** 1) 口令 / 签名密钥：为空才生成，且只改这两行 */
export function stepSecrets(ctx) {
  const { configPath } = ctx.paths
  if (!ctx.fs.existsSync(configPath))
    return FAIL(`找不到配置文件：${rel(ctx, configPath)}（先启动一次机器人，它会从 config.yaml.example 生成一份）`)
  const text = ctx.fs.readFileSync(configPath, "utf8")
  const cur = readRemoteKeys(text)
  /** 读不出来就停在这里：这份文件可能正是上一次写坏的现场，接着改只会更糟 */
  if (cur.error) return FAIL(`${cur.error}；已停下，一个字都没写（先修好这份配置）`)
  if (!cur.hasRemote) return FAIL(`config.yaml 里没有 remote: 段（口令与签名密钥写在它下面）：${rel(ctx, configPath)}`)
  if (cur.wrongShape)
    return FAIL(`config.yaml 的 remote: 不是一个映射段（下面该逐行写 url / token / sign_key）：${rel(ctx, configPath)}`)

  const token = cur.keys.token || randomHex(16)
  const signKey = cur.keys.sign_key || randomHex(24)
  const cloud = LOCAL_URL.test(cur.keys.url) ? "" : cur.keys.url
  ctx.secrets = { token, signKey, cloud }

  const made = []
  if (!cur.keys.token) made.push("remote.token（16 字节随机）")
  if (!cur.keys.sign_key) made.push("remote.sign_key（24 字节随机）")
  if (!made.length)
    return SKIP(`已有 remote.token ${describeSecret(token)} 与 remote.sign_key ${describeSecret(signKey)}，未改动`)

  const next = patchRemoteSecrets(text, { token, signKey })
  if (next === null) return FAIL(`改不了 remote 段（读不出来或形状不对）：${rel(ctx, configPath)}`)
  /**
   * **写前验证**：新文本必须解析得回来，且这两个键读回来的就是准备写进去的值。
   * 正常路径下"只替换标量区间"写不出坏 YAML，这道闸是兜底——少了它，将来改写法就能再写出
   * 一份读不回来的配置（锅巴那条写入路径已经立过同一道闸，见 AGENTS.md §3.4.1 第 7 条）。
   */
  const back = readRemoteKeys(next)
  if (back.error || back.keys.token !== token || back.keys.sign_key !== signKey)
    return FAIL(
      `改写后的 config.yaml 校验不过（${back.error ?? "口令 / 签名密钥读回来不是刚生成的这两个值"}），已放弃写入，原文件没有被改动`,
    )
  ctx.fs.writeFileSync(configPath, next, "utf8")
  return OK(`已生成并只改这两行：${made.join("、")}；其余注释与内容原样保留`)
}
