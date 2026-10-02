/**
 * git 输出的纯解析函数（不依赖文件系统 / 框架，可独立测试）
 *
 * 只覆盖「判断能否更新」所需的三类输出：
 *   - `git status --branch --porcelain` 的首行分支跟踪信息
 *   - `git log -1 --pretty=%h|%s` 的提交摘要
 *   - `git pull` 的结果判定
 */

/** 解析 `## main...origin/main [ahead 1, behind 2]` */
export function parseTrackLine(line) {
  const text = String(line ?? "").trim()
  const m = /^##\s+(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.+?)\])?$/.exec(text)
  if (!m) return { branch: "", upstream: "", ahead: 0, behind: 0, hasUpstream: false }
  const [, branch, upstream, state] = m
  const num = key => {
    const hit = new RegExp(`${key}\\s+(\\d+)`).exec(state ?? "")
    return hit ? Number(hit[1]) : 0
  }
  return {
    branch,
    upstream: upstream ?? "",
    ahead: num("ahead"),
    behind: num("behind"),
    hasUpstream: Boolean(upstream),
  }
}

/** 解析 `git status --porcelain`：返回改动条目数（M/A/D/?? 都算） */
export function countStatusEntries(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map(i => i.trim())
    .filter(Boolean).length
}

/**
 * 解析 `hhh|subject` 形式的提交摘要
 *
 * git 可能把 warning（如 LF/CRLF 转换提示）混进 stdout，因此逐行找真正的提交行。
 */
export function parseCommitLine(line) {
  const lines = String(line ?? "").split("\n")
  for (const raw of lines) {
    const m = /^([0-9a-f]{4,40})\|(.*)$/.exec(raw.trim())
    if (m) return { hash: m[1], subject: m[2].trim() }
  }
  return { hash: "", subject: "" }
}

/**
 * 判断 `git pull` 的结果
 * @returns {{status: "uptodate"|"updated"|"conflict"|"error", message: string}}
 */
export function parsePullResult({ stdout = "", stderr = "", error } = {}) {
  const out = `${stdout ?? ""}\n${stderr ?? ""}\n${error?.message ?? ""}`
  if (error)
    return {
      status: /be overwritten by merge|被合并操作覆盖|Merge conflict|合并冲突|local changes/i.test(out)
        ? "conflict"
        : "error",
      message: error.message ?? String(error),
    }
  if (/Already up[ -]to[ -]date|已经是最新|Already up to date/i.test(out)) return { status: "uptodate", message: "" }
  if (/Fast-forward|Updating|files? changed|文件变更/i.test(out)) return { status: "updated", message: "" }
  return { status: "uptodate", message: "" }
}

/**
 * 解析 `git rev-list --left-right --count HEAD...@{u}` 输出（形如 `0\t1`）
 * @returns {{ahead: number, behind: number}}
 */
export function parseAheadBehind(stdout) {
  const m = /(\d+)\s+(\d+)/.exec(String(stdout ?? ""))
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : { ahead: 0, behind: 0 }
}

/**
 * 判定 `git fetch` 结果
 * @returns {{status: "ok"|"error", message: string}}
 */
export function parseFetchResult({ stdout = "", stderr = "", error } = {}) {
  if (error) return { status: "error", message: error.message ?? String(error) }
  const out = `${stdout ?? ""}\n${stderr ?? ""}`
  if (/unable to access|无法访问|could not read|Authentication failed|鉴权失败/i.test(out))
    return { status: "error", message: out.trim().split("\n")[0] }
  return { status: "ok", message: "" }
}

/**
 * 解析 `git merge --ff-only` / `git reset --hard` 的结果
 * @returns {{status: "uptodate"|"updated"|"blocked"|"error", message: string}}
 */
export function parseUpdateResult({ stdout = "", stderr = "", error } = {}) {
  const out = `${stdout ?? ""}\n${stderr ?? ""}\n${error?.message ?? ""}`
  if (!error) {
    if (/Already up[ -]to[ -]date|已经是最新/i.test(out)) return { status: "uptodate", message: "" }
    return { status: "updated", message: "" }
  }
  /** 工作区改动与远端重叠 / 本地有分叉：属于"需要强制"的可预期情况 */
  if (/would be overwritten|被合并操作覆盖|not possible to fast-forward|divergent|本地修改/i.test(out))
    return { status: "blocked", message: error.message ?? String(error) }
  return { status: "error", message: error.message ?? String(error) }
}

/** 组装给人看的更新结果文案（拿不到的信息一律省略，不显示"未知"占位） */
export function formatUpdateReply({ status, before, after, repo, error }) {
  const name = repo || "插件"
  if (status === "uptodate")
    return before?.hash ? `${name} 已是最新（${before.hash}）` : `${name} 已是最新`
  if (status === "conflict")
    return [
      `${name} 有本地改动，无法直接更新`,
      `受影响：本地修改的文件与远程提交重叠`,
      `处置：让维护者在服务器上手动处理，或用 git 强制更新（会丢弃本地改动）`,
    ].join("\n")
  if (status === "error") return `${name} 更新失败：${error ?? "未知错误"}`

  const lines = [`${name} 更新成功`]
  if (before?.subject || after?.subject) lines.push(`变更：${before?.subject || "?"} → ${after?.subject || "?"}`)
  if (before?.hash && after?.hash) lines.push(`提交：${before.hash} → ${after.hash}`)
  return lines.join("\n")
}
