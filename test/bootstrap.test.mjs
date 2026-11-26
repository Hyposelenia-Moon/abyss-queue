/** 启动补齐：编辑器凭证与管理员白名单只在缺失时写一次，之后不再碰 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  bootstrap,
  ensureAdminWhitelist,
  ensureEditorSecrets,
  patchEditorSecrets,
  readEditorKeys,
} from "../components/bootstrap.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("启动补齐")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-bootstrap-"))
const configDir = path.join(root, "config")
const dataDir = path.join(root, "data")
fs.mkdirSync(configDir, { recursive: true })
const configPath = path.join(configDir, "config.yaml")
const adminsFile = path.join(dataDir, "abyss-editor-admins.json")

const writeConfig = text => fs.writeFileSync(configPath, text, "utf8")
const readConfig = () => fs.readFileSync(configPath, "utf8")

const FULL = [
  "# 这段注释必须原样保留",
  "editor:",
  '  public_url: "https://example.com/queue"',
  '  token: ""',
  '  sign_key: ""',
  '  admin_token: ""',
  "default_sheet: 幽境危战",
  "",
].join("\n")

const quiet = () => {}
const say = []

await check("凭证：空着就补齐，注释与别的键一字不动、public_url 保持空", () => {
  writeConfig(FULL)
  const out = ensureEditorSecrets({ configPath })
  assert.equal(out.status, "done")
  assert.match(out.detail, /editor\.token/)
  assert.match(out.detail, /editor\.sign_key/)
  const text = readConfig()
  assert.match(text, /^# 这段注释必须原样保留$/m, "注释丢了")
  assert.match(text, /default_sheet: 幽境危战/, "别的键被改了")
  const keys = readEditorKeys(text).keys
  assert.equal(keys.public_url, "https://example.com/queue", "public_url 不该被改")
  assert.match(keys.token, /^[0-9a-f]{32}$/, "token 不是 16 字节 hex")
  assert.match(keys.sign_key, /^[0-9a-f]{48}$/, "sign_key 不是 24 字节 hex")
  assert.match(text, /admin_token: ""/, "没动的键不该被重写")
})

await check("凭证：第二次启动只读不写（内容逐字节不变）", () => {
  const before = readConfig()
  const out = ensureEditorSecrets({ configPath })
  assert.equal(out.status, "skip")
  assert.equal(readConfig(), before, "第二次启动又写了 config.yaml")
})

await check("凭证：手填过的不覆盖", () => {
  writeConfig(FULL.replace('token: ""', 'token: "我自己的口令"').replace('sign_key: ""', 'sign_key: "我自己的密钥"'))
  const before = readConfig()
  const out = ensureEditorSecrets({ configPath })
  assert.equal(out.status, "skip")
  assert.equal(readConfig(), before)
})

await check("凭证：editor 段里整行缺失时按缩进插回去", () => {
  writeConfig(["editor:", '  public_url: ""', "default_sheet: 幽境危战", ""].join("\n"))
  const out = ensureEditorSecrets({ configPath })
  assert.equal(out.status, "done")
  const keys = readEditorKeys(readConfig()).keys
  assert.match(keys.token, /^[0-9a-f]{32}$/)
  assert.match(keys.sign_key, /^[0-9a-f]{48}$/)
})

await check("凭证：config.yaml 解析不了就不写、只报失败", () => {
  const bad = "editor:\n  token: [1, 2\n"
  writeConfig(bad)
  const out = ensureEditorSecrets({ configPath })
  assert.equal(out.status, "fail")
  assert.equal(readConfig(), bad, "坏配置竟然被改了")
})

await check("白名单：首次启动把框架主人写进去（过滤 stdin、去重、转字符串）", () => {
  fs.rmSync(adminsFile, { force: true })
  const out = ensureAdminWhitelist({ dataDir, adminsFile, owners: ["stdin", "1733491779", 1733491779] })
  assert.equal(out.status, "done")
  const saved = JSON.parse(fs.readFileSync(adminsFile, "utf8"))
  assert.deepEqual(saved.owner, ["1733491779"])
  assert.deepEqual(saved.admins, ["1733491779"])
})

await check("白名单：已有 owner 就不再改（换一批主人也不覆盖）", () => {
  const before = fs.readFileSync(adminsFile, "utf8")
  const out = ensureAdminWhitelist({ dataDir, adminsFile, owners: ["1000000001"] })
  assert.equal(out.status, "skip")
  assert.equal(fs.readFileSync(adminsFile, "utf8"), before)
})

await check("白名单：文件坏了不覆盖、只报失败", () => {
  fs.writeFileSync(adminsFile, "{ 不是 JSON", "utf8")
  const before = fs.readFileSync(adminsFile, "utf8")
  const out = ensureAdminWhitelist({ dataDir, adminsFile, owners: ["1000000001"] })
  assert.equal(out.status, "fail")
  assert.equal(fs.readFileSync(adminsFile, "utf8"), before)
})

await check("白名单：框架没配主人就跳过（不写空 owner）", () => {
  fs.rmSync(adminsFile, { force: true })
  const out = ensureAdminWhitelist({ dataDir, adminsFile, owners: ["stdin"] })
  assert.equal(out.status, "skip")
  assert.equal(fs.existsSync(adminsFile), false, "没有主人却写了文件")
})

await check("bootstrap：两步一起跑、不抛；第二次跑全跳过", () => {
  writeConfig(FULL)
  fs.rmSync(adminsFile, { force: true })
  const first = bootstrap({ root, owners: ["1733491779"], say: (level, text) => say.push({ level, text }) })
  assert.equal(first.secrets.status, "done")
  assert.equal(first.whitelist.status, "done")
  const second = bootstrap({ root, owners: ["1733491779"], say: quiet })
  assert.equal(second.secrets.status, "skip")
  assert.equal(second.whitelist.status, "skip")
  assert.ok(say.some(line => line.level === "info" && /启动补齐/.test(line.text)), "成功没记日志")
})

await check("patchEditorSecrets：写坏的值读回来必须一致，否则返回 null 不落盘", () => {
  const text = ["editor:", '  token: "旧的"', '  sign_key: "旧的"', ""].join("\n")
  const next = patchEditorSecrets(text, { token: "abc", signKey: "def" })
  assert.ok(next)
  assert.deepEqual(readEditorKeys(next).keys, { token: "abc", sign_key: "def", public_url: "" })
  assert.equal(patchEditorSecrets("editor: [1, 2]", { token: "a", signKey: "b" }), null)
})

fs.rmSync(root, { recursive: true, force: true })

await finish()