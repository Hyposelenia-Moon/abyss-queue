/**
 * Cookie 安全：日志脱敏 + 临时副本清理
 *
 * 这两件事做错就等于把登录态漏出去，所以单独盯着。
 * 用法：node test/doc-cookie.test.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cleanTempCopies, cookieHeader, redact } from "../tools/doc-cookie.mjs"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("Cookie 安全")

const COOKIE = "pac_uid=0_ydzKhx; o_minduid=OJiRCJbWq2Kx9vTz1pQr3sTu5vWx7yZ"

check("整条 Cookie 头出现在日志里 → 抹掉", () => {
  const out = redact(`fetch failed: ${COOKIE}`, COOKIE)
  assert.ok(!out.includes("OJiRCJbW"), out)
  assert.ok(!out.includes("0_ydzKhx"), out)
})

check("只带出单个片段（短值）也要抹掉", () => {
  const out = redact("header content: pac_uid=0_ydzKhx", COOKIE)
  assert.ok(!out.includes("0_ydzKhx"), out)
})

check("报错里带出长值也要抹掉", () => {
  const out = redact("ByteString error: o_minduid=OJiRCJbWq2Kx9vTz1pQr3sTu5vWx7yZ", COOKIE)
  assert.ok(!out.includes("OJiRCJbW"), out)
})

check("正常日志不该被改（路径、文档地址、格数都要留着）", () => {
  const line = "目标：D:/文件/游戏/原神/.abyss-queue-测试副本.xlsx  改动 3 格  doc_url=https://docs.qq.com/sheet/DQURqWURTSWVCYmZQ"
  assert.equal(redact(line, COOKIE), line)
})

check("cookieHeader 只拼 name=value，不带换行", () => {
  const header = cookieHeader([
    { host: "docs.qq.com", name: "a", value: "1" },
    { host: "docs.qq.com", name: "b", value: "2" },
  ])
  assert.equal(header, "a=1; b=2")
  assert.ok(!/[\r\n]/.test(header))
})

check("清理临时副本：只删自己的前缀，别人的文件不动", () => {
  const mine = path.join(os.tmpdir(), `abyss-cookies-${process.pid}-${Date.now()}.db`)
  const other = path.join(os.tmpdir(), `someone-else-${Date.now()}.db`)
  fs.writeFileSync(mine, "x")
  fs.writeFileSync(other, "x")
  try {
    cleanTempCopies()
    assert.equal(fs.existsSync(mine), false, "自己前缀的副本应当被删")
    assert.equal(fs.existsSync(other), true, "别人的文件不能动")
  } finally {
    fs.rmSync(other, { force: true })
  }
})

finish()
