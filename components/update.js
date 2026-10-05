/**
 * 插件自我更新（在**本插件自己的指令空间**里做，不碰框架文件）
 *
 * 为什么自己实现：框架的 `#更新` 走 `plugins/other/update.js`，它按 `plugins/<名字>/.git` 找仓库、
 * 没有别名表，所以 `#更新 abyss` 这类写法解析不出插件；而它的规则 `^#(安?静)?(强制)?更新`
 * 又排在最前（`priority: -Infinity`），**任何以 `#更新` 开头的消息都会被它先吃掉**。
 * 所以本模块提供的是**不与之竞争的写法**：`#排队更新` / `#排队强制更新`。
 *
 * 两道闸：
 *   - `permission: "master"`：框架在进 handler 之前就挡掉非主人（见 apps/update.js）
 *   - `e.isMaster`：handler 里第二道，纯函数层再判一次，回归也能直接喂桩
 *
 * 更新成功后**调框架的 `Bot.restart()`** 重启——这是框架自己暴露的能力，
 * 用它不算改框架；插件侧的 `components/boot.js` 会在进程退出时写 `data/restart.flag`，
 * 启动器据此把本机编辑器一并拉起（见 editor/README.md）。
 *
 * 依赖全部注入（`exec` / `restart` / `cwd`），因此本模块**不 import 框架全局**、可离线回归。
 */

/** 强制更新时的基准分支（`git reset --hard <remote/branch>`） */
const DEFAULT_REMOTE = "origin/main"

/** 输出里出现这些字样说明「没拉到新提交」——与框架同一套判据 */
const UP_TO_DATE = /Already up|已经是最新|Already up to date/i

/**
 * 跑一条 git 命令
 *
 * @param {Function} exec `(cmd, opts) => Promise<{error?, stdout?, stderr?}>`，由调用方注入
 * @param {string} cwd 仓库目录
 * @param {string} cmd 命令（不带 `git` 前缀）
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, missing:boolean}>} missing = git 不可用/不是仓库
 */
export async function runGit(exec, cwd, cmd) {
  const ret = await exec(`git ${cmd}`, { cwd, quiet: true })
  const stdout = String(ret?.stdout ?? "").trim()
  const stderr = String(ret?.stderr ?? "").trim()
  const err = ret?.error
  const missing = Boolean(err) && /not a git repository|command not found|不是内部或外部命令|无法将/i.test(`${stdout}\n${stderr}\n${err?.message ?? ""}`)
  return { ok: !err, stdout, stderr, missing }
}

/**
 * 读一眼仓库现状（分支 / 当前提交 / 提交时间）；这些只用于回报，失败不算更新失败
 *
 * @returns {Promise<{branch:string, commit:string, time:string}>}
 */
export async function readRepo(exec, cwd) {
  const at = async cmd => (await runGit(exec, cwd, cmd)).stdout
  return {
    branch: await at("branch --show-current"),
    commit: await at("rev-parse --short HEAD"),
    time: await at('log -1 --pretty=%cd --date=format:"%F %T"'),
  }
}

/**
 * 执行一次更新
 *
 * @param {object} deps
 * @param {Function} deps.exec 跑命令（注入；见 runGit）
 * @param {Function} [deps.restart] 更新成功后重启进程（注入；默认不重启，由调用方决定）
 * @param {string} deps.cwd 仓库目录（通常是插件根）
 * @param {boolean} [deps.force] 强制更新：`git reset --hard <remote/branch>` 后再 pull
 * @param {string} [deps.remote] 强制更新的重置目标，默认 `origin/main`
 * @returns {Promise<{ok:boolean, changed:boolean, restarted:boolean, reason?:string, before:object, after:object, log:string}>}
 */
export async function runUpdate({ exec, restart = null, cwd, force = false, remote = DEFAULT_REMOTE }) {
  const before = await readRepo(exec, cwd)
  const miss = reason => ({ ok: false, changed: false, restarted: false, force, reason, before, after: before, log: "" })

  /** 不是 git 仓库（例如通过更新指令拉下来但没带 .git）：说清楚，别让人以为是网络问题 */
  const probe = await runGit(exec, cwd, "rev-parse --is-inside-work-tree")
  if (probe.missing || !/true/.test(probe.stdout))
    return {
      ...miss(`这里不是 git 工作区（${cwd}），拿不到更新：用框架的 #更新 abyss-queue，或手动 git pull`),
      log: probe.stderr || probe.stdout,
    }

  /**
   * 命令与框架同一套口径：
   *   - 普通：`git pull`（不动工作区，有本地改动就让 git 自己拒绝）
   *   - 强制：先 `reset --hard <remote/branch>` 再 `pull --rebase`
   *     —— 与框架的「强制更新」一致；**会丢弃未提交改动**，所以只在显式强制时走
   */
  const cmds = force
    ? [`git reset --hard ${remote}`, "git pull --rebase"]
    : ["git pull"]

  const outputs = []
  for (const cmd of cmds) {
    const ret = await exec(cmd, { cwd, quiet: true })
    outputs.push(`${cmd}\n${String(ret?.stdout ?? "").trim()}`.trim())
    if (ret?.error) {
      return {
        ok: false,
        changed: false,
        restarted: false,
        force,
        reason: ret.error.message ?? String(ret.error),
        before,
        after: before,
        log: outputs.join("\n\n"),
      }
    }
  }
  const log = outputs.join("\n\n")

  const after = await readRepo(exec, cwd)
  /**
   * 「有没有新代码」**看提交号变化，不看 pull 的输出**：
   * 强制更新先 reset 已把工作区对齐，随后 `git pull` 必然报 `Already up to date`，
   * 用输出判定会误判成"没更新"。这正是框架那条补丁踩过的坑，这里从一开始就按提交号判。
   */
  const changed = Boolean(before.commit && after.commit && before.commit !== after.commit)

  let restarted = false
  if (changed && typeof restart === "function") {
    await restart()
    restarted = true
  }
  return { ok: true, changed, restarted, force, before, after, log, upToDate: !changed && UP_TO_DATE.test(log) }
}

/** 把结果拼成给主人看的一条消息（纯函数，方便回归） */
export function updateReply(result) {
  const { ok, changed, restarted, reason, before, after, log, upToDate, force } = result
  const head = force ? "强制更新" : "更新"
  if (!ok) return `【三路深渊排队】${head}未完成：${reason}\n${log ? `\n${log.slice(-600)}` : ""}`.trim()

  const was = before?.commit || "（未知）"
  const now = after?.commit || "（未知）"
  if (!changed) {
    return [
      `【三路深渊排队】已是最新（${upToDate ? "git 报无新提交" : "提交号未变"}）`,
      `当前提交：${now}　分支：${after?.branch || "（未知）"}`,
      `最后更新：${after?.time || "（未知）"}`,
    ].join("\n")
  }
  return [
    `【三路深渊排队】${head}成功：${was} → ${now}`,
    `分支：${after?.branch || "（未知）"}　提交时间：${after?.time || "（未知）"}`,
    restarted ? "已触发重启；本机启动器会把编辑器一并拉起" : "**未重启**：请手动重启机器人（或由启动器接管）",
  ].join("\n")
}
