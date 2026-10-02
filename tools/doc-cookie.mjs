/**
 * 临时脚本用：从本机浏览器安全地取腾讯文档的 Cookie
 *
 * 背景：腾讯文档不给匿名导出，必须带登录态。浏览器把 Cookie 加密存在本地：
 *   %LOCALAPPDATA%\<浏览器>\User Data\<配置>\Network\Cookies（SQLite）
 *   值用 AES-256-GCM 加密，密钥存在同目录的 Local State 里、再用 Windows DPAPI（当前用户）保护。
 * 本模块按这个格式解开，只取指定域名的 Cookie，**不打印任何 Cookie 值**。
 *
 * 两个坑：
 *   1. 浏览器正在运行时会把 Cookies 文件独占锁住（EBUSY），必须先关掉它（脚本用的专用配置由脚本自己开关）
 *   2. 解密必须用当前 Windows 用户的 DPAPI，所以只能在机器人这台机器、这个账号下跑
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

const LOCAL = path.join(os.homedir(), "AppData", "Local")

/** 本脚本自己用的浏览器配置（与日常浏览器互不干扰，登录一次即可长期复用） */
export const LOGIN_PROFILE = path.join(LOCAL, "abyss-queue", "doc-profile")

export const edgeExe = () =>
  [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(p => fs.existsSync(p)) ?? ""

/** 各浏览器配置里的 Cookies 文件 */
export function browserProfiles({ includeLoginProfile = true } = {}) {
  const roots = [
    ["Edge", path.join(LOCAL, "Microsoft", "Edge", "User Data")],
    ["Chrome", path.join(LOCAL, "Google", "Chrome", "User Data")],
  ]
  const out = []
  for (const [browser, root] of roots) {
    if (!fs.existsSync(root)) continue
    const names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && (d.name === "Default" || /^Profile \d+$/.test(d.name)))
      .map(d => d.name)
    for (const name of names) {
      for (const rel of ["Network\\Cookies", "Cookies"]) {
        const file = path.join(root, name, rel)
        if (fs.existsSync(file)) out.push({ browser, name, root, file })
      }
    }
  }
  if (includeLoginProfile) {
    for (const rel of ["Default\\Network\\Cookies", "Default\\Cookies"]) {
      const file = path.join(LOGIN_PROFILE, rel)
      if (fs.existsSync(file)) out.push({ browser: "专用窗口", name: "Default", root: LOGIN_PROFILE, file })
    }
  }
  return out
}

/** 用 DPAPI 解开 Local State 里的密钥（只能当前 Windows 用户） */
let cachedKey = null
function masterKey(root) {
  if (cachedKey) return cachedKey
  const stateFile = path.join(root, "Local State")
  if (!fs.existsSync(stateFile)) throw new Error(`找不到 ${stateFile}`)
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
  const encrypted = Buffer.from(state?.os_crypt?.encrypted_key ?? "", "base64")
  if (encrypted.length < 6) throw new Error("Local State 里没有 os_crypt.encrypted_key")
  /** 前 5 字节是字符串 "DPAPI" */
  const payload = encrypted.subarray(5).toString("base64")
  const ps = [
    "Add-Type -AssemblyName System.Security",
    `$b=[Convert]::FromBase64String('${payload}')`,
    "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($k)",
  ].join("; ")
  const b64 = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).trim()
  cachedKey = Buffer.from(b64, "base64")
  if (cachedKey.length !== 32) throw new Error(`DPAPI 解出的密钥长度不对：${cachedKey.length}`)
  return cachedKey
}

/**
 * 解开一条 encrypted_value
 *
 * Edge / Chrome 的 v10 格式：`"v10" + nonce(12) + AES-256-GCM(明文) + tag(16)`，
 * 而**明文本身**是 `SHA256(host_key)(32 字节) + Cookie 值`——这 32 字节是域名绑定校验，
 * 不是值的一部分，必须按 host 校验后再切掉（实测：sha256("127.0.0.1") 与明文前 32 字节完全一致）。
 */
function decryptValue(root, blob, host) {
  if (!blob?.length) return ""
  const buf = Buffer.from(blob)
  const tag = buf.subarray(0, 3).toString("utf8")
  if (tag === "v10" || tag === "v11") {
    const nonce = buf.subarray(3, 15)
    const payload = buf.subarray(15)
    const data = payload.subarray(0, payload.length - 16)
    const authTag = payload.subarray(payload.length - 16)
    const d = crypto.createDecipheriv("aes-256-gcm", masterKey(root), nonce)
    d.setAuthTag(authTag)
    const plain = Buffer.concat([d.update(data), d.final()])
    /** 前 32 字节是域名哈希：对得上就切掉，对不上就原样当值（老版本没有这一段） */
    if (plain.length > 32) {
      const want = crypto.createHash("sha256").update(String(host)).digest()
      if (plain.subarray(0, 32).equals(want)) return plain.subarray(32).toString("utf8")
    }
    return plain.toString("utf8")
  }
  /** 老格式：整段就是 DPAPI 保护的（现在很少见） */
  const ps = [
    "Add-Type -AssemblyName System.Security",
    `$b=[Convert]::FromBase64String('${buf.toString("base64")}')`,
    "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Text.Encoding]::UTF8.GetString($k)",
  ].join("; ")
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" })
}

/**
 * 读某个配置里的 Cookie
 *
 * 安全约定（改这个文件时请保持）：
 *   - 浏览器那份库是独占锁的，这里先拷一份到 %TEMP% 再读；**无论成功失败都在 finally 里删掉**
 *   - 任何日志都不打印 Cookie 值；调用方拿到的只是内存里的这一份，不落盘
 * @param {object} profile browserProfiles() 里的一项
 * @param {string[]} hosts 只取这些域（后缀匹配）
 * @returns {Array<{host:string,name:string,value:string}>}
 */
export async function readCookies(profile, hosts) {
  const { DatabaseSync } = await import("node:sqlite")
  const tmp = path.join(os.tmpdir(), `abyss-cookies-${process.pid}-${Date.now()}.db`)
  try {
    fs.copyFileSync(profile.file, tmp)
    const db = new DatabaseSync(tmp, { readOnly: true })
    let rows = []
    try {
      /** expires_utc 是 64 位 BIGINT，node:sqlite 不肯直接转成 number，这里按文本取出来自己解析 */
      rows = db
        .prepare("SELECT host_key, name, value, encrypted_value, CAST(expires_utc AS TEXT) AS expires_utc FROM cookies")
        .all()
    } finally {
      db.close()
    }

    /** Chrome 时间戳：1601-01-01 起算的微秒；0 表示会话 Cookie */
    const now = (Date.now() + 11644473600000) * 1000
    const out = []
    for (const r of rows) {
      const host = String(r.host_key ?? "").replace(/^\./, "")
      if (!hosts.some(h => host === h || host.endsWith(`.${h}`))) continue
      if (r.expires_utc && Number(r.expires_utc) < now) continue
      let value = String(r.value ?? "")
      if (!value && r.encrypted_value) {
        try {
          value = decryptValue(profile.root, r.encrypted_value, r.host_key)
        } catch {
          continue
        }
      }
      /** 只收能安全放进 HTTP 头的值（解错的字节会出现替换字符） */
      if (value && !/[\uFFFD\u0000-\u001f\u007f]/.test(value)) out.push({ host, name: String(r.name), value })
    }
    return out
  } finally {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /** 删不掉也不能把路径留着给人猜 */
    }
  }
}

/** 顺手清掉以前跑崩留下的副本（同名前缀） */
export function cleanTempCopies() {
  try {
    for (const name of fs.readdirSync(os.tmpdir()))
      if (/^abyss-cookies-\d+-\d+\.db$/.test(name)) fs.rmSync(path.join(os.tmpdir(), name), { force: true })
  } catch {}
}

/** 拼成 Cookie 请求头（只在本进程内存里用；**不要**打印、不要写文件） */
export const cookieHeader = rows => rows.map(r => `${r.name}=${r.value}`).join("; ")

/**
 * 把日志里可能出现的 Cookie 值抹掉
 * 用途：任何要打印的字符串（尤其是网络错误的 message）先过一遍，避免值被带出去
 * @param {string} text 待打印文本
 * @param {string|string[]} secrets 已知的敏感串（cookie 请求头原文，或若干个值）
 */
export const redact = (text, secrets = "") => {
  let out = String(text ?? "")
  for (const raw of Array.isArray(secrets) ? secrets : [secrets]) {
    const secret = String(raw ?? "")
    /** 太短的串到处都是，替换了反而看不清日志；这里只处理像样的长度 */
    if (secret.length >= 6) out = out.split(secret).join("<已隐藏>")
  }
  /** 兜底：`xxx=很长的一串` 这种形态也盖住（避免 header 片段被带出来） */
  return out.replace(/\b([\w.-]{2,})=([A-Za-z0-9%._~+/-]{8,})/g, "$1=<已隐藏>")
}

/**
 * 自动从本机取一份能用的腾讯文档 Cookie
 * @returns {Promise<{cookie:string, from:string, error?:string}>}
 */
export async function autoCookie({ hosts = ["docs.qq.com", "qq.com"], log = () => {}, prefer = [] } = {}) {
  const profiles = browserProfiles()
  /** 专用窗口优先（它只用来登录腾讯文档，最干净） */
  const ordered = [...profiles].sort((a, b) => {
    const rank = p => (prefer.includes(p.browser) ? 0 : p.browser === "专用窗口" ? 1 : 2)
    return rank(a) - rank(b)
  })
  const problems = []
  for (const profile of ordered) {
    try {
      const rows = await readCookies(profile, hosts)
      if (!rows.length) continue
      log(`已从「${profile.browser} / ${profile.name}」读到 ${rows.length} 条腾讯文档 Cookie（${[...new Set(rows.map(r => r.name))].slice(0, 4).join("、")}…）`)
      return { cookie: cookieHeader(rows), from: `${profile.browser} / ${profile.name}` }
    } catch (err) {
      problems.push(`${profile.browser}/${profile.name}：${err.message.includes("EBUSY") ? "被浏览器锁着（关掉它再试）" : err.message}`)
    }
  }
  return { cookie: "", from: "", error: problems.slice(0, 4).join("；") }
}
