/** 鉴权：acl-roles / identity 合并成一个套件（原文件见 git 历史） */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import assert from "node:assert/strict"
import { createChecker } from "../../test/_helper.mjs"

const { check, finish } = createChecker("鉴权")

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")


  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过权限角色套件`)
    process.exit(0)
  }

  const ws = makeWorkspace("acl-roles")

  const TOKEN = "acl-roles-token"

  const SIGN_KEY = "acl-roles-sign-key"

  const OWNER_QQ = "424242"

  const ADMIN_QQ = "777777"

  const OWNER_NICK = "主人的群名片"

  const LEGACY_ADMIN_NICK = "老管理昵称"

  const adminsFile = ws.file("admins.json")

  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER_QQ, OWNER_NICK], admins: [ADMIN_QQ, LEGACY_ADMIN_NICK] }), "utf8")

  const ROSTER = ws.file("roster.json")

  const ROSTER_NICK = "名单里的小伙"

  const ROSTER_QQ = "888888"

  const MEMBER_QQ = "300001"

  const OTHER_QQ = "300009"

  fs.writeFileSync(
    ROSTER,
    JSON.stringify({
      group: "100000002",
      updatedAt: Date.now(),
      members: [
        { qq: ROSTER_QQ, nick: ROSTER_NICK },
        { qq: MEMBER_QQ, nick: "成员甲" },
        { qq: OTHER_QQ, nick: "成员乙" },
      ],
    }),
    "utf8",
  )

  let editor = null

  try {
    editor = await startEditor({
      label: "权限只按 QQ",
      token: TOKEN,
      signKey: SIGN_KEY,
      adminsFile,
      args: ["--file", ws.fixture],
      env: {
        ABYSS_QUEUE_CONFIG: ws.cfg,
        ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
        ABYSS_EDITOR_ROSTER_FILE: ROSTER,
        /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
        ABYSS_EDITOR_TEST_PATHS: "1",
      },
    })

    const asWho = who => editor.request("/api/data", { who })
    const rosterOfSheet = "幽境危战"
    /** 随便挑一行空行号：模板里没有成员，这个行号一定不属于任何人 */
    const futureRow = 12

    await check("昵称等于主人 QQ 的成员：仍然是普通成员（不是主人、不是管理员）", async () => {
      const r = await asWho({ qq: "300001", nick: OWNER_QQ })
      if (r.json.perm.role !== "self") throw new Error(`role=${r.json.perm.role}`)
      if (r.json.perm.owner) throw new Error("被当成了主人")
      if (r.json.perm.showAdmins) throw new Error("拿到了「权限管理」入口")
      const sheet = r.json.sheets.find(s => s.name === rosterOfSheet)
      /** 本人也能看主播列表（只读）；但写接口仍只认管理员 */
      if (!Array.isArray(sheet?.anchorRows)) throw new Error("普通成员拿不到只读主播列表")
    })

    await check("昵称等于主人 QQ 的成员：读不到白名单、也改不动白名单", async () => {
      const read = await editor.request("/api/admins", { who: { qq: "300001", nick: OWNER_QQ } })
      if (read.status !== 403) throw new Error(`读白名单 HTTP ${read.status}`)
      const write = await editor.request("/api/admins", { who: { qq: "300001", nick: OWNER_QQ }, body: { add: ["300001"] } })
      if (write.status !== 403) throw new Error(`改白名单 HTTP ${write.status} ${JSON.stringify(write.json)}`)
    })

    /** 报名用的真实下拉值：保存会校验选项，拿假值去测归属只会测到"选项不存在" */
    const optionsFor = async who => {
      const sheet = (await asWho(who)).json.sheets.find(s => s.name === rosterOfSheet)
      const o = sheet.options ?? {}
      return { anchor: (o.anchor ?? [])[0] ?? "公共队列", goal: (o.goal ?? [])[0] ?? "N5", dataEnd: sheet.dataEnd }
    }

    await check("昵称等于主人 QQ 的成员：空行可以正常报名（空行不属于任何人）", async () => {
      const { anchor, goal } = await optionsFor({ qq: MEMBER_QQ, nick: OWNER_QQ })
      const r = await editor.request("/api/save", {
        who: { qq: MEMBER_QQ, nick: OWNER_QQ },
        body: { sheet: rosterOfSheet, rows: [{ row: futureRow, values: { nickname: "普通成员", gameName: "x", anchor, goal } }] },
      })
      if (!r.json.ok) throw new Error(`普通成员建新行被拒了：${r.json.error}`)
    })

    /**
     * **口径反转**（2026-10 权限分阶段放开第 3 步）：本群成员**能**改别人的行，
     * 但受额度（一次 ≤3 行、10 分钟 ≤10 行）与红线约束；改不动的是**群外人**。
     */
    await check("昵称等于主人 QQ 的成员：能改别人的行（额度内）", async () => {
      /** 真别人的行：先让另一个成员占住一行，再拿他的名字来试 */
      const other = { qq: OTHER_QQ, nick: "别人" }
      const otherRow = futureRow + 1
      const { anchor, goal, dataEnd } = await optionsFor(other)
      if (otherRow > dataEnd) throw new Error(`模板行数不够（dataEnd=${dataEnd}），套件需要调整`)
      const setup = await editor.request("/api/save", {
        who: other,
        body: { sheet: rosterOfSheet, rows: [{ row: otherRow, values: { nickname: "别人的名字", gameName: "x", anchor, goal } }] },
      })
      if (!setup.json.ok) throw new Error(`前置：别人自己报名失败：${setup.json.error}`)

      const r = await editor.request("/api/save", {
        who: { qq: MEMBER_QQ, nick: OWNER_QQ },
        body: { sheet: rosterOfSheet, rows: [{ row: otherRow, values: { nickname: "别人的名字", gameName: "改过的", anchor, goal } }] },
      })
      if (!r.json.ok) throw new Error(`本群成员改别人的行被拒了：${r.json.error}`)
    })

    await check("群外人（名单里没有他）：一个字都不许写", async () => {
      const { anchor, goal } = await optionsFor({ qq: "300777", nick: "群外人" })
      const r = await editor.request("/api/save", {
        who: { qq: "300777", nick: "群外人" },
        body: { sheet: rosterOfSheet, rows: [{ row: futureRow + 3, values: { nickname: "群外人", gameName: "x", anchor, goal } }] },
      })
      if (r.json.ok) throw new Error("群外人竟然写成功了")
      if (!String(r.json.error).includes("不在本群成员名单")) throw new Error(r.json.error)
      /** 他也**看不到**整张表（只读，且只给自己那些行）：群外人不能白拿全表数据 */
      const view = await asWho({ qq: "300777", nick: "群外人" })
      if (view.json.perm.outOfGroup !== true || view.json.perm.readonly !== true) throw new Error(JSON.stringify(view.json.perm))
      if ((view.json.sheets ?? []).some(s => (s.rows ?? []).length)) throw new Error("群外人拿到了别人的行")
    })

    await check("昵称等于管理员 QQ 的成员：也只是普通成员", async () => {
      const r = await asWho({ qq: "300002", nick: ADMIN_QQ })
      if (r.json.perm.role !== "self") throw new Error(`role=${r.json.perm.role}`)
      if (r.json.perm.showAdmins) throw new Error("拿到了「权限管理」入口")
    })

    await check("与主人同昵称但 QQ 不同：不是主人", async () => {
      const r = await asWho({ qq: "300003", nick: OWNER_NICK })
      if (r.json.perm.role !== "self") throw new Error(`role=${r.json.perm.role}`)
      if (r.json.perm.owner) throw new Error("同名就被当成主人了")
    })

    await check("真主人（按 QQ）：仍是主人，且能看到「权限管理」", async () => {
      const r = await asWho({ qq: OWNER_QQ, nick: "随便改个名片" })
      if (r.json.perm.role !== "admin") throw new Error(`role=${r.json.perm.role}`)
      if (r.json.perm.owner !== true) throw new Error("没有标记 owner")
      if (!r.json.perm.showAdmins) throw new Error("没给权限管理入口")
    })

    await check("真管理员（按 QQ）：是管理员但不是主人，与名片怎么写无关", async () => {
      const r = await asWho({ qq: ADMIN_QQ, nick: "我也改了名片" })
      if (r.json.perm.role !== "admin") throw new Error(`role=${r.json.perm.role}`)
      if (r.json.perm.owner) throw new Error("普通管理员不该是主人")
      if (r.json.perm.showAdmins) throw new Error("普通管理员不该有权限管理入口")
    })

    await check("历史昵称条目：拒绝作为权限，并在页面上明确告知主人（含建议的 QQ）", async () => {
      const r = await asWho({ qq: OWNER_QQ, nick: "主人" })
      const acl = r.json.perm.acl
      if (!acl) throw new Error("主人拿不到白名单体检信息")
      if (!acl.ignored.includes(OWNER_NICK) || !acl.ignored.includes(LEGACY_ADMIN_NICK))
        throw new Error(`没有报出被拒绝的昵称条目：${JSON.stringify(acl.ignored)}`)
      if (!acl.admins.includes(ADMIN_QQ) || !acl.owners.includes(OWNER_QQ))
        throw new Error(`能当权限的 QQ 应当照常生效：${JSON.stringify(acl)}`)
    })

    await check("healthz 如实报出「解析不出 QQ 的条目」条数", async () => {
      const h = await editor.request("/healthz")
      if (h.json.admins !== 1 || h.json.owners !== 1) throw new Error(`admins=${h.json.admins} owners=${h.json.owners}`)
      if (h.json.acl_invalid !== 2) throw new Error(`acl_invalid=${h.json.acl_invalid}`)
    })

    await check("启动日志里说清「历史昵称条目已拒绝作为权限」", async () => {
      const log = editor.log()
      if (!log.includes("拒绝作为权限")) throw new Error(`启动日志没有提示：\n${log.slice(-600)}`)
      if (!log.includes(OWNER_NICK)) throw new Error("没有点名是哪条条目")
    })

    await check("维护白名单：只收 QQ，收昵称会被明确拒绝", async () => {
      const bad = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { add: ["某个群昵称"] } })
      if (bad.json.ok) throw new Error("竟然把昵称加进了白名单")
      if (!String(bad.json.error).includes("QQ")) throw new Error(bad.json.error)
      if (!bad.json.ignored?.includes(LEGACY_ADMIN_NICK)) throw new Error("没有回报仍被拒绝的历史条目")
    })

    /**
     * 填昵称的人多半**就是不知道 QQ**：只回一句"解析不出 QQ"等于让人自己去翻群资料。
     * 服务端拿群名单当场查一次，查得到就把号直接给出来（查不到才只讲规则）。
     */
    await check("填的是群名单里有的昵称：报错里直接给出他的 QQ", async () => {
      const r = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { add: [ROSTER_NICK] } })
      if (r.json.ok) throw new Error("竟然把昵称加进了白名单")
      if (!String(r.json.error).includes(ROSTER_QQ)) throw new Error(`报错里没给出 QQ：${r.json.error}`)
      if (!String(r.json.error).includes(ROSTER_NICK)) throw new Error(`报错里没点明是哪条：${r.json.error}`)
      if (String(r.json.error).includes("JSON")) throw new Error(`别把建议塞成 JSON：${r.json.error}`)
      if (r.json.suggestions?.[ROSTER_NICK] !== ROSTER_QQ) throw new Error(`suggestions 没带上：${JSON.stringify(r.json.suggestions)}`)
    })

    await check("填的是名单里也查不到的昵称：只说规则、不瞎猜 QQ", async () => {
      const r = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { add: ["查无此人"] } })
      if (r.json.ok) throw new Error("竟然把昵称加进了白名单")
      if (String(r.json.error).includes("在群名单里的 QQ 是")) throw new Error(`查不到却给了 QQ：${r.json.error}`)
    })

    await check("维护白名单：加 QQ 立即生效；移除后立即失效", async () => {
      const added = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { add: ["123456"] } })
      if (!added.json.ok) throw new Error(added.json.error || "添加失败")
      const promoted = await asWho({ qq: "123456", nick: "新管理员" })
      if (promoted.json.perm.role !== "admin") throw new Error(`新加的 QQ role=${promoted.json.perm.role}`)
      const removed = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { remove: ["123456"] } })
      if (!removed.json.ok) throw new Error(removed.json.error || "移除失败")
      const demoted = await asWho({ qq: "123456", nick: "新管理员" })
      if (demoted.json.perm.role !== "self") throw new Error(`移除后 role=${demoted.json.perm.role}`)
    })

    await check("安全迁移：主人能把历史昵称条目从白名单里删掉（删的是原始条目）", async () => {
      const removed = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { remove: [LEGACY_ADMIN_NICK] } })
      if (!removed.json.ok) throw new Error(removed.json.error || "移除失败")
      const raw = JSON.parse(fs.readFileSync(adminsFile, "utf8"))
      if (raw.admins.includes(LEGACY_ADMIN_NICK)) throw new Error(`文件里还留着：${JSON.stringify(raw)}`)
      if (!raw.admins.includes(ADMIN_QQ)) throw new Error("把能用的 QQ 一起删掉了")
      const h = await editor.request("/healthz")
      if (h.json.acl_invalid !== 1) throw new Error(`删掉一条后 acl_invalid 应为 1，实际 ${h.json.acl_invalid}`)
    })
  } catch (err) {
    await check("套件执行", async () => {
      throw err
    })
  } finally {
    if (editor) await editor.stop()
    ws.cleanup()
  }

  await finish()
})()

await (async () => {
  const { decodeIdentity, editorUrl, IDENTITY_TTL, signIdentity, verifyIdentity } = await shared("model/identity.js")

  const { createChecker } = await shared("test/_helper.mjs")


  const TOKEN = "tok-abc-123"

  const WHO = { qq: "1000000001", nick: "阿修Axiu" }

  const sign = (who = WHO, token = TOKEN) => signIdentity(who, token)

  check("签发后能验回来", () => {
    const { u, s } = sign()
    assert.deepEqual(verifyIdentity(u, s, TOKEN), { qq: WHO.qq, nick: WHO.nick, issuedAt: verifyIdentity(u, s, TOKEN).issuedAt })
  })

  check("身份里带 QQ 与群昵称", () => {
    const id = verifyIdentity(...Object.values(sign()), TOKEN)
    assert.equal(id.qq, WHO.qq)
    assert.equal(id.nick, WHO.nick)
  })

  check("换一个口令就验不过", () => {
    const { u, s } = sign()
    assert.equal(verifyIdentity(u, s, "别的口令"), null)
  })

  check("篡改身份（改成别人的昵称）验不过", () => {
    const { u, s } = sign()
    const raw = JSON.parse(Buffer.from(u, "base64url").toString("utf8"))
    raw.n = "摸头妹"
    const forged = Buffer.from(JSON.stringify(raw)).toString("base64url")
    assert.equal(verifyIdentity(forged, s, TOKEN), null)
    /** 解码本身不校验签名，所以仍能读出内容——正因如此，权限判断必须用 verifyIdentity */
    assert.equal(decodeIdentity(forged).nick, "摸头妹")
  })

  check("篡改身份（换成别人的 QQ）验不过", () => {
    const { u, s } = sign()
    const raw = JSON.parse(Buffer.from(u, "base64url").toString("utf8"))
    raw.q = "10000"
    const forged = Buffer.from(JSON.stringify(raw)).toString("base64url")
    assert.equal(verifyIdentity(forged, s, TOKEN), null)
  })

  check("过期的身份验不过", () => {
    const { u, s } = sign()
    const later = Date.now() + IDENTITY_TTL + 1000
    assert.equal(verifyIdentity(u, s, TOKEN, { now: later }), null)
    assert.ok(verifyIdentity(u, s, TOKEN, { now: Date.now() + 1000 }))
  })

  check("没有口令就签不出身份（未配置编辑器时不发个人链接）", () => {
    assert.equal(signIdentity(WHO, ""), null)
    assert.equal(verifyIdentity("x", "y", ""), null)
  })

  check("乱码 / 缺参数不抛错，只是验不过", () => {
    for (const [u, s] of [["", ""], ["不是base64", "也不是"], ["e30", "AAA"], [null, undefined]])
      assert.equal(verifyIdentity(u, s, TOKEN), null)
  })

  check("拼链接：带口令、身份与签名，并去掉 base 末尾多余的斜杠", () => {
    const url = editorUrl("https://example.com/queue///", { token: TOKEN, ...WHO })
    assert.ok(url.startsWith("https://example.com/queue/?k="), url)
    const q = new URL(url).searchParams
    assert.equal(q.get("k"), TOKEN)
    const id = verifyIdentity(q.get("u"), q.get("s"), TOKEN)
    assert.equal(id.nick, WHO.nick)
  })

  check("没配 editor_url 就不给链接", () => {
    assert.equal(editorUrl("", { token: TOKEN, ...WHO }), "")
    assert.equal(editorUrl("   ", { token: TOKEN, ...WHO }), "")
  })

  check("没配口令时只给纯地址（本机测试用）", () => {
    assert.equal(editorUrl("https://a.example.com/queue", { token: "" }), "https://a.example.com/queue")
  })

  check("签名密钥与口令分开：拿口令伪造身份验不过", () => {
    const SIGN_KEY = "sign-key-xyz"
    const real = signIdentity(WHO, SIGN_KEY)
    assert.ok(verifyIdentity(real.u, real.s, SIGN_KEY), "用签名密钥签的应当验得过")
    assert.equal(verifyIdentity(real.u, real.s, TOKEN), null, "拿口令验不该过")

    /** 拿到链接（含口令）的人自己用口令签一个"主人"身份：编辑器用 SIGN_KEY 验，必须不认 */
    const forged = signIdentity({ qq: "1000000001", nick: "缄月" }, TOKEN)
    assert.equal(verifyIdentity(forged.u, forged.s, SIGN_KEY), null, "用口令伪造的身份必须被拒")
  })

  check("拼链接时用签名密钥签、口令仍进链接", () => {
    const SIGN_KEY = "sign-key-xyz"
    const url = editorUrl("https://example.com/queue", { token: TOKEN, signKey: SIGN_KEY, ...WHO })
    const q = new URL(url).searchParams
    assert.equal(q.get("k"), TOKEN)
    assert.ok(verifyIdentity(q.get("u"), q.get("s"), SIGN_KEY), "签名密钥应当验得过")
    assert.equal(verifyIdentity(q.get("u"), q.get("s"), TOKEN), null, "口令不该验得过")
    /** 没配签名密钥时才退回用口令签（本机联调） */
    const legacy = new URL(editorUrl("https://example.com/queue", { token: TOKEN, ...WHO })).searchParams
    assert.ok(verifyIdentity(legacy.get("u"), legacy.get("s"), TOKEN))
  })

  await finish()
})()

finish()
