/**
 * 固定入口页 + 6 位填表口令：群消息只发口令，编辑器拿口令换回完整链接
 *
 * 群里那条排队输出末尾是 `点此填表：<public_url>/#code=123456`（`apps/queue.js` 的 `prepareEntry`），
 * 不是完整长链接——完整链接里有 `u/s`（30 天身份签名）与 `w/ws`（5 分钟窗口），落在群里等于把
 * 别人的身份发出去。于是分两步：
 *   1. 机器人每次 `#排队` 生成一个 6 位数字口令，把「口令 → 完整链接」记进登记簿
 *      （`model/editor-links.js`，`data/abyss-editor-links.json`，5 分钟作废）；
 *   2. 人点链接 → 固定入口页 → `#code=123456` 自动填进输入框 → 页面问 `/api/link-code` 换回完整链接
 *      → `location.replace` 进编辑器。
 *
 * 分两层：
 *   - **模块层**：`issueLink` / `recordLinkTarget` / `readLinkTarget`（登记簿）、`fillEntry`（长链接带
 *     `w/ws`、**不带** `#v=`——链接新旧那一层 2026-11-25 已整体删除）；
 *   - **真编辑器**：固定入口页的五个形状、`/api/link-code` 的换取与 410、主页面 boot 兑换。
 *
 * 用法：node editor/test/link-code.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { shared } from "./plugin.mjs"
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（缺真实表时也有样本可跑） */
import { SOURCE as SRC } from "./source.mjs"
import { startEditor, wait } from "./harness.mjs"

const { decodeIdentity } = await shared("model/identity.js")
const { fillEntry } = await shared("components/fill-entry.js")
const { config } = await shared("components/config.js")

const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-link-code-"))
const TOKEN = "link-code-token"
const SIGN_KEY = "link-code-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }
const MEMBER = { qq: "5001", nick: "群里的人" }

const admins = path.join(wsDir, "admins.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

let failed = 0
/**
 * 断言：`ok` 收**布尔**或**回调 / async 回调**（抛错或返回 `false` 都算失败）
 *
 * 回调那种写法必须真的执行（AGENTS.md §3.7：写成 `if (ok)` 的话回调永远是"真值"，
 * 断言一条都没跑还印 ✅）。
 */
const check = (name, ok, detail = "") => {
  const pass = () => console.log(`  ✅ ${name}`)
  const fail = why => {
    failed++
    console.log(`  ❌ ${name}${detail || why ? `\n     ${detail || why}` : ""}`)
  }
  if (typeof ok !== "function") return ok ? pass() : fail("")
  let out
  try {
    out = ok()
  } catch (err) {
    return fail(err?.message ?? String(err))
  }
  if (out && typeof out.then === "function") {
    return out.then(
      value => (value === false ? fail("回调返回 false") : pass()),
      err => fail(err?.message ?? String(err)),
    )
  }
  if (out === false) return fail("回调返回 false")
  return pass()
}

/* ------------------------------ 模块层 ------------------------------ */

const moduleLayer = async () => {
  const now = Date.now()
  const { issueLink, recordLinkTarget, readLinkTarget, LINK_CODE_TTL_MS } = await shared("model/editor-links.js")

  check("登记簿：两次签发的口令不同、都是 6 位数字", () => {
    const a = issueLink(MEMBER.qq, now)
    const b = issueLink(MEMBER.qq, now + 1000)
    if (!/^\d{6}$/.test(a.code)) throw new Error(`填表口令不是 6 位数字：${JSON.stringify(a)}`)
    if (!/^\d{6}$/.test(b.code)) throw new Error(`填表口令不是 6 位数字：${JSON.stringify(b)}`)
    if (a.code === b.code) throw new Error("两次签发的口令一样（同一窗口内撞了）")
    if (!a.v || a.v.length !== 8) throw new Error(`标记长度不对：${JSON.stringify(a)}`)
  })

  check("登记簿：口令换回完整链接（刚登记就能查）", () => {
    const issued = issueLink(MEMBER.qq, now)
    const url = `https://example.com/queue/?k=t&u=u&s=s&w=1&ws=w`
    if (!recordLinkTarget(MEMBER.qq, issued.v, url)) throw new Error("登记失败")
    if (readLinkTarget(issued.code, { now }) !== url) throw new Error(`换回来的是 ${readLinkTarget(issued.code, { now })}`)
  })

  check(`登记簿：超过 ${LINK_CODE_TTL_MS / 60000} 分钟的口令查不到（410 的来源）`, () => {
    const issued = issueLink(MEMBER.qq, now)
    recordLinkTarget(MEMBER.qq, issued.v, "https://example.com/queue/?k=t")
    const late = now + LINK_CODE_TTL_MS + 1000
    if (readLinkTarget(issued.code, { now: late }) !== null) throw new Error("过期口令仍然换回了链接")
  })

  /**
   * 并发保护：`v` 现在只干这一件事——**旧的那次登记写不进新记录**。
   *
   * 场景：同一秒里连着两次 `#排队`，第一次的 `recordLinkTarget` 晚到，不能把第二次的链接盖掉。
   */
  check("登记簿：过时的标记写不进新的那条（并发保护）", () => {
    const first = issueLink(MEMBER.qq, now)
    const second = issueLink(MEMBER.qq, now + 1000)
    const fresh = "https://example.com/queue/?k=t&u=second"
    const older = "https://example.com/queue/?k=t&u=first"
    if (!recordLinkTarget(MEMBER.qq, second.v, fresh)) throw new Error("新的那次登记失败")
    if (recordLinkTarget(MEMBER.qq, first.v, older)) throw new Error("过时的标记也写进去了")
    if (readLinkTarget(second.code, { now }) !== fresh) throw new Error("新的那条被过时的写盖掉了")
  })

  /** 填报入口：普通长链接带 `w/ws`，**不带** `#v=`（链接新旧那一层删掉了） */
  const oldEditor = config.editor
  config.editor = { public_url: "https://example.com/queue", token: "tok", sign_key: SIGN_KEY }
  const ctx = { e: { user_id: MEMBER.qq }, nickname: () => MEMBER.nick }
  try {
    check("填报入口：普通长链接带时间窗、不带 `#v=`", () => {
      const entry = fillEntry(ctx, ["剧诗"], [], { now })
      if (entry.link.includes("#v=")) throw new Error(`不该再有链接标记：${entry.link}`)
      if (!entry.link.includes("w=") || !entry.link.includes("ws=")) throw new Error(`应当带时间窗：${entry.link}`)
      if (entry.link.includes("/s/")) throw new Error(`不该再走短链：${entry.link}`)
    })
    check("填报入口：管理员那一份形状相同（也带时间窗）", () => {
      const entry = fillEntry(ctx, ["剧诗"], [], { now, manager: true })
      if (entry.link.includes("#v=")) throw new Error(entry.link)
      if (!entry.link.includes("w=") || !entry.link.includes("ws=")) throw new Error(`应当走带窗口的长地址：${entry.link}`)
    })
    check("填报入口：名片回落成 QQ 号时，链接身份改用候选里的群昵称", () => {
      /** 现场：复制到浏览器后页面把 QQ 号当群昵称显示；链接本身就不该签 QQ。 */
      const qqCtx = {
        e: { user_id: MEMBER.qq },
        nickname: () => MEMBER.qq,
        nicknames: () => [MEMBER.qq, MEMBER.nick],
      }
      const entry = fillEntry(qqCtx, ["剧诗"], [], { now })
      const url = new URL(String(entry.link).replace(/^.*?：/, ""))
      const who = decodeIdentity(url.searchParams.get("u"))
      if (who?.nick !== MEMBER.nick) throw new Error(`签成了「${who?.nick}」：${entry.link}`)
    })
  } finally {
    config.editor = oldEditor
  }
}

/* ------------------------------ 真编辑器 ------------------------------ */

const runEditor = async () => {
  const file = path.join(wsDir, "queue.xlsx")
  fs.copyFileSync(SRC, file)
  const cfg = path.join(wsDir, "config.yaml")
  fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")
  const ed = await startEditor({
    label: "link-code",
    token: TOKEN,
    signKey: SIGN_KEY,
    adminsFile: admins,
    args: ["--file", file, "--roster-qq", "0"],
    env: { ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1" },
  })
  const linksFile = path.join(wsDir, "abyss-editor-links.json")
  const writeLinks = obj => fs.writeFileSync(linksFile, JSON.stringify(obj), "utf8")
  const codeLink = `http://127.0.0.1:${ed.port}/queue/?k=${encodeURIComponent(TOKEN)}`
  try {
    /**
     * 固定入口页：群里那条链接的 hash 是 `#code=123456`，服务端看不见 hash，
     * 只有页面自己读出来填进输入框、再拿它换完整链接。
     */
    const entryPage = await fetch(`${ed.base}/queue/`)
    const entryText = await entryPage.text()
    check("固定入口页：无口令也给 6 位数字填表口令输入页", () =>
      entryText.includes("6 位数字填表口令") && !entryText.includes("访问口令不对"),
    )
    check("固定入口页：链接末尾的 #code 会填入口令，缺失时保留手输", () =>
      entryText.includes("location.hash") && entryText.includes("input.value=seed") && entryText.includes('id="code"'),
    )
    check("固定入口页：不会拿本地访问口令自动跳进只读页", () => !entryText.includes("abyss-editor-token"))
    /**
     * 内联事件处理器（`onsubmit="…"`）不在 CSP 的 `script-src` 白名单里（只有 nonce），
     * 浏览器会直接拦掉——手输口令点「进入」于是提交请求为 0、页面停在原地。
     * 页面脚本自己是带 nonce 的，所以必须用 `addEventListener('submit', …)` 绑。
     */
    check("固定入口页：表单用 addEventListener 绑提交（内联 onsubmit 会被 CSP 拦）", () =>
      !/\bonsubmit\s*=/.test(entryText) && entryText.includes("addEventListener('submit'") && entryText.includes('id="codeForm"'),
    )

    writeLinks({ [MEMBER.qq]: { v: "EEEEEEEE", at: Date.now(), code: "123456", link: codeLink } })
    const resolved = await fetch(`${ed.base}/api/link-code?code=123456`)
    const out = await resolved.json()
    check("固定入口页：口令换回完整链接（与发出去的那条一字不差）", () =>
      resolved.status === 200 && out.ok === true && out.url === codeLink,
    )
    /**
     * 维护者 2026-11-26：链接面向所有群成员，**不得**限制点击次数、也不允许"第二次点失效"。
     * 同一条口令 5 分钟内被多人（含同一人反复点）兑换，每次都必须换回同一条链接。
     */
    const repeat1 = await fetch(`${ed.base}/api/link-code?code=123456`)
    const repeat2 = await fetch(`${ed.base}/api/link-code?code=123456`)
    check("固定入口页：同一条口令 5 分钟内可以反复兑换（不作废）", async () => {
      if (repeat1.status !== 200 || repeat2.status !== 200) throw new Error(`status=${repeat1.status},${repeat2.status}`)
      const first = await repeat1.json()
      const second = await repeat2.json()
      if (first.url !== codeLink || second.url !== codeLink) throw new Error("换回来的链接不一致")
    })
    writeLinks({ [MEMBER.qq]: { v: "EEEEEEEE", at: Date.now() - 6 * 60 * 1000, code: "123456", link: codeLink } })
    const expired = await fetch(`${ed.base}/api/link-code?code=123456`)
    check("固定入口页：超过 5 分钟的口令失效（410）", () => expired.status === 410)
    const missing = await fetch(`${ed.base}/api/link-code?code=999999`)
    check("固定入口页：没登记过的口令也是 410（不吐内部错误）", () => missing.status === 410)

    /**
     * 已有会话时点群内短链：服务端看不见 hash，只有主页面自己兑换。
     * 页面脚本必须带这段（`api/link-code` + `location.replace`），否则短码白点。
     */
    const mainPage = await fetch(`${ed.base}/queue/?k=${encodeURIComponent(TOKEN)}`)
    const mainText = await mainPage.text()
    check("主页面 boot 也兑换 #code（已有会话时短链不再是白点）", () =>
      mainPage.status === 200 && mainText.includes("api/link-code") && mainText.includes("location.replace") && mainText.includes("bootGate"),
    )
    check("主页面 boot 也在 hashchange 上兑换（同标签页内点短链不白点）", () =>
      mainText.includes("shortCodeOf") && mainText.includes("redeemShortCode"),
    )

    /**
     * 现场：复制到浏览器后，页面「群昵称」显示成 QQ 号。
     * 链接身份里的 `n` 是签发时写死的；服务端有群名单时必须以名单现用名为准。
     */
    const roster = path.join(wsDir, "roster.json")
    fs.writeFileSync(roster, JSON.stringify({ group: "999888", updatedAt: Date.now(), members: [{ qq: MEMBER.qq, nick: MEMBER.nick }] }), "utf8")
    const botQuery = new URLSearchParams({
      k: TOKEN,
      ...Object.fromEntries(
        new URLSearchParams(
          (await import("./_query.mjs")).signedQuery({ qq: "0", nick: "群成员名单", token: TOKEN, signKey: SIGN_KEY }),
        ),
      ),
    })
    const pushed = await fetch(`${ed.base}/api/roster?${botQuery}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: "999888", members: [{ qq: MEMBER.qq, nick: MEMBER.nick }] }),
    })
    check("前置：名单推上去了", async () => (await pushed.json()).ok === true)

    const { signIdentity } = await shared("model/identity.js")
    const signature = signIdentity({ qq: MEMBER.qq, nick: MEMBER.qq }, SIGN_KEY)
    const view = await fetch(`${ed.base}/api/data?k=${TOKEN}&u=${encodeURIComponent(signature.u)}&s=${encodeURIComponent(signature.s)}`)
    const viewJson = await view.json()
    check(
      "链接身份里是 QQ 号时，页面仍按群名单显示群昵称",
      viewJson?.perm?.nick === MEMBER.nick,
      JSON.stringify(viewJson?.perm),
    )
  } finally {
    await ed.stop()
    await wait(300)
  }
}

/* ------------------------------ 入口 ------------------------------ */

try {
  console.log("模块层：")
  await moduleLayer()
  console.log("真编辑器：")
  await runEditor()
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  fs.rmSync(wsDir, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 链接口令 验证失败 ${failed} 项` : "\n✅ 链接口令 验证通过")
process.exitCode = failed ? 1 : 0
