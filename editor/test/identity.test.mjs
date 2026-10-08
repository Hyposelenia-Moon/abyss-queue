/**
 * 身份签名（机器人签发 / 编辑器验签）
 *
 * 这是「只让他改自己那一行」的唯一依据，所以重点验：换口令、改内容、过期都过不了。
 * 用法：node test/identity.test.mjs
 */
import assert from "node:assert/strict"
import { shared } from "./plugin.mjs"

/** 身份签名只有一份实现（插件 model/identity.js） */
const {
  decodeIdentity,
  editorUrl,
  IDENTITY_TTL,
  signFreshness,
  signIdentity,
  signTicket,
  verifyFreshness,
  verifyIdentity,
  verifyTicket,
} = await shared("model/identity.js")

/** 断言小工具仍在插件目录里（测试脚手架只有一份） */
const { createChecker } = await shared("test/_helper.mjs")

const { check, finish } = createChecker("身份签名")
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

/** 访问口令会出现在每个人的链接里，所以它绝不能同时当签名密钥用 */
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

/**
 * 短链上的**签发时刻**（`?t&ts=`）：认领层靠它判"谁手里那条更新"（见 editor/claims.js 的接管规则）
 *
 * 为什么不能只靠短码：短码是 `(QQ, 密钥, 30 天窗口)` 的确定性函数，同一窗口内新旧链接字节相同，
 * 认不出"主人刚重发的那条"与"几天前转发出去的旧副本"。
 */
{
  const KEY = "sign-key-xyz"
  const code = signTicket({ qq: WHO.qq }, KEY)
  const fresh = signFreshness(code, KEY)

  check("签出来的签发时刻能验回来（分钟粒度）", () => {
    const at = verifyFreshness(code, fresh.t, fresh.ts, KEY)
    assert.ok(at > 0, "自己签的验不过")
    assert.equal(at, fresh.t * 60000)
  })
  check("改过签名 / 换一条码 / 乱填都不认（返回 0，不是抛错）", () => {
    assert.equal(verifyFreshness(code, fresh.t, "AAAA", KEY), 0)
    assert.equal(verifyFreshness(signTicket({ qq: "1000000002" }, KEY), fresh.t, fresh.ts, KEY), 0)
    assert.equal(verifyFreshness(code, "abc", fresh.ts, KEY), 0)
    assert.equal(verifyFreshness(code, "", "", KEY), 0)
  })
  check("太旧的签发时刻不认（旧副本没有接管能力）", () => {
    const old = signFreshness(code, KEY, Date.now() - 40 * 60 * 1000)
    assert.equal(verifyFreshness(code, old.t, old.ts, KEY, { ttl: 10 * 60 * 1000 }), 0)
    /** 同一段标记，放宽 ttl 又认得了（说明拒的是"太旧"而不是签名本身） */
    assert.ok(verifyFreshness(code, old.t, old.ts, KEY, { ttl: 60 * 60 * 1000 }) > 0)
  })
  check("未来时间不认（时钟漂 1 分钟以内放行）", () => {
    const future = signFreshness(code, KEY, Date.now() + 10 * 60 * 1000)
    assert.equal(verifyFreshness(code, future.t, future.ts, KEY), 0)
  })
  check("没配密钥签不出标记（返回 null，不抛错）", () => {
    assert.equal(signFreshness(code, ""), null)
    assert.equal(verifyFreshness(code, fresh.t, fresh.ts, ""), 0)
  })
  check("短码本身一字未动（签发时刻只挂在查询串上，旧链接照旧能用）", () => {
    assert.equal(verifyTicket(code, KEY)?.qq, WHO.qq)
    assert.equal(code.length, 16)
  })
}

await finish()
