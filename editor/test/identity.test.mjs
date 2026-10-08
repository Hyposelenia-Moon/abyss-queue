/**
 * 身份签名（机器人签发 / 编辑器验签）
 *
 * 这是「只让他改自己那一行」的唯一依据，所以重点验：换口令、改内容、过期都过不了。
 * 用法：node test/identity.test.mjs
 */
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { shared } from "./plugin.mjs"

/** 身份签名只有一份实现（插件 model/identity.js） */
const {
  decodeIdentity,
  decodeLinkNick,
  editorUrl,
  encodeLinkNick,
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

/**
 * 短链上跟着签发时刻一起走的**发送者群昵称**（`?n=`）
 *
 * 为什么要有它：短码里只有 QQ，群名片一向由编辑器按 QQ 从**每天推一次的群名单**里补；
 * 名单里没有这个人（没推成功 / 刚进群 / 没配群号）时签出来的身份昵称是空串，页面就认不出"自己那一行"。
 * 发链接这一刻机器人手里有他的群名片，把它一起签进去当兜底。
 */
{
  const KEY = "sign-key-nick"
  const code = signTicket({ qq: WHO.qq }, KEY)
  const nick = "小伙03"

  check("带群昵称签出来的 `?n=` 能解回原名，且证明得了是这条链接签的", () => {
    const fresh = signFreshness(code, KEY, Date.now(), nick)
    assert.ok(fresh.n, "没签出 n")
    assert.equal(decodeLinkNick(fresh.n), nick)
    assert.ok(verifyFreshness(code, fresh.t, fresh.ts, KEY, { nick: decodeLinkNick(fresh.n) }) > 0, "自己签的验不过")
  })
  check("改过群昵称就整段作废（n 与 t/ts 共用同一段签名）", () => {
    const fresh = signFreshness(code, KEY, Date.now(), nick)
    assert.equal(verifyFreshness(code, fresh.t, fresh.ts, KEY, { nick: "别的人" }), 0)
    /** 把 n 换成另一份签名的（同一 QQ、同一分钟、不同昵称）：照样不认 */
    const other = signFreshness(code, KEY, Date.now(), "别的人")
    assert.equal(verifyFreshness(code, other.t, other.ts, KEY, { nick }), 0)
  })
  check("不带群昵称时与加它之前一字不差（已经发出去的 `?t&ts` 链接照旧验得过）", () => {
    const noNick = signFreshness(code, KEY)
    assert.equal(noNick.n, undefined, "没给昵称却签出了 n")
    assert.ok(verifyFreshness(code, noNick.t, noNick.ts, KEY) > 0)
    /** 签名输入里没有昵称那一段：拿空昵称验也一样过（编辑器不传 nick 就是这条路） */
    assert.ok(verifyFreshness(code, noNick.t, noNick.ts, KEY, { nick: "" }) > 0)
  })
  check("空白昵称当没带（`?n=` 不会出现一段空 base64）", () => {
    assert.equal(encodeLinkNick("   "), "")
    assert.equal(signFreshness(code, KEY, Date.now(), "  ").n, undefined)
    assert.equal(decodeLinkNick(null), "")
    assert.equal(decodeLinkNick("不是 base64!!"), "")
  })
  check("中文昵称按 base64url 走（链接里不出现 `%E5` 那种转义）", () => {
    const fresh = signFreshness(code, KEY, Date.now(), nick)
    assert.match(fresh.n, /^[A-Za-z0-9_-]+$/)
    assert.ok(!fresh.n.includes("%"))
  })
  /**
   * 签名**只留前 12 字节**（16 个字符）：整段 HMAC 是 43 个字符，比短码本身还长，
   * 群里那条链接因此折五行。截断后链接短 27 个字符，而验证是"给多长就比多长"。
   */
  check("新鲜度签名只有 16 个字符（整段的 43 个字符省掉 27 个）", () => {
    const fresh = signFreshness(code, KEY, Date.now(), nick)
    assert.equal(fresh.ts.length, 16, fresh.ts)
    assert.equal(fresh.ts, fresh.ts.replace(/=+$/, ""), "不该带 base64 的等号填充")
    assert.ok(verifyFreshness(code, fresh.t, fresh.ts, KEY, { nick }) > 0)
  })
  check("从前那种**整段**签名照旧验得过（按前缀比；改动这段输入格式会在这里红）", () => {
    const t = Math.floor(Date.now() / 60000)
    /** 手工按 `abyss-ticket-at.<码>.<分钟>` 算整段 HMAC——**这个输入格式是兼容契约**，别改 */
    const full = createHmac("sha256", KEY).update(`abyss-ticket-at.${code}.${t}`).digest("base64url")
    assert.equal(full.length, 43)
    assert.ok(verifyFreshness(code, t, full, KEY) > 0, "整段签名（老链接）验不过了")
    /** 带群昵称的那些老链接：整段签名的输入多一段 `.昵称` */
    const withNick = createHmac("sha256", KEY).update(`abyss-ticket-at.${code}.${t}.${encodeLinkNick(nick)}`).digest("base64url")
    assert.ok(verifyFreshness(code, t, withNick, KEY, { nick }) > 0, "带昵称的整段签名验不过了")
  })
  check("过短的签名不认（空签名会「前缀匹配」任何东西，必须挡在这一层）", () => {
    const fresh = signFreshness(code, KEY)
    assert.equal(verifyFreshness(code, fresh.t, "", KEY), 0)
    assert.equal(verifyFreshness(code, fresh.t, "AAAA", KEY), 0)
    assert.equal(verifyFreshness(code, fresh.t, fresh.ts.slice(0, 10), KEY), 0)
    assert.ok(verifyFreshness(code, fresh.t, fresh.ts.slice(0, 16), KEY) > 0, "刚好 16 个字符该验得过")
  })
}

await finish()
