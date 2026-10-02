/**
 * git 操作封装（执行命令 + 组装结果）
 *
 * 依赖框架注入的全局 `Bot.exec`；本模块只负责"跑命令 + 用 lib/git.js 的纯函数解析"。
 * 插件目录不是 git 仓库（例如手动解压安装）时，所有操作返回 unavailable，由调用方给出提示。
 */
import fs from "node:fs"
import path from "node:path"
import {
  countStatusEntries,
  parseAheadBehind,
  parseCommitLine,
  parseFetchResult,
  parseLogLines,
  parseTrackLine,
} from "../lib/git.js"

export const GIT_TIMEOUT = 60000

/** 执行 git 命令；cwd 为插件目录；关掉 CRLF 警告以免污染输出 */
async function run(args, cwd) {
  return Bot.exec(`git -c core.safecrlf=false ${args}`, { cwd, timeout: GIT_TIMEOUT })
}

/** 该目录是否是 git 仓库 */
export function isRepo(dir) {
  return fs.existsSync(path.join(dir, ".git"))
}

/** 读取仓库状态（分支跟踪 + 本地改动数 + 当前提交） */
export async function readStatus(dir) {
  if (!isRepo(dir)) return { available: false }
  const [st, log] = await Promise.all([run("status --branch --porcelain", dir), run("log -1 --pretty=%h|%s", dir)])
  const lines = String(st.stdout ?? "").split("\n").filter(Boolean)
  const track = parseTrackLine(lines[0] ?? "")
  const changes = countStatusEntries(lines.slice(1).join("\n"))
  return {
    available: true,
    ...track,
    changes,
    commit: parseCommitLine(log.stdout),
    error: st.error?.message ?? "",
  }
}

/** 取当前提交（更新后用来对比） */
export async function headCommit(dir) {
  if (!isRepo(dir)) return { hash: "", subject: "" }
  const res = await run("log -1 --pretty=%h|%s", dir)
  return parseCommitLine(res.stdout)
}

/** 从远端拉取引用（不改工作区），返回 fetch 结果 */
export async function fetchRemote(dir) {
  if (!isRepo(dir)) return { status: "unavailable", message: "" }
  const res = await run("fetch --prune origin", dir)
  return parseFetchResult(res)
}

/** 本地 HEAD 与上游的领先/落后关系 */
export async function compareWithUpstream(dir) {
  const status = await readStatus(dir)
  if (!status.available || !status.hasUpstream) return { ...status, ahead: 0, behind: 0, hasUpstream: false }
  const res = await run(`rev-list --left-right --count HEAD...${status.upstream}`, dir)
  return { ...status, ...parseAheadBehind(res.stdout) }
}

/**
 * 快进到上游（不改写历史；仅当本地无分叉时可用）
 * 失败即说明工作区有改动与远端重叠，由调用方决定是否强制
 */
export async function fastForward(dir) {
  const res = await run("merge --ff-only @{u}", dir)
  return { error: res.error, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

/** 强制对齐到上游（丢弃本地改动，含未跟踪文件不清理） */
export async function forceReset(dir) {
  const status = await readStatus(dir)
  if (!status.available || !status.hasUpstream) return { error: new Error("没有配置上游分支，无法强制对齐"), stdout: "" }
  const res = await run(`reset --hard ${status.upstream}`, dir)
  return { error: res.error, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

/**
 * 取两次提交之间的日志（供「更新日志」展示）
 *
 * 用 `%ct`（Unix 时间戳）而不是 `--date=format:"%F %T"`：
 * 后者含空格，经 `Bot.exec` 的 cmd 解析会被截断，格式不可靠。
 * @param from 旧提交（为空则只取最新一条）
 * @param to 新提交（默认 HEAD）
 */
export async function logBetween(dir, from, to = "HEAD") {
  if (!isRepo(dir)) return []
  const range = from ? `${from}..${to}` : "-1"
  const res = await run(`log ${range} --pretty=%h|%ct|%s`, dir)
  return parseLogLines(res.stdout)
}

/** 取仓库地址（去掉 URL 中的凭据，便于直接展示） */
export async function remoteUrl(dir) {
  if (!isRepo(dir)) return ""
  const res = await run("config --get remote.origin.url", dir)
  return String(res.stdout ?? "")
    .trim()
    .replace(/\/\/([^@/]+)@/, "//")
}
