/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行（见 test/env.mjs 的说明） */
import { ensureEnv } from "./env.mjs"
/**
 * `#插队`：只有白名单管理员能用，动作只交给编辑器（插件一个字都不写表）
 *
 * 这条指令的价值全在**边界**上，所以用例围着边界写：
 *   - 非白名单管理员发 `#插队` ⇒ 直接拒绝，**一个请求都不发**；
 *   - 白名单管理员 ⇒ 发 `/api/move-row`，带口令与**调用者本人**的身份签名；
 *   - 目标前面没有「排队中」的行 ⇒ **不调接口**，回一句"已经在最前面"；
 *   - 没在排队的榜 / 不是「排队中」的榜 ⇒ 不发请求，回话里点明没动；
 *   - `#插队 <群昵称>` 指定别人（管理能力）与 `#插队 <榜>` 只处理一个榜；
 *   - 插件侧**不写表**：全程表格文件哈希不变。
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createChecker, installFrameworkStubs, requireSource } from "./_helper.mjs"
import { decodeIdentity } from "../model/identity.js"

const SOURCE = await requireSource()
const { check, finish } = createChecker("插队指令")

const ENV = await ensureEnv({ prefix: "abyss-queue-insert-" })
const fixture = ENV.fixture
await fs.copyFile(SOURCE, fixture)

const ADMIN = "424243"
const OUTSIDER = "430000"
await fs.writeFile(path.join(ENV.dir, "abyss-editor-admins.json"), JSON.stringify({ owner: [], admins: [ADMIN] }), "utf8")

const sent = installFrameworkStubs()
const { apps } = await import("../index.js")
const APPS = Object.values(apps).filter(c => typeof c === "function")
const { Table } = await import("../model/table.js")
const { firstEmptyRow } = await import("../modules/queue.js")

const SHEET = "幽境危战"
const OTHER = "幻想真境剧诗"
const QUEUED = "排队中"
const WAITING = "等待开启"
/** 榜里那一行的群昵称与发送者名片**必须一致**：插件按群名片定位本人，不一致就成了"表里没这个人" */
const ADMIN_NICK = "管理员甲"
const TARGET_NICK = "被指定的人"
const WAITING_NICK = "还没开的人乙"
const CALLER = { user_id: ADMIN, card: ADMIN_NICK }

const sha256 = buf => createHash("sha256").update(buf).digest("hex")

/** 复刻 loader 的取法：非 RegExp 的 reg 编译成正则，按 priority 找第一条命中的规则 */
const rulesOf = app => (app.rule ?? []).map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))
const say = async (msg, opts = {}) => {
  /** 发送者 = 管理员甲（`CALLER` 放在最后：用例想改谁就改 `opts`，默认就是这位） */
  const e = { msg, self_id: "10000", group_id: "20000", isGroup: true, sender: { card: ADMIN_NICK, nickname: ADMIN_NICK }, ...CALLER, ...opts }
  if (opts.card) e.sender = { ...e.sender, card: opts.card, nickname: opts.card }
  for (const C of APPS.map(C => Object.assign(new C(), { e, __replies: [] })).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
    const hit = rulesOf(C).find(r => r.reg.test(msg))
    if (!hit) continue
    await C[hit.fnc]()
    return { fnc: hit.fnc, replies: C.__replies }
  }
  return { fnc: null, replies: [] }
}
const msgText = m =>
  Array.isArray(m)
    ? m.map(p => (typeof p === "string" ? p : p?.type === "image" ? "[图片]" : String(p?.data?.content ?? p))).join("")
    : String(m)
const said = r => r.replies.map(msgText).join("\n")

const readModel = async sheet => new Table({ file: fixture, backup: false }).read(({ models }) => models.get(sheet))
const moves = () => ENV.cloud.state.moves ?? []

/**
 * **插件自己那一份绑定库**（不是套件另 import 一份）
 *
 * `AppBase.store()` 拿到的就是插件 handler 里用的那个实例——套件直接 `import("../model/store.js")`
 * 取 `getStore()` 在有的机器上会解析到**另一份模块实例**（那样改了就等于白改），
 * 走 app 的方法是唯一"和被测代码同一份"的取法。
 */
const liveStore = async () => new (APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "insert")))()["store"]()

let rowA = 0
let rowB = 0
let rowC = 0
{
  const model = await readModel(SHEET)
  const base = firstEmptyRow(model)
  if (!base) {
    console.log("⏭ 套件跳过：这份表在「幽境危战」里已经没有空行，摆不下用例数据")
    await ENV.cloud.close()
    process.exit(0)
  }
  ;[rowA, rowB, rowC] = [base, base + 1, base + 2]
  const table = new Table({ file: fixture, backup: false })
  await table.mutate(ctx => {
    /** rowA = 被别人插队的那位；rowB = 管理员自己；rowC = 「等待开启」，插不了 */
    for (const [row, nick, status] of [[rowA, TARGET_NICK, QUEUED], [rowB, ADMIN_NICK, QUEUED], [rowC, WAITING_NICK, WAITING]]) {
      ctx.setCell(SHEET, row, "nickname", nick)
      ctx.setCell(SHEET, row, "gameName", `${nick}的游戏名`)
      ctx.setCell(SHEET, row, "status", status)
    }
  })
  /** 绑定认人：管理员自己（rowB）与他要指定的那位（rowA） */
  const store = await liveStore()
  store.set(SHEET, ADMIN, { row: rowB, nickname: ADMIN_NICK })
  store.set(SHEET, "30001", { row: rowA, nickname: TARGET_NICK })
  await store.save()
}

const { config } = await import("../components/config.js")
console.log(`源表格：${SOURCE}\n测试副本：${fixture}\n${SHEET} 数据行：${rowA} / ${rowB} / ${rowC}\n`)

/**
 * 表格文件的快照（字节哈希）
 *
 * "插件有没有写表"的判据是**每一段自己摆完数据之后**与跑完 `#插队` 再对一次：
 * 摆数据是套件在用 `Table` 造现场，不是被测代码；插件一侧应当一个字都不写。
 */
const tableSnap = async () => sha256(await fs.readFile(fixture))
const hashAtStart = await tableSnap()

console.log("【1】鉴权：只有白名单管理员能插队")
{
  const before = moves().length
  const r = await say("#插队", { user_id: OUTSIDER, card: "路人" })
  check("非白名单管理员：拒绝，且一个请求都不发", () => {
    const text = said(r)
    assert.ok(text.includes("白名单"), text)
    assert.equal(moves().length, before, `不该发请求：${JSON.stringify(moves().slice(before))}`)
  })
  check("拒绝的回复里不出现榜名与行号（不泄露表内容）", () => {
    const text = said(r)
    assert.ok(!text.includes(SHEET), text)
    assert.ok(!text.includes(String(rowB)), text)
  })
  check("被拒的这一条一个字没写表", async () => assert.equal(await tableSnap(), hashAtStart))
}

/**
 * 【1b】主人（白名单文件 `owner` 里的 QQ）也能用
 *
 * 判据是 `isManagerQq()`（`model/whitelist.js`）= **owner ∪ admins**，所以主人不必再写进 `admins`——
 * 而这份套件原来只写了 `admins`，**主人这条路一直没有覆盖**（维护者问的正是"主人能不能用"）。
 * 另外要钉住一条容易误解的口径：这里认的是**白名单文件里的主人**，不是框架的 master
 * （`#插队` 特意不看 `permission` / `e.isMaster`）。
 */
console.log("\n【1b】主人（owner 名单里的 QQ）：同样能用")
{
  const OWNER = "424242"
  const wlFile = path.join(ENV.dir, "abyss-editor-admins.json")
  await fs.writeFile(wlFile, JSON.stringify({ owner: [OWNER], admins: [ADMIN] }), "utf8")
  try {
    const before = moves().length
    const r = await say("#插队 被指定的人", { user_id: OWNER, card: "主人" })
    check("主人发 #插队（点名别人）：不拒绝，且真发了 /api/move-row", () => {
      const text = said(r)
      assert.equal(r.fnc, "insert", JSON.stringify(r))
      assert.ok(!text.includes("白名单"), `主人被当成外人拒了：${text}`)
      assert.equal(moves().length, before + 1, `应当只发一条：${JSON.stringify(moves().slice(before))}`)
    })
    check("这条请求用的是**发起者本人**（主人）的身份签名", () => {
      const m = moves().at(-1)
      const id = decodeIdentity(m.u)
      assert.ok(id, `u 解不开：${m.u}`)
      assert.equal(String(id.qq), OWNER, JSON.stringify(id))
      assert.ok(m.s, "没有签名")
    })
    check("主人这一条也一个字没写表", async () => assert.equal(await tableSnap(), hashAtStart))
  } finally {
    /** 还原成"只有白名单管理员"：后面的用例按这个前提写 */
    await fs.writeFile(wlFile, JSON.stringify({ owner: [], admins: [ADMIN] }), "utf8")
  }
}

console.log("\n【2】白名单管理员：调编辑器、带本人身份签名")
{
  const before = moves().length
  const r = await say("#插队")
  check("白名单管理员这一条也一个字没写表", async () => assert.equal(await tableSnap(), hashAtStart))
  check("命中 insert，且确实发了 /api/move-row", () => {
    assert.equal(r.fnc, "insert", JSON.stringify(r))
    assert.equal(moves().length, before + 1, `应当只发一条：${JSON.stringify(moves().slice(before))}`)
  })
  check("请求体：榜名 + 行号 + 固定 mode，昵称是本人的", () => {
    const m = moves().at(-1)
    assert.equal(m.sheet, SHEET)
    assert.equal(Number(m.row), rowB)
    assert.equal(m.mode, "before-last-queued")
    assert.equal(m.nick, ADMIN_NICK)
  })
  check("带编辑器口令与调用者本人的身份签名（不是机器人身份）", () => {
    const m = moves().at(-1)
    assert.equal(m.k, config.remote.token)
    const id = decodeIdentity(m.u)
    assert.ok(id, `u 解不开：${m.u}`)
    assert.equal(id.qq, ADMIN)
    assert.equal(id.nick, ADMIN_NICK)
    assert.ok(m.s, "没有签名")
  })
  check("回话说清把谁挪到了第几位", () => {
    const text = said(r)
    assert.ok(text.includes(ADMIN_NICK), text)
    assert.ok(/第 \d+ 位/.test(text), text)
  })
}

console.log("\n【3】前面没有「排队中」的行：不调接口")
{
  /**
   * 管理员站到队列最前面一档（那里上方没有任何「排队中」的行）
   *
   * 用**他自己那一行**表达这件事：把 rowA 那一行改写成"管理员本人的位置"，再把他上方的
   * 「排队中」清掉；这样不动别人那一行，下面「指定某位成员」那条用例的前提也就还成立。
   *
   * 注意插件与套件是**同一份 store 实例**（`AppBase.store()` 与 `getStore()` 同一个单例），
   * 所以这里 `store.set` 之后插件立刻就看得到——不必去改那个文件（改文件也不影响已加载的实例）。
   */
  const store = await liveStore()
  const solo = "独自在前的管理员"
  /** 他上方那些「排队中」要先清掉：真实表里前面本来就排着人，不清的话"前面没有排队中的人"这个前提不成立 */
  const ahead = (await readModel(SHEET)).rows.filter(r => r.row < rowA && r.status === QUEUED).map(r => r.row)
  await new Table({ file: fixture, backup: false }).mutate(ctx => {
    ctx.setCell(SHEET, rowA, "nickname", solo)
    for (const r of ahead) ctx.setCell(SHEET, r, "status", WAITING)
  })
  store.set(SHEET, ADMIN, { row: rowA, nickname: solo })
  await store.save()
  const beforeSolo = await tableSnap()
  const before = moves().length
  const r = await say("#插队", { card: solo })
  check("这一条也一个字没写表", async () => assert.equal(await tableSnap(), beforeSolo))
  check("已经在最前面：一个请求都不发，回话说明原因", () => {
    assert.equal(moves().length, before, `不该发请求：${JSON.stringify(moves().slice(before))}`)
    const text = said(r)
    assert.ok(text.includes("最前面"), `实际回复：${JSON.stringify(text)}`)
  })
  /** 还原：第一位那一行换回被指定的人（状态也还回「排队中」），管理员回到自己那一行 */
  await new Table({ file: fixture, backup: false }).mutate(ctx => {
    ctx.setCell(SHEET, rowA, "nickname", TARGET_NICK)
    ctx.setCell(SHEET, rowA, "status", QUEUED)
    for (const r of ahead) ctx.setCell(SHEET, r, "status", QUEUED)
  })
  store.set(SHEET, ADMIN, { row: rowB, nickname: ADMIN_NICK })
  await store.save()
  check("前置：管理员回到自己那一行（rowB）", () => assert.equal(Number(store.get(SHEET, ADMIN)?.row), rowB))
}

console.log("\n【4】指定某位成员与指定榜名")
{
  /**
   * `#插队 <群昵称>`：管理员点名挪**别人**那一行（管理能力），而不是把自己挪走
   *
   * 前置：rowA = 被点名的那位（绑定指着他自己那一行，昵称也对得上）、rowB = 管理员自己，
   * 两行两个名字、两条绑定各指各的 —— 这正是编辑器正常维护下的样子。
   */
  const store = await liveStore()
  await new Table({ file: fixture, backup: false }).mutate(ctx => {
    ctx.setCell(SHEET, rowA, "nickname", TARGET_NICK)
    ctx.setCell(SHEET, rowA, "status", QUEUED)
    ctx.setCell(SHEET, rowB, "nickname", ADMIN_NICK)
    ctx.setCell(SHEET, rowB, "status", QUEUED)
  })
  store.set(SHEET, ADMIN, { row: rowB, nickname: ADMIN_NICK })
  store.set(SHEET, "30001", { row: rowA, nickname: TARGET_NICK })
  await store.save()
  const beforeNamed = await tableSnap()
  const before = moves().length
  const r = await say(`#插队 ${TARGET_NICK}`)
  check("#插队 <群昵称>：挪的是被点名的那一行（不是调用者自己）", () => {
    assert.equal(r.fnc, "insert")
    assert.equal(moves().length, before + 1, `应当只发一条：${JSON.stringify(moves().slice(before))}`)
    const m = moves().at(-1)
    assert.equal(Number(m.row), rowA, `挪的应当是第 ${rowA} 行：${JSON.stringify(m)}`)
    assert.equal(m.nick, TARGET_NICK)
  })
  check("指名别人这一条也没写表", async () => assert.equal(await tableSnap(), beforeNamed))

  const before2 = moves().length
  const r2 = await say("#插队 危战")
  check("#插队 <榜名>：只处理那一个榜（这里是调用者自己那条）", () => {
    assert.equal(r2.fnc, "insert")
    assert.equal(moves().length, before2 + 1, `应当只发一条：${JSON.stringify(moves().slice(before2))}`)
    const m = moves().at(-1)
    assert.equal(m.sheet, SHEET)
    assert.equal(Number(m.row), rowB)
  })

  const r3 = await say("#插队 不存在的榜")
  check("#插队 <不认识的榜名>：当成群昵称/查不到，回话里点明没有动，不发请求", () => {
    const text = said(r3)
    assert.ok(text.includes("没有动") || text.includes("没有挪动"), text)
  })

  /**
   * 「被指定的人」那一行**没有任何对得上账的绑定**时一个字都不动
   *
   * 把被指名那位的绑定挪到 rowB 并写一个对不上的昵称（表被外部改过之后的样子）：
   * 这一行现在既查不出归属、又挂着一条旧绑定 —— 挪它等于押一个猜出来的行号，宁可不动。
   */
  const before4 = moves().length
  const beforeStale = await tableSnap()
  store.set(SHEET, "30001", { row: rowB, nickname: "过期的名字" })
  await store.save()
  const r4 = await say(`#插队 ${TARGET_NICK}`)
  check("那一行的归属对不上账时宁可不动：不发请求，回话点明", () => {
    assert.equal(moves().length, before4, `不该发请求：${JSON.stringify(moves().slice(before4))}`)
    assert.ok(said(r4).includes("没有动"), said(r4))
    assert.ok(said(r4).includes("归属"), said(r4))
  })
  check("被拒的那一条同样一个字没写表", async () => assert.equal(await tableSnap(), beforeStale))
  store.set(SHEET, "30001", { row: rowA, nickname: TARGET_NICK })
  await store.save()
}

console.log("\n【5】没在排队的榜 / 不是「排队中」：不发请求、回话点明")
{
  /**
   * 单独造一行「等待开启」，并**按绑定认他**（行上的昵称与绑定一致）
   *
   * 不复用前面那一位：真实表前面的行住着别人，归属与状态都不好控；这一段要钉的是
   * "状态不是「排队中」就一个字都不动"，前提得干净（名字也必须是全表唯一的）。
   */
  const store = await liveStore()
  const waitingRow = rowC + 1
  const soloWaiting = `${WAITING_NICK}（状态用例）`
  await new Table({ file: fixture, backup: false }).mutate(ctx => {
    ctx.setCell(SHEET, waitingRow, "nickname", soloWaiting)
    ctx.setCell(SHEET, waitingRow, "gameName", `${soloWaiting}的游戏名`)
    ctx.setCell(SHEET, waitingRow, "status", WAITING)
  })
  store.set(SHEET, "30005", { row: waitingRow, nickname: soloWaiting })
  await store.save()
  const beforeWaiting = await tableSnap()
  const before = moves().length
  const r = await say(`#插队 ${soloWaiting}`)
  check("「等待开启」的人不能插队：不发请求，回话点明状态", () => {
    assert.equal(moves().length, before, `不该发请求：${JSON.stringify(moves().slice(before))}`)
    assert.ok(said(r).includes("不是「排队中」"), `实际回复：${JSON.stringify(said(r))}`)
  })
  check("状态不对这一条也没写表", async () => assert.equal(await tableSnap(), beforeWaiting))

  {/** 管理员自己换到第一个榜（没排别的榜这条单独验） */}
  const before2 = moves().length
  const r2 = await say(`#插队 ${OTHER}`)
  check("本人没排那个榜：不发请求，回话点明", () => {
    assert.equal(moves().length, before2, `不该发请求：${JSON.stringify(moves().slice(before2))}`)
    assert.ok(said(r2).includes(OTHER), said(r2))
  })
}

console.log("\n【6】规则表：一条 #插队，不抢别的命令")
{
  check("规则表里只有一条 #插队（不抢别人的命令空间）", () => {
    const hits = APPS.flatMap(C => rulesOf(new C())).filter(r => r.reg.test("#插队") || r.reg.test("#插队 甲"))
    assert.equal(hits.length, 1, `命中 ${hits.length} 条规则`)
    assert.equal(hits[0].fnc, "insert")
  })
  check("裸榜名 / #排队 不受影响（#插队 规则不吞别的命令）", () => {
    assert.ok(APPS.some(C => rulesOf(new C()).some(r => r.reg.test("#排队"))), "#排队 应当照旧命中")
    assert.ok(!APPS.some(C => rulesOf(new C()).some(r => r.reg.test("#幽境危战"))), "裸榜名不该被本插件接管")
  })
}

await ENV.cloud.close()
await fs.rm(ENV.dir, { recursive: true, force: true }).catch(() => {})
await finish()
