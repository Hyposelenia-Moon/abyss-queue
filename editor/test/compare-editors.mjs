/**
 * 在线 / 本地编辑器一致性自检
 *
 * 两边跑的是同一份 editor.mjs，功能差异只可能来自「代码没同步」或「配置不同」。
 * 这个脚本把两边的 /healthz 拉下来逐项比对：版本、功能清单、字段、别名数、口令/白名单开关等。
 *
 * 用法（在本项目根目录执行）：
 *   node editor/test/compare-editors.mjs --local http://127.0.0.1:7788 --online https://<线上编辑器地址>
 *   ABYSS_EDITOR_TOKEN=xxx node editor/test/compare-editors.mjs --online https://<线上编辑器地址>   # 线上要口令时带上
 *
 * `--online` **必填**：这里不内置任何真实地址（脚本是给人手跑的，地址由调用者给）。
 * 也可以用环境变量 `ABYSS_LOCAL_EDITOR` / `ABYSS_ONLINE_EDITOR` / `ABYSS_EDITOR_TOKEN`。
 *
 * 退出码：0 = 一致；1 = 有差异（会列出具体项）；2 = 用法不对（没给 --online）
 */
const args = process.argv.slice(2)
const flag = (name, fallback = "") => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const LOCAL = flag("--local", process.env.ABYSS_LOCAL_EDITOR ?? "http://127.0.0.1:7788")
const ONLINE = flag("--online", process.env.ABYSS_ONLINE_EDITOR ?? "")
const TOKEN = flag("--token", process.env.ABYSS_EDITOR_TOKEN ?? "")

if (!ONLINE) {
  console.error("用法：node editor/test/compare-editors.mjs --online <线上编辑器地址> [--local <本地地址>] [--token <口令>]")
  console.error("  也可以设环境变量 ABYSS_ONLINE_EDITOR / ABYSS_LOCAL_EDITOR / ABYSS_EDITOR_TOKEN")
  process.exit(2)
}

const withToken = url => {
  const base = url.replace(/\/+$/, "")
  return `${base}/healthz${TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : ""}`
}

const probe = async label => {
  const url = withToken(label === "本地" ? LOCAL : ONLINE)
  try {
    const res = await fetch(url, { redirect: "follow" })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    if (!json?.ok) {
      const looksLikeSite = /<html|<!doctype/i.test(text)
      return {
        label,
        url,
        ok: false,
        status: res.status,
        reason: looksLikeSite
          ? "返回的是网页而不是编辑器接口（多半是没挂载 / 被站点兜底规则吃了）"
          : `HTTP ${res.status}：${text.slice(0, 120)}`,
      }
    }
    return { label, url, ok: true, status: res.status, json }
  } catch (err) {
    return { label, url, ok: false, status: 0, reason: `连不上：${err.message}` }
  }
}

const [local, online] = await Promise.all([probe("本地"), probe("线上")])

for (const p of [local, online]) {
  console.log(`\n【${p.label}】${p.url}`)
  console.log(p.ok ? `  HTTP ${p.status} 版本=${p.json.version ?? "?"} 字段=${(p.json.fields ?? []).join("/")}` : `  ❌ ${p.reason}`)
}
if (!local.ok || !online.ok) {
  console.log("\n⚠ 两边没都在跑，无法逐项比对。")
  if (!online.ok) console.log("  线上：按 editor/DEPLOY.md 部署后再跑本脚本；本地那份用 node editor/editor.mjs … 起（见 editor/README.md）。")
  process.exit(1)
}

const KEYS = ["version", "fields", "features", "auth", "admin_api", "aliases", "mount"]
const diffs = []
for (const key of KEYS) {
  const a = JSON.stringify(local.json[key] ?? null)
  const b = JSON.stringify(online.json[key] ?? null)
  if (a !== b) diffs.push({ key, local: a, online: b })
}

console.log("\n" + "═".repeat(50))
if (!diffs.length) {
  console.log("✅ 两边功能一致（版本 / 字段 / 功能清单 / 开关 / 别名数 全对得上）")
  console.log(`   版本 ${local.json.version}，${(local.json.features ?? []).length} 项功能`)
  process.exit(0)
}
console.error("❌ 两边不一致：")
for (const d of diffs) console.error(`  - ${d.key}\n      本地：${d.local}\n      线上：${d.online}`)
console.error("\n处理：到源码仓库 push → 服务器上走更新指令（或按 editor/DEPLOY.md 重新部署）→ 重启机器人")
process.exit(1)
