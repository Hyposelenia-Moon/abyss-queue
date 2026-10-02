/**
 * git 操作封装（执行命令 + 组装结果）
 *
 * 依赖框架注入的全局 `Bot.exec`；本模块只负责"跑命令 + 用 lib/git.js 的纯函数解析"。
 * 插件目录不是 git 仓库（例如手动解压安装）时，所有操作返回 unavailable，由调用方给出提示。
 */
import fs from "node:fs"
import path from "node:path"
import { countStatusEntries, parseCommitLine, parsePullResult, parseTrackLine } from "../lib/git.js"

export const GIT_TIMEOUT = 60000

/** 执行 git 命令；cwd 为插件目录 */
async function run(args, cwd) {
  return Bot.exec(`git ${args}`, { cwd, timeout: GIT_TIMEOUT })
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

/**
 * 拉取更新并解析结果（不判定是否有新提交，由调用方对比前后 commit）
 */
export async function pull(dir) {
  if (!isRepo(dir)) return { status: "unavailable", message: "" }
  const res = await run("pull", dir)
  return parsePullResult(res)
}

/** 取当前提交（更新后用来对比） */
export async function headCommit(dir) {
  if (!isRepo(dir)) return { hash: "", subject: "" }
  const res = await run("log -1 --pretty=%h|%s", dir)
  return parseCommitLine(res.stdout)
}
