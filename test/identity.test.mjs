/**
 * 身份签名（机器人签发 / 编辑器验签）
 *
 * 这是「只让他改自己那一行」的唯一依据，所以重点验：换口令、改内容、过期都过不了。
 * 用法：node test/identity.test.mjs
 */
import assert from "node:assert/strict"
import { decodeIdentity, editorUrl, IDENTITY_TTL, signIdentity, verifyIdentity } from "../lib/identity.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("身份签名")
const TOKEN = "tok-abc-123"
const WHO = { qq: "1733491779", nick: "阿修Axiu" }

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
  const url = editorUrl("https://yunzai.axiu.uno/queue///", { token: TOKEN, ...WHO })
  assert.ok(url.startsWith("https://yunzai.axiu.uno/queue/?k="), url)
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

finish()
