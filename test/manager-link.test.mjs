/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行，
   若在本文件里 setenv，config.js 早就按仓库 config.yaml 读完了（会动到真实表格与真实白名单） */
import { ensureEnv } from "./env.mjs"
/**
 * 管理员的私聊链接（机器人侧后半段）：投递方式按身份分 + 只在本人发 `#排队` 时给一次
 *
 * 覆盖三条链路：
 *   1. **投递方式**：`#排队` 的发送者是主人 / 白名单管理员时，这一条回复**私聊发**、群里一个字都不发；
 *      普通群友照旧群内发（短链、单条消息、`#排队 全部` / `#排队 <榜>` 都不回归）。
 *   2. **私聊那份链接的形态**：带当期时间窗的长地址（`?w=&ws=`）——短码在编辑器那条路由上是
 *      "点开时现签窗口"，拿它当私聊链接等于永不过期，所以管理链接必须是带窗口的长地址。
 *   3. **只给一次**：链接只在本人发 `#排队` 那一刻发出去，带的是**那一刻的当期窗口**；
 *      **tick 不主动发链**（窗口变没变都不发），窗外的旧链靠编辑器的时间窗自然失效，
 *      要新的就再发一次 `#排队`。
 *
 * 时间一律由 `tick(now)` 注入（不 mock 全局 Date）：5 分钟的窗口没法真等。
 * 私聊出口是 `Bot.pickFriend`（TRSS 既有能力），桩在 `_helper.mjs` 的 `installFrameworkStubs()`。
 *
 * 用法：node test/manager-link.test.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createChecker, installFrameworkStubs, requireSource } from "./_helper.mjs"

const SOURCE = await requireSource()
const { check, finish } = createChecker("管理员私聊链接")

/** 框架桩要在插件类被求值之前装好（AppBase 继承全局 plugin） */
const sent = installFrameworkStubs()

const ENV = await ensureEnv({ prefix: "abyss-queue-dm-" })
await fs.promises.copyFile(SOURCE, ENV.fixture)

const OWNER = { qq: "1000000001", nick: "主人样本" }
const ADMIN = { qq: "1000000002", nick: "管理员样本" }
const OUTSIDER = { qq: "1000000009", nick: "只认框架 master" }
const MEMBER = { qq: "1000000003", nick: "普通群友" }

const { config } = await import("../components/config.js")
/** 白名单：**这份文件决定 `#排队` 往哪儿发**（与编辑器同一份，见 model/whitelist.js） */
const writeWhitelist = file => fs.writeFileSync(config.adminsPath, JSON.stringify(file), "utf8")
writeWhitelist({ owner: [OWNER.qq], admins: [OWNER.qq, ADMIN.qq] })

const { AbyssQueueQuery } = await import("../apps/queue.js")
const { decodeIdentity, verifyIdentity, verifyWindow, WINDOW_MS, windowEpoch } = await import("../model/identity.js")
const { linkStatePath } = await import("../modules/manager-link.js")
const { isManagerQq } = await import("../model/whitelist.js")

/** 注册规则（与框架 loader 同一取法），并证明 `#排队` 真的命中 menu */
const rules = (new AbyssQueueQuery().rule ?? []).map(r => ({
  reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg),
  fnc: r.fnc,
}))
const ruleOf = msg => rules.find(r => r.reg.test(msg))?.fnc ?? null

/** 发一条消息：按规则匹配 → 调真实 handler */
const say = async (msg, { user_id = MEMBER.qq, card = MEMBER.nick, isMaster = false } = {}) => {
  const fnc = ruleOf(msg)
  assert.equal(fnc, "menu", `${msg} 应命中 menu 规则`)
  const inst = Object.assign(new AbyssQueueQuery(), {
    e: { msg, user_id, self_id: "10000", group_id: "20000", isGroup: true, isMaster, sender: { card, nickname: card } },
    __replies: [],
  })
  await inst.menu()
  return inst
}

/** 片段数组 → 可读文本（图片段记成 [图片]，markdown 段按 markdown 原文） */
const msgText = m =>
  Array.isArray(m)
    ? m
        .map(p =>
          typeof p === "string"
            ? p
            : p?.type === "image"
              ? "[图片]"
              : p?.type === "markdown"
                ? String(p.data?.content ?? "")
                : String(p),
        )
        .join("")
    : String(m)

/**
 * 链接地址：优先 markdown 段的 `[文字](地址)`，其次纯文本里的「点此填表：<地址>」，
 * 最后是纯文本里的裸地址（`#排队` 那两档取前两种，文本兜底是最后一种）
 */
const linkUrlOf = text => {
  const md = /\[([^\]]*)\]\(([^)\s]+)\)/.exec(text)
  if (md) return md[2]
  return /点此填表：(http\S+)/.exec(text)?.[1] ?? /(https?:\/\/\S+)/.exec(text)?.[1] ?? ""
}

/** 一条私聊消息的地址与它的参数 */
const linkInDm = dm => {
  const url = linkUrlOf(msgText(dm.msg))
  return { url, q: url ? new URL(url).searchParams : new URLSearchParams() }
}

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(linkStatePath(), "utf8"))
  } catch {
    return null
  }
}
const groupCount = () => sent.length
const dmCount = () => sent.dms.length

console.log(`源表格：${SOURCE}\n白名单：${config.adminsPath}\n链接状态：${linkStatePath()}\n`)

/* ------------------------------ 用例 ------------------------------ */

console.log("【1】主人发 #排队：链接走私聊，群里一个字都不发")
{
  const g0 = groupCount()
  const d0 = dmCount()
  const inst = await say("#排队", { user_id: OWNER.qq, card: OWNER.nick })

  check("群里一条都没发（这一档整个回复都走私聊）", () => {
    assert.equal(groupCount(), g0, `群里多了 ${groupCount() - g0} 条`)
    assert.equal(inst.__replies.length, 0, `实例回复了：${JSON.stringify(inst.__replies.map(msgText))}`)
  })
  check("私聊恰好收到一条，收件人是发送者本人", () => {
    assert.equal(dmCount(), d0 + 1, `私聊多了 ${dmCount() - d0} 条`)
    assert.equal(sent.dms.at(-1).qq, OWNER.qq)
  })

  const dm = sent.dms.at(-1)
  const text = msgText(dm.msg)
  const { url, q } = linkInDm(dm)
  check("私聊里是编辑器地址 + 身份，不是短码", () => {
    assert.ok(url.startsWith("http://127.0.0.1:"), url)
    assert.ok(!url.includes("/s/"), `私聊不该发短码（短码永不过期）：${url}`)
    assert.ok(q.get("u") && q.get("s"), url)
  })
  /**
   * 能失败：把 `fillEntry` 的 `manager` 那一支去掉（照旧走短码），这一条立刻红——
   * 短码里没有 `w/ws`，而"旧链即时作废"完全靠它。
   */
  check("私聊里的链接带**当期时间窗**（w/ws），且编辑器那一套验得过", () => {
    const w = q.get("w") ?? ""
    const ws = q.get("ws") ?? ""
    assert.ok(/^\d+$/.test(w) && ws, `没有时间窗：${url}`)
    const qq = String(decodeIdentity(q.get("u") ?? "")?.qq ?? "")
    assert.ok(verifyWindow(w, ws, { qq }, config.remote.sign_key), `窗口验不过：${url}`)
    assert.equal(Number(w), windowEpoch(Number(Date.now())))
  })
  check("链接里的身份就是发送者本人（签名对得上）", () => {
    const id = verifyIdentity(q.get("u"), q.get("s"), config.remote.sign_key)
    assert.ok(id, `身份验不过：${url}`)
    assert.equal(id.qq, OWNER.qq)
    assert.equal(id.nick, OWNER.nick)
  })
  check("私聊里也带着填写情况（与群里同一份内容）", () => {
    assert.ok(/未填：|已完成：/.test(text), text)
    assert.ok(text.includes("[图片]"), text)
  })

  /**
   * 能失败：把 `afterSend` 里的 `recordManagerLink` 挪掉，状态文件里就没有这一条，
   * 下面【4】的"记的那个窗口就是链接里的窗口"也就无从谈起。
   */
  check("状态文件记下：发给了谁 / 哪个窗口 / 消息 id", () => {
    const rec = readState()?.recipients?.[OWNER.qq]
    assert.ok(rec, JSON.stringify(readState()))
    assert.equal(rec.nick, OWNER.nick)
    assert.equal(rec.window, windowEpoch(Number(Date.now())))
    /** 记的窗口就是这条链接里的窗口（两处必须同一份，`menu()` 里也算一次） */
    assert.equal(rec.window, Number(q.get("w")), `记的窗口与链接里的对不上：${url}`)
    assert.equal(rec.messageId, dm.message_id)
    assert.ok(rec.at > 0, JSON.stringify(rec))
  })
  check("状态文件落在隔离的临时目录里（不脏仓库 data/）", () =>
    assert.ok(path.resolve(linkStatePath()).startsWith(path.resolve(ENV.dir)), linkStatePath()),
  )
}

console.log("\n【2】白名单管理员 / 框架 master：一样走私聊")
{
  const g0 = groupCount()
  const d0 = dmCount()
  await say("#排队", { user_id: ADMIN.qq, card: ADMIN.nick })
  check("白名单管理员（不是 owner）也走私聊", () => {
    assert.equal(groupCount(), g0, `群里多了 ${groupCount() - g0} 条`)
    assert.equal(dmCount(), d0 + 1)
    assert.equal(sent.dms.at(-1).qq, ADMIN.qq)
  })
  /**
   * 与【1】同一套判据换个收件人再钉一遍（这段 `#排队` 的两条断言后面还要用：
   * 【4】不再看 tick 发出去的链，改成看这一条私聊）
   */
  const dmAdmin = sent.dms.at(-1)
  const { url: urlAdmin, q: qAdmin } = linkInDm(dmAdmin)
  check("管理员那条私聊里也是带当期窗口的长地址，且记的窗口与它一致", () => {
    assert.ok(!urlAdmin.includes("/s/"), `私聊不该发短码（短码永不过期）：${urlAdmin}`)
    const rec = readState().recipients[ADMIN.qq]
    assert.ok(rec, JSON.stringify(readState()))
    assert.equal(Number(qAdmin.get("w")), rec.window, `记的窗口与链接里的对不上：${urlAdmin}`)
    assert.ok(
      verifyWindow(qAdmin.get("w"), qAdmin.get("ws"), { qq: ADMIN.qq }, config.remote.sign_key),
      `窗口验不过：${urlAdmin}`,
    )
  })
  check("名单口径：owner 与 admins 都算（只有名单外的人不算）", () => {
    assert.equal(isManagerQq(OWNER.qq), true)
    assert.equal(isManagerQq(ADMIN.qq), true)
    assert.equal(isManagerQq(MEMBER.qq), false)
    /** 白名单里的昵称条目不算权限（AQ-01）：解析不出 QQ 一律拒绝 */
    writeWhitelist({ owner: [OWNER.qq], admins: [OWNER.qq, ADMIN.qq, MEMBER.nick] })
    assert.equal(isManagerQq(MEMBER.nick), false)
    writeWhitelist({ owner: [OWNER.qq], admins: [OWNER.qq, ADMIN.qq] })
  })

  const g1 = groupCount()
  const d1 = dmCount()
  await say("#排队", { user_id: OUTSIDER.qq, card: OUTSIDER.nick, isMaster: true })
  check("框架 master（白名单里没有它）也算主人：走私聊、不落群里", () => {
    assert.equal(groupCount(), g1, `群里多了 ${groupCount() - g1} 条`)
    assert.equal(dmCount(), d1 + 1)
    assert.equal(sent.dms.at(-1).qq, OUTSIDER.qq)
  })
}

console.log("\n【3】普通群友照旧群内发（不回归）")
{
  const d0 = dmCount()
  const inst = await say("#排队", { user_id: MEMBER.qq, card: MEMBER.nick })
  /**
   * 「群内发」的判据是**插件实例的 reply**（真实入口 `ctx.reply` = 发到当前会话）；
   * `sent`（`Bot.pickGroup().sendMsg`）只有 tick 里的 @ 通知会用到，回复不走它。
   */
  check("群内发出恰好一条（图 + 填写情况 + 入口同一条消息）", () => {
    assert.equal(inst.__replies.length, 1, JSON.stringify(inst.__replies.map(msgText)))
    assert.equal(dmCount(), d0)
  })
  const url = linkUrlOf(msgText(inst.__replies[0]))
  /** 能失败：把身份判据写成恒真（谁都走私聊），这一条与上面【1】会同时红 */
  check("普通群友拿到的还是短链（`<地址>/s/<16 字符码>`，后面挂签名过的签发时刻 + 群昵称）", () => {
    assert.match(url, /\/s\/[A-Za-z0-9_-]{16}(?:\?t=\d+&ts=[A-Za-z0-9_-]+(?:&n=[A-Za-z0-9_-]+)?)?$/)
    assert.ok(!url.includes("w="), `短链里不该带时间窗（编辑器 302 时现签）：${url}`)
  })

  const one = await say("#排队 危战", { user_id: MEMBER.qq, card: MEMBER.nick })
  check("`#排队 <榜>`：照旧群内发，没有私聊", () => {
    assert.equal(one.__replies.length, 1)
    assert.ok(msgText(one.__replies[0]).includes("[图片]"))
  })
  const all = await say("#排队 全部", { user_id: MEMBER.qq, card: MEMBER.nick })
  check("`#排队 全部`：照旧群内发", () => {
    assert.equal(all.__replies.length, 1)
    assert.ok(/点此填表|暂无链接/.test(msgText(all.__replies[0])), msgText(all.__replies[0]))
  })
  const dmOne = await say("#排队 危战", { user_id: OWNER.qq, card: OWNER.nick })
  check("主人发 `#排队 <榜>`：同样私聊（单榜也带链接，不能漏在群里）", () => {
    assert.equal(dmOne.__replies.length, 0)
    assert.equal(sent.dms.at(-1).qq, OWNER.qq)
  })
  /** 管理员再来一次 `#排队 危战`：下面【4】要按"各收过两条"核对那两条私聊 */
  const dmAdminTwo = await say("#排队 危战", { user_id: ADMIN.qq, card: ADMIN.nick })
  check("白名单管理员发 `#排队 <榜>`：一样私聊", () => {
    assert.equal(dmAdminTwo.__replies.length, 0)
    assert.equal(sent.dms.at(-1).qq, ADMIN.qq)
  })
}

console.log("\n【4】tick 不主动发链：窗口变没变都不发，要新的得本人再发一次 #排队")
{
  check("窗口宽度就是 5 分钟", () => assert.equal(WINDOW_MS, 5 * 60 * 1000))

  const win = readState().recipients[OWNER.qq].window
  const sameWindow = new Date(win * WINDOW_MS + 60 * 1000)
  const g0 = groupCount()
  const d0 = dmCount()
  await new AbyssQueueQuery().tick(sameWindow)
  /**
   * 能失败：把 `refreshManagerLinks({ now: at })` 加回 `tick()`，这一条立刻红
   * （从前那条"窗口变了就重发"的路已按维护者要求去掉）。
   */
  check("窗口没变：一条都不发", () => {
    assert.equal(dmCount(), d0, `私聊多了 ${dmCount() - d0} 条`)
    assert.equal(groupCount(), g0, `群里多了 ${groupCount() - g0} 条`)
  })

  /** 进【5】之前的状态：窗口没变这一轮不该动它 */
  const stateBefore = readState()
  const windowsBefore = Object.fromEntries(Object.entries(stateBefore.recipients).map(([qq, r]) => [qq, r.window]))
  const d1 = dmCount()
  const nextWindow = new Date((win + 1) * WINDOW_MS + 60 * 1000)
  await new AbyssQueueQuery().tick(nextWindow)
  /** 窗口真的变了（不然上面那条与下面几条都是在没变化的场景上空转） */
  const fresh = sent.dms.slice(d1)
  check("窗口变了：同样一条都不发（tick 不发链）", () => {
    assert.equal(dmCount(), d1, `私聊多了 ${dmCount() - d1} 条`)
    assert.equal(fresh.length, 0, `tick 发了：${JSON.stringify(fresh.map(m => m.qq))}`)
    assert.notEqual(windowEpoch(nextWindow.getTime()), win, "这条用例要求窗口真变了")
    assert.equal(groupCount(), g0, `群里多了 ${groupCount() - g0} 条`)
  })
  /**
   * 链接只在本人发 `#排队` 那一刻发出去：这两个管理员各收过两条（一条 `#排队`、一条 `#排队 危战`），
   * 两条都是**那一刻的当期窗口**；tick 一轮都没往里加。
   *
   * 能失败：① 把 `fillEntry` 的 `manager` 那一支去掉（退回短码）→ 链接里没有 `w`；
   * ② 让 `menu()` 复用一份旧的窗口（不从 `now` 现签）→ 窗口与那一刻/状态文件对不上。
   * 循环前先钉住条数，避免"遍历空数组而静默通过"。
   */
  check("本人发 `#排队` 那一条私聊：带当期窗口、用那一刻的时间戳就验得过，且窗口已落盘", () => {
    for (const qq of [OWNER.qq, ADMIN.qq]) {
      const mine = sent.dms.filter(m => m.qq === qq)
      assert.equal(mine.length, 2, `${qq} 应有两条（两次 #排队），实际 ${JSON.stringify(mine.map(m => linkInDm(m).url))}`)
      const rec = readState().recipients[qq]
      assert.ok(rec, JSON.stringify(readState().recipients))
      for (const m of mine) {
        const { url, q } = linkInDm(m)
        assert.equal(Number(q.get("w")), win, `带的是当期窗口（那一刻）：${url}`)
        assert.ok(verifyWindow(q.get("w"), q.get("ws"), { qq }, config.remote.sign_key), `在那一刻验不过：${url}`)
        assert.equal(rec.window, Number(q.get("w")), `记的窗口与链接里的对不上：${url}`)
      }
    }
  })
  /** 能失败：把身份判据写反（拿别人的身份签）→ 收件人与链接里的 QQ 对不上 */
  check("每条的收件人与链接里的身份对得上（没有串号）", () => {
    for (const m of sent.dms) {
      if (m.qq !== OWNER.qq && m.qq !== ADMIN.qq) continue
      const { q } = linkInDm(m)
      assert.equal(decodeIdentity(q.get("u") ?? "")?.qq, m.qq)
    }
  })
  check("tick 一轮都没动状态文件里的窗口（不是刷新失败，是根本不刷新）", () => {
    for (const [qq, w] of Object.entries(windowsBefore)) assert.equal(readState().recipients[qq]?.window, w, JSON.stringify(readState().recipients[qq]))
  })

  const d2 = dmCount()
  await new AbyssQueueQuery().tick(nextWindow)
  check("同一窗口再 tick：照样一条都不发", () => assert.equal(dmCount(), d2, `私聊多了 ${dmCount() - d2} 条`))

  /**
   * tick 的另外四件事（@ 通知）走 `Bot.pickGroup`，本套件没配 `notify.groups`：
   * 一次都不该发出去——不换链接也不许顺带把通知带出来。
   */
  check("这几轮 tick 一条群消息都没发", () => assert.equal(groupCount(), g0, `群里多了 ${groupCount() - g0} 条`))
}

console.log("\n【5】名单变了也不发链：tick 照样一个动作都不做")
{
  const win = readState().recipients[OWNER.qq].window
  const recipientsBefore = JSON.stringify(readState().recipients)
  writeWhitelist({ owner: [OWNER.qq], admins: [OWNER.qq] })
  const d0 = dmCount()
  const g0 = groupCount()
  await new AbyssQueueQuery().tick(new Date((win + 1) * WINDOW_MS + 60 * 1000))
  const fresh = sent.dms.slice(d0)
  /**
   * 能失败：与【4】同一条——把 `refreshManagerLinks({ now: at })` 加回 `tick()` 后，
   * 这里会看到给 OWNER 重发的一条（窗口也变了）。
   */
  check("移出白名单之后 tick 也不给任何人发链", () => {
    assert.equal(fresh.length, 0, `tick 发了：${JSON.stringify(fresh.map(m => m.qq))}`)
    assert.equal(dmCount(), d0, `私聊多了 ${dmCount() - d0} 条`)
    assert.equal(groupCount(), g0, `群里多了 ${groupCount() - g0} 条`)
  })
  /**
   * 既然不刷新，状态文件就该原样留着（谁收过链、那一刻是哪个窗口）；
   * 这条同时挡住"tick 顺手改了状态文件"。
   */
  check("状态文件一个字没变（不刷新就不改写谁收过链）", () =>
    assert.equal(JSON.stringify(readState().recipients), recipientsBefore),
  )
}

console.log("\n【6】私聊发不出去：群里只报一句原因（绝不把链接退回群里），状态也不改")
{
  const before = fs.readFileSync(linkStatePath(), "utf8")
  const g0 = groupCount()
  const d0 = dmCount()
  const realPick = globalThis.Bot.pickFriend
  /** 复刻"没加好友"：私聊整条链路都抛错 */
  globalThis.Bot.pickFriend = () => ({
    sendMsg: async () => {
      throw new Error("对方不在好友列表里")
    },
    recallMsg: async () => {},
  })
  let inst
  try {
    inst = await say("#排队", { user_id: OWNER.qq, card: OWNER.nick })
  } finally {
    globalThis.Bot.pickFriend = realPick
  }
  /**
   * 能失败：把 `afterSend` 的 `else if (!sent)` 那一段去掉，主人就什么反馈都收不到
   * （群里没有提示、私聊也发不出去）——"机器人没反应"正是这一步要挡住的。
   */
  check("群内提示一句「私聊发不出去」，且**不带链接**", () => {
    assert.equal(inst.__replies.length, 1, JSON.stringify(inst.__replies.map(msgText)))
    const text = msgText(inst.__replies[0])
    assert.ok(text.includes("私聊"), text)
    assert.ok(!/https?:\/\//.test(text), `提示里不该有链接：${text}`)
    assert.equal(groupCount(), g0)
  })
  check("没有私聊发出去", () => assert.equal(dmCount(), d0))
  /**
   * 能失败：把 `recordManagerLink` 改成"发之前先记"，状态文件就会被改掉——
   * 于是它谎报一条**根本没到人手上**的链接（`window` / `messageId` 都在，
   * 而本人什么都没收到）；tick 不参与补发，这条谎报没人会纠正。
   */
  check("状态文件一个字没变（没发出去就不记）", () =>
    assert.equal(fs.readFileSync(linkStatePath(), "utf8"), before),
  )
}

await ENV.cloud?.close()
await finish()
