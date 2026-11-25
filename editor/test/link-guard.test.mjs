/**
 * 填表口令的防枚举：按来源 IP 限流、连续失败冷却；成功兑换不计数、不作废
 *
 * 为什么要有：6 位数字口令只有 100 万种，`/api/link-code` 又是公开端点；不设防的话
 * 外部可以把 100 万种试一遍，撞上一条就拿到某个真实群成员的完整身份链接。
 *
 * 分两层：
 *   - **模块层**（`editor/http/link-guard.js`）：`clientIpOf` 取 `x-forwarded-for` 的**最后一段**
 *     （第一段是客户端自己写的，取它等于让枚举者一个请求换一个 IP）、限流窗口、冷却时长；
 *     成功只清失败计数，不留"谁兑换过"这类状态。
 *   - **真编辑器**：公开端点 `/api/link-code` 的 429（带 `retry-after`）、同一口令 5 分钟内可被
 *     多人反复兑换（每次都 200）、失败**不**消耗口令、不同来源 IP 各自计数、
 *     无效/过期都是同一句 410。
 *
 * 用法：node editor/test/link-guard.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { shared } from "./plugin.mjs"
import { SOURCE as SRC } from "./source.mjs"
import { startEditor, wait } from "./harness.mjs"

const { clientIpOf, createLinkGuard, LINK_FAIL_LIMIT, LINK_FAIL_WINDOW_MS, LINK_COOLDOWN_MS } =
  await shared("editor/http/link-guard.js")

const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-link-guard-"))
const TOKEN = "link-guard-token"
const SIGN_KEY = "link-guard-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }
const MEMBER = { qq: "5001", nick: "群里的人" }

const admins = path.join(wsDir, "admins.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

let failed = 0
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
  check("来源 IP：x-forwarded-for 取最后一段（第一段是客户端自己写的，不能信）", () => {
    const req = { headers: { "x-forwarded-for": "1.1.1.1, 8.8.8.8, 203.0.113.9" }, socket: { remoteAddress: "10.0.0.1" } }
    if (clientIpOf(req) !== "203.0.113.9") throw new Error(`取到的是 ${clientIpOf(req)}`)
  })

  check("来源 IP：没有 x-forwarded-for 时退回 socket 地址", () => {
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } }
    if (clientIpOf(req) !== "127.0.0.1") throw new Error(`取到的是 ${clientIpOf(req)}`)
  })

  check("限流：失败到阈值前进冷却，冷却期内 allow 为假", () => {
    let t = 1_000_000
    const guard = createLinkGuard({ now: () => t })
    const ip = "198.51.100.1"
    for (let i = 0; i < LINK_FAIL_LIMIT - 1; i++) guard.fail(ip)
    if (!guard.allow(ip)) throw new Error(`失败 ${LINK_FAIL_LIMIT - 1} 次就进冷却了`)
    guard.fail(ip)
    if (guard.allow(ip)) throw new Error(`失败 ${LINK_FAIL_LIMIT} 次还没进冷却`)
    if (guard.retryAfterMs(ip) !== LINK_COOLDOWN_MS) throw new Error(`retryAfterMs=${guard.retryAfterMs(ip)}`)
  })

  check("限流：冷却结束后重新放行", () => {
    let t = 2_000_000
    const guard = createLinkGuard({ now: () => t })
    const ip = "198.51.100.2"
    for (let i = 0; i < LINK_FAIL_LIMIT; i++) guard.fail(ip)
    if (guard.allow(ip)) throw new Error("刚进冷却就放行了")
    t += LINK_COOLDOWN_MS
    if (!guard.allow(ip)) throw new Error("冷却结束了还不放行")
  })

  check("限流：计数按来源 IP 分开（一个 IP 被冷却不影响另一个）", () => {
    let t = 3_000_000
    const guard = createLinkGuard({ now: () => t })
    for (let i = 0; i < LINK_FAIL_LIMIT; i++) guard.fail("203.0.113.1")
    if (guard.allow("203.0.113.1")) throw new Error("被打的 IP 还在放行")
    if (!guard.allow("203.0.113.2")) throw new Error("另一个 IP 被连坐了")
  })

  check("限流：成功一次清掉失败计数（不会被历史失败拖进冷却）", () => {
    let t = 4_000_000
    const guard = createLinkGuard({ now: () => t })
    const ip = "198.51.100.3"
    for (let i = 0; i < LINK_FAIL_LIMIT - 1; i++) guard.fail(ip)
    guard.succeed(ip)
    for (let i = 0; i < LINK_FAIL_LIMIT - 1; i++) guard.fail(ip)
    if (!guard.allow(ip)) throw new Error("成功之后失败计数没清掉，被拖进冷却了")
  })

  check("限流：窗口外的旧失败不计入", () => {
    let t = 5_000_000
    const guard = createLinkGuard({ now: () => t })
    const ip = "198.51.100.4"
    /** 窗口外先攒 1 次失败，过一整个窗口后再攒 LINK_FAIL_LIMIT-1 次：总数够但窗口内不够 */
    guard.fail(ip)
    t += LINK_FAIL_WINDOW_MS + 1000
    for (let i = 0; i < LINK_FAIL_LIMIT - 1; i++) guard.fail(ip)
    if (!guard.allow(ip)) throw new Error("窗口外的旧失败也被算进阈值了")
  })

  /**
   * 成功不记账：链接发给整个群，同一条口令 5 分钟内会被多人反复点，守卫里不能有"已用过"。
   * 这里同时钉住"接口面"——`taken` / `consume` 这两条不该再回来。
   */
  check("不作废：成功只清失败计数，守卫里没有「已兑换」状态", () => {
    const guard = createLinkGuard({ now: () => 6_000_000 })
    const ip = "198.51.100.5"
    for (let i = 0; i < 5; i++) guard.succeed(ip)
    if (!guard.allow(ip)) throw new Error("成功之后反而被挡住了")
    if ("taken" in guard || "consume" in guard) throw new Error("守卫还在记「已用过」：同一条口令第二个人点会被 410")
  })
}

/* ------------------------------ 真编辑器 ------------------------------ */

const runEditor = async () => {
  const file = path.join(wsDir, "queue.xlsx")
  fs.copyFileSync(SRC, file)
  const cfg = path.join(wsDir, "config.yaml")
  fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")
  const ed = await startEditor({
    label: "link-guard",
    token: TOKEN,
    signKey: SIGN_KEY,
    adminsFile: admins,
    args: ["--file", file, "--roster-qq", "0"],
    env: { ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1" },
  })
  const linksFile = path.join(wsDir, "abyss-editor-links.json")
  const writeLinks = obj => fs.writeFileSync(linksFile, JSON.stringify(obj), "utf8")
  const codeLink = `http://127.0.0.1:${ed.port}/queue/?k=${encodeURIComponent(TOKEN)}`
  const as = (ip, code) => fetch(`${ed.base}/api/link-code?code=${code}`, { headers: { "x-forwarded-for": ip } })
  const fresh = (code, link = codeLink, at = Date.now()) =>
    writeLinks({ [MEMBER.qq]: { v: "EEEEEEEE", at, code, link } })
  try {
    /** 公开端点：不带任何口令也能问（这是设计，不是漏配） */
    fresh("123456")
    const okRes = await as("203.0.113.10", "123456")
    const okJson = await okRes.json()
    check("端点：口令换回完整链接（200）", () => okRes.status === 200 && okJson.ok === true && okJson.url === codeLink)

    /**
     * 维护者 2026-11-26：链接面向所有群成员，**不得**限制点击次数、也不允许"第二次点失效"。
     * 同一条口令在 5 分钟内由不同人（不同 IP）、同一个人反复点，都必须换回同一条链接。
     */
    const repA = await as("203.0.113.21", "123456")
    const repB = await as("203.0.113.22", "123456")
    const repC = await as("203.0.113.21", "123456")
    check("端点：同一条口令 5 分钟内可被多人反复兑换（每次都 200、链接相同）", async () => {
      const bodies = await Promise.all([repA.json(), repB.json(), repC.json()])
      if ([repA.status, repB.status, repC.status].some(s => s !== 200))
        throw new Error(`status=${repA.status},${repB.status},${repC.status}`)
      if (bodies.some(o => o.url !== codeLink)) throw new Error("换回来的链接不一致")
    })

    /** 失败不消耗：瞎猜一次之后，真口令照样能换 */
    fresh("222222")
    const miss = await as("203.0.113.12", "999999")
    const after = await as("203.0.113.12", "222222")
    check("端点：猜错不消耗真口令（失败后再兑真口令仍是 200）", () => miss.status === 410 && after.status === 200)

    /** 过期仍是 410，且和"没登记过"同一句 */
    fresh("333333", codeLink, Date.now() - 6 * 60 * 1000)
    const expired = await as("203.0.113.13", "333333")
    const expiredJson = await expired.json()
    const unknownJson = await (await as("203.0.113.13", "888888")).json()
    check(
      "端点：过期与没登记过回同一句 410（不给枚举者区分「差一点」）",
      () => expired.status === 410 && expiredJson.error === unknownJson.error,
      `${expiredJson.error} / ${unknownJson.error}`,
    )

    /** 按来源 IP 限流：同一 IP 连着猜错到阈值 ⇒ 429 + retry-after；另一个 IP 不受影响 */
    const badIp = "198.51.100.77"
    for (let i = 0; i < LINK_FAIL_LIMIT; i++) await as(badIp, "000000")
    const limited = await as(badIp, "000001")
    const retry = Number(limited.headers.get("retry-after") ?? 0)
    check(
      `端点：同一来源 IP 失败 ${LINK_FAIL_LIMIT} 次后 429，并给 retry-after`,
      () => limited.status === 429 && retry > 0 && retry <= LINK_COOLDOWN_MS / 1000,
      `status=${limited.status} retry=${retry}`,
    )
    fresh("444444")
    const otherIp = await as("198.51.100.78", "444444")
    check("端点：一个 IP 被冷却不连坐另一个 IP", () => otherIp.status === 200)

    /** 冷却期内把对的口令也挡住（否则枚举者可以用"对的口令"绕过限流探测） */
    const duringCooldown = await as(badIp, "555555")
    check("端点：冷却期内连正确口令也一律 429", () => duringCooldown.status === 429)
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

console.log(failed ? `\n❌ 链接口令防枚举 验证失败 ${failed} 项` : "\n✅ 链接口令防枚举 验证通过")
process.exitCode = failed ? 1 : 0
