/**
 * 插件自我更新（`#排队更新` / `#排队强制更新`）
 *
 * 这套跑的是 `components/update.js` 的**纯逻辑**：`exec` 与 `restart` 全用桩注入，
 * **不碰真仓库、不真重启**。重点是几条容易写错的判定：
 *   - 「有没有新代码」必须看**提交号变化**，不能看 `git pull` 的输出
 *     （强制更新先 `reset --hard`，随后 pull 必然报 `Already up to date`）；
 *   - 强制与普通的命令序列不同，且强制**会丢弃未提交改动**；
 *   - 没有新代码时**不该重启**（否则每次敲一下都重启一次服务）；
 *   - 不是 git 工作区时要**说清楚原因**，而不是报成网络错误。
 *
 * 用法：node test/update.test.mjs
 */
import assert from "node:assert/strict"
import { createChecker } from "./_helper.mjs"
import { runGit, readRepo, runUpdate, updateReply } from "../components/update.js"

const { check, finish } = createChecker("自我更新")

const CWD = "D:/fake/plugins/abyss-queue"

/**
 * 造一个假的 `exec`：按命令返回预设 stdout，并记录调用序列
 *
 * @param {object} script 命令 → 返回值；用 `{error}` 表示该命令失败
 * @param {(cmd:string)=>boolean} [failOn] 命中即返回失败
 */
const fakeExec = script => {
  const calls = []
  const exec = async (cmd, opts = {}) => {
    calls.push({ cmd, cwd: opts.cwd, quiet: opts.quiet })
    for (const [key, val] of Object.entries(script)) {
      if (cmd === key || cmd.startsWith(key)) return typeof val === "function" ? val() : val
    }
    return { stdout: "", stderr: "" }
  }
  return { exec, calls }
}

/** 一套「是 git 仓库」的基础返回：探测通过 + 分支/提交可取 */
const baseScript = (extra = {}) => ({
  "git rev-parse --is-inside-work-tree": { stdout: "true" },
  "git branch --show-current": { stdout: "main" },
  "git rev-parse --short HEAD": { stdout: "aaaaaaa" },
  'git log -1 --pretty=%cd --date=format:"%F %T"': { stdout: "2026-10-05 01:07:15" },
  ...extra,
})

console.log("【1】runGit：区分「命令失败」与「git / 仓库不可用」")
{
  const ok = await runGit(async () => ({ stdout: "  hi  " }), CWD, "status")
  check("成功：trim 掉输出、ok=true、missing=false", () => {
    assert.equal(ok.ok, true)
    assert.equal(ok.stdout, "hi")
    assert.equal(ok.missing, false)
  })

  const notRepo = await runGit(async () => ({ error: new Error("fatal: not a git repository (or any of the parent directories)") }), CWD, "status")
  check("不是 git 仓库：ok=false 且 missing=true", () => {
    assert.equal(notRepo.ok, false)
    assert.equal(notRepo.missing, true, notRepo.stderr)
  })

  const netErr = await runGit(async () => ({ error: new Error("fatal: unable to access 'https://…': Could not resolve host"), stderr: "" }), CWD, "pull")
  check("网络错误不算 missing（要报成更新失败，而不是环境不对）", () => {
    assert.equal(netErr.ok, false)
    assert.equal(netErr.missing, false)
  })
}

console.log("\n【2】readRepo：分支 / 提交 / 时间")
{
  const { exec } = fakeExec(baseScript())
  const repo = await readRepo(exec, CWD)
  check("三样都取到", () => {
    assert.equal(repo.branch, "main")
    assert.equal(repo.commit, "aaaaaaa")
    assert.equal(repo.time, "2026-10-05 01:07:15")
  })
}

console.log("\n【3】普通更新：提交号变了 → 算成功并重启")
{
  let head = "aaaaaaa"
  const { exec, calls } = fakeExec({
    "git rev-parse --is-inside-work-tree": { stdout: "true" },
    "git branch --show-current": { stdout: "main" },
    "git rev-parse --short HEAD": () => ({ stdout: head }),
    'git log -1 --pretty=%cd --date=format:"%F %T"': { stdout: "2026-10-05 02:00:00" },
    "git pull": () => {
      head = "bbbbbbb"
      return { stdout: "Updating aaaaaaa..bbbbbbb\nFast-forward" }
    },
  })
  let restarted = 0
  const result = await runUpdate({ exec, cwd: CWD, restart: async () => void restarted++ })
  check("ok / changed / restarted 都为真", () => {
    assert.equal(result.ok, true)
    assert.equal(result.changed, true)
    assert.equal(result.restarted, true)
    assert.equal(restarted, 1)
  })
  check("跑的就是 `git pull`（不带 reset）", () => {
    const gits = calls.map(c => c.cmd)
    assert.ok(gits.includes("git pull"), gits.join(" | "))
    assert.ok(!gits.some(c => c.includes("reset --hard")), "普通更新不该 reset")
  })
  check("回报里带上了前后提交号", () => {
    const text = updateReply(result)
    assert.match(text, /aaaaaaa → bbbbbbb/)
    assert.match(text, /已触发重启/)
  })
}

console.log("\n【4】已是最新：提交号没变 → 不重启")
{
  const { exec } = fakeExec(baseScript({ "git pull": { stdout: "Already up to date." } }))
  let restarted = 0
  const result = await runUpdate({ exec, cwd: CWD, restart: async () => void restarted++ })
  check("changed=false 且**没有**重启", () => {
    assert.equal(result.changed, false)
    assert.equal(result.restarted, false)
    assert.equal(restarted, 0, "没有新代码却重启了服务")
  })
  check("回报说「已是最新」并给出当前提交", () => {
    const text = updateReply(result)
    assert.match(text, /已是最新/)
    assert.match(text, /aaaaaaa/)
  })
}

console.log("\n【5】强制更新：先 reset 再 pull；且**按提交号判有没有变**")
{
  let head = "aaaaaaa"
  const { exec, calls } = fakeExec({
    "git rev-parse --is-inside-work-tree": { stdout: "true" },
    "git branch --show-current": { stdout: "main" },
    "git rev-parse --short HEAD": () => ({ stdout: head }),
    'git log -1 --pretty=%cd --date=format:"%F %T"': { stdout: "2026-10-05 03:00:00" },
    "git reset --hard origin/main": () => {
      head = "ccccccc"
      return { stdout: "HEAD is now at ccccccc 某个提交" }
    },
    "git pull --rebase": { stdout: "Already up to date." },
  })
  let restarted = 0
  const result = await runUpdate({ exec, cwd: CWD, force: true, restart: async () => void restarted++ })
  check("命令序列是 reset → pull --rebase", () => {
    const gits = calls.map(c => c.cmd).filter(c => c.startsWith("git ") || c === "git pull --rebase")
    const i = gits.indexOf("git reset --hard origin/main")
    const j = gits.indexOf("git pull --rebase")
    assert.ok(i >= 0 && j > i, gits.join(" | "))
  })
  /**
   * 这条是整套的关键：`reset --hard` 之后再 pull 必然报 `Already up to date`，
   * 若按 pull 的输出判定就会误判成"没更新"，于是**更新了却不重启**。
   */
  check("pull 报 Already up to date 但提交号变了 → 仍算更新成功", () => {
    assert.equal(result.ok, true)
    assert.equal(result.changed, true, "被 pull 的输出骗了")
    assert.equal(restarted, 1)
  })
  check("回报里写明是强制更新", () => {
    assert.match(updateReply(result), /强制更新成功/)
  })
}

console.log("\n【6】失败路径：报错不吞、不重启、原因可读")
{
  const { exec } = fakeExec(baseScript({ "git pull": { error: new Error("fatal: unable to access 'https://…': Could not resolve host") } }))
  let restarted = 0
  const result = await runUpdate({ exec, cwd: CWD, restart: async () => void restarted++ })
  check("ok=false、changed=false、没重启", () => {
    assert.equal(result.ok, false)
    assert.equal(result.changed, false)
    assert.equal(restarted, 0)
  })
  check("原因写进 reason 与回报", () => {
    assert.match(result.reason, /Could not resolve host/)
    assert.match(updateReply(result), /更新未完成/)
  })
}

console.log("\n【7】不是 git 工作区：说清是环境问题，不报成网络问题")
{
  const { exec } = fakeExec({ "git rev-parse --is-inside-work-tree": { error: new Error("fatal: not a git repository") } })
  const result = await runUpdate({ exec, cwd: CWD })
  check("ok=false 且 reason 指出「不是 git 工作区」", () => {
    assert.equal(result.ok, false)
    assert.match(result.reason, /不是 git 工作区/)
  })
  check("回报给出可用写法（框架更新用目录名 / 手动 pull）", () => {
    const text = updateReply(result)
    assert.match(text, /#更新 abyss-queue/)
    assert.match(text, /git pull/)
  })
}

console.log("\n【8】restart 缺省时：更新成功也不假装重启过")
{
  let head = "aaaaaaa"
  const { exec } = fakeExec({
    "git rev-parse --is-inside-work-tree": { stdout: "true" },
    "git branch --show-current": { stdout: "main" },
    "git rev-parse --short HEAD": () => ({ stdout: head }),
    'git log -1 --pretty=%cd --date=format:"%F %T"': { stdout: "2026-10-05 04:00:00" },
    "git pull": () => {
      head = "ddddddd"
      return { stdout: "Fast-forward" }
    },
  })
  const result = await runUpdate({ exec, cwd: CWD })
  check("changed=true 但 restarted=false（没注入 restart 就不谎报）", () => {
    assert.equal(result.changed, true)
    assert.equal(result.restarted, false)
  })
  check("回报提示需要手动重启", () => assert.match(updateReply(result), /未重启/))
}

console.log("\n【9】命令口径：普通更新不动工作区")
{
  const { exec, calls } = fakeExec(baseScript({ "git pull": { stdout: "Already up to date." } }))
  await runUpdate({ exec, cwd: CWD })
  check("普通路径一条 reset / checkout 都没有（本地改动由 git 自己拒绝）", () => {
    const bad = calls.map(c => c.cmd).filter(c => /reset --hard|checkout|clean -/.test(c))
    assert.deepEqual(bad, [], bad.join(" | "))
  })
  check("每条命令都带上了 cwd 且 quiet（不刷屏）", () => {
    for (const c of calls) {
      assert.equal(c.cwd, CWD, `${c.cmd} 没带 cwd`)
      assert.equal(c.quiet, true, `${c.cmd} 没设 quiet`)
    }
  })
}

await finish()
