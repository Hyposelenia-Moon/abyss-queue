/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行，
   若在本文件里 setenv，config.js 早就按仓库 config.yaml 读完了（会动到真实表格与真实白名单） */
import { ensureEnv } from "./env.mjs"
/**
 * 管理员的私聊链接（机器人侧后半段）：投递方式按身份分 + 每 5 分钟换新
 *
 * 覆盖三条链路：
 *   1. **投递方式**：`#排队` 的发送者是主人 / 白名单管理员时，这一条回复**私聊发**、群里一个字都不发；
 *      普通群友照旧群内发（短链、单条消息、`#排队 全部` / `#排队 <榜>` 都不回归）。
 *   2. **私聊那份链接的形态**：带当期时间窗的长地址（`?w=&ws=`）——短码在编辑器那条路由上是
 *      "点开时现签窗口"，拿它当私聊链接等于永不过期，所以管理链接必须是带窗口的长地址。
 *   3. **换新**：唯一那条 tick 按"时间窗变没变"决定要不要重发；窗口没变**一个动作都不做**，
 *      变了才发新的（顺带撤回上一条，框架支持的话），并把"发给了谁 / 哪个窗口 / 消息 id"落盘。
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
 * 最后是换新那条私聊里的裸地址（`#排队` 是前两种，tick 重发的是最后一种）
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
   * 下面【4】的"窗口变了要重发"也就无从谈起。
   */
  check("状态文件记下：发给了谁 / 哪个窗口 / 消息 id", () => {
    const rec = readState()?.recipients?.[OWNER.qq]
    assert.ok(rec, JSON.stringify(readState()))
    assert.equal(rec.nick, OWNER.nick)
    assert.equal(rec.window, windowEpoch(Number(Date.now())))
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
  check("普通群友拿到的还是短链（`<地址>/s/<16 字符码>`）", () => {
    assert.match(url, /\/s\/[A-Za-z0-9_-]{16}$/)
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
}

console.log("\n【4】换新：窗口没变不动作，窗口变了才重发")
{
  check("窗口宽度就是 5 分钟", () => assert.equal(WINDOW_MS, 5 * 60 * 1000))

  const win = readState().recipients[OWNER.qq].window
  const sameWindow = new Date(win * WINDOW_MS + 60 * 1000)
  const g0 = groupCount()
  const d0 = dmCount()
  await new AbyssQueueQuery().tick(sameWindow)
  /**
   * 能失败：把 `refreshPlan` 的 `rec.window === win → continue` 去掉，每 tick 都会重发，
   * 这一条立刻红（下面那条会看到 DM 变多）。
   */
  check("窗口没变：一条都不重发", () => {
    assert.equal(dmCount(), d0, `私聊多了 ${dmCount() - d0} 条`)
    assert.equal(groupCount(), g0, `群里多了 ${groupCount() - g0} 条`)
  })

  const d1 = dmCount()
  const prevIds = Object.fromEntries(Object.entries(readState().recipients).map(([qq, r]) => [qq, r.messageId]))
  const nextWindow = new Date((win + 1) * WINDOW_MS + 60 * 1000)
  await new AbyssQueueQuery().tick(nextWindow)
  const fresh = sent.dms.slice(d1)
  check("窗口变了：给每个收过链接的管理员各发一条新的", () => {
    assert.deepEqual(fresh.map(m => m.qq).sort(), [OWNER.qq, ADMIN.qq].sort(), JSON.stringify(fresh.map(m => m.qq)))
  })
  /**
   * 能失败：把 `windowedEditorUrl` 换成不带窗口的地址（或复用旧链接），窗口就不是新窗口了。
   *
   * 验签时把"现在"也注入成那一刻：`win + 1` 是**未来**的窗口，`verifyWindow` 按真实时间判会拒收
   * （未来的窗口一律不认）。这里要证的正是"在那一刻，编辑器认这条链接"。
   */
  check("新链接带的是**新窗口**，且那一刻编辑器验得过", () => {
    for (const m of fresh) {
      const { q, url } = linkInDm(m)
      assert.equal(Number(q.get("w")), win + 1, `没有换成新窗口：${url}`)
      const qq = String(decodeIdentity(q.get("u") ?? "")?.qq ?? "")
      assert.ok(
        verifyWindow(q.get("w"), q.get("ws"), { qq }, config.remote.sign_key, { now: nextWindow.getTime() }),
        `那一刻也验不过：${url}`,
      )
    }
  })
  check("新链接的收件人与身份对得上（没有串号）", () => {
    for (const m of fresh) {
      const { q } = linkInDm(m)
      assert.equal(decodeIdentity(q.get("u") ?? "")?.qq, m.qq)
    }
  })
  check("顺带撤回了上一条（框架支持撤回时；QQ 只给 2 分钟，撤不回来是常态）", () => {
    for (const m of fresh) assert.ok(sent.recalls.some(r => r.qq === m.qq && r.id === prevIds[m.qq]), JSON.stringify(sent.recalls))
  })
  check("状态文件里的窗口跟着更新成新窗口", () => {
    for (const qq of [OWNER.qq, ADMIN.qq]) {
      const rec = readState().recipients[qq]
      assert.equal(rec.window, win + 1, JSON.stringify(rec))
      assert.ok(rec.messageId.startsWith("dm-"), JSON.stringify(rec))
    }
  })

  const d2 = dmCount()
  await new AbyssQueueQuery().tick(nextWindow)
  check("同一窗口再 tick：还是不重复发", () => assert.equal(dmCount(), d2, `私聊多了 ${dmCount() - d2} 条`))

  /**
   * tick 的另外四件事（@ 通知）走 `Bot.pickGroup`，本套件没配 `notify.groups`：
   * 一次都不该发出去——换链接不许顺带把通知也带出来。
   */
  check("这几轮 tick 一条群消息都没发（只换链接）", () => assert.equal(groupCount(), g0, `群里多了 ${groupCount() - g0} 条`))
}

console.log("\n【5】名单变了：移出白名单的人不再收链接")
{
  const win = readState().recipients[OWNER.qq].window
  writeWhitelist({ owner: [OWNER.qq], admins: [OWNER.qq] })
  const d0 = dmCount()
  await new AbyssQueueQuery().tick(new Date((win + 1) * WINDOW_MS + 60 * 1000))
  const fresh = sent.dms.slice(d0)
  check("只给还在名单里的人重发", () => {
    assert.deepEqual(fresh.map(m => m.qq), [OWNER.qq], JSON.stringify(fresh.map(m => m.qq)))
  })
  check("被移出白名单的人记录也一并丢掉", () => {
    assert.equal(readState().recipients[ADMIN.qq], undefined, JSON.stringify(readState().recipients))
    assert.ok(readState().recipients[OWNER.qq], JSON.stringify(readState().recipients))
  })
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
   * 于是 tick 会以为"新链接已经发出去了"，把这次失败静默吞掉（旧链接到期后主人永远收不到新的）。
   */
  check("状态文件一个字没变（没发出去就不记，下一次 tick 还会再试）", () =>
    assert.equal(fs.readFileSync(linkStatePath(), "utf8"), before),
  )
}

await ENV.cloud?.close()
await finish()
