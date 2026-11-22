/**
 * 数值配置项：参数优先、环境变量兜底、非法/负数回落
 *
 * 这几项（versions-keep / archive-days / archives-keep / changes-keep / quota-* / roster-trust-ms）
 * 长期只有环境变量入口，`editor/README.md` 与 `editor/config.js` 里都标着「待接接口」。
 * 现在统一接上命令行参数，这里钉住三条取值规则：
 *   1. 都不给 → `DEFAULTS` 里的默认值；
 *   2. 参数给了一律用参数（压过环境变量）；
 *   3. 参数/环境变量非法或负数 → 回落默认值，0 是合法值。
 *
 * 直接调用 `createConfig()`（不真起服务），所以不需要端口，也不依赖真实表格。
 *
 * 用法：node editor/test/config-flags.test.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { makeBoolFlag, makeFlag } from "../cli.js"
import { createConfig } from "../config.js"
import { PLUGIN_DIR } from "./plugin.mjs"

const TEMPLATE = path.join(PLUGIN_DIR, "resources", "空模板.xlsx")
if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 找不到空模板（${TEMPLATE}），跳过数值配置自检`)
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-config-flags-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(TEMPLATE, fixture)
const cfgPath = path.join(tmp, "config.yaml")
fs.writeFileSync(cfgPath, "default_sheet: 幽境危战\n", "utf8")

/** 被测的八项与它们的默认值（口径同 `editor/config.js` 的 `DEFAULTS`） */
const DEFAULTS = {
  versionsKeep: 20,
  archiveDays: 7,
  archivesKeep: 12,
  changesKeep: 2000,
  quotaMaxPerSave: 3,
  quotaWindowMs: 10 * 60 * 1000,
  quotaMaxPerWindow: 10,
  rosterTrustMs: 48 * 60 * 60 * 1000,
}

/** 八项对应的环境变量：每次调用前先清空，避免上一个用例串味 */
const ENV_KEYS = [
  "ABYSS_EDITOR_VERSIONS_KEEP",
  "ABYSS_EDITOR_ARCHIVE_DAYS",
  "ABYSS_EDITOR_ARCHIVES_KEEP",
  "ABYSS_EDITOR_CHANGES_KEEP",
  "ABYSS_EDITOR_QUOTA_PER_SAVE",
  "ABYSS_EDITOR_QUOTA_WINDOW_MS",
  "ABYSS_EDITOR_QUOTA_PER_WINDOW",
  "ABYSS_EDITOR_ROSTER_TRUST_MS",
]

const baseEnv = { ...process.env, ABYSS_QUEUE_CONFIG: cfgPath, ABYSS_EDITOR_TEST_PATHS: "1" }
for (const key of ENV_KEYS) delete baseEnv[key]

/** 取一次 cfg：参数与环境变量由用例给，公共参数（表/口令/插件根）固定 */
const cfgOf = async ({ args = [], env = {} } = {}) => {
  const before = process.env
  process.env = { ...baseEnv, ...env }
  try {
    const argv = ["--plugin", PLUGIN_DIR, "--file", fixture, "--token", "t", "--sign-key", "s", ...args]
    const { cfg } = await createConfig({ flag: makeFlag(argv), boolFlag: makeBoolFlag(argv) })
    return cfg
  } finally {
    process.env = before
  }
}

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err?.message ?? err}`)
  }
}

/** 八项一起比，报错时说清是哪一项不对 */
const expectAll = (cfg, want) => {
  for (const [key, value] of Object.entries(want)) {
    if (cfg[key] !== value) throw new Error(`${key}：期望 ${value}，实际 ${cfg[key]}`)
  }
}

try {
  await check("都不给时八项都取 DEFAULTS", async () => {
    expectAll(await cfgOf(), DEFAULTS)
  })

  await check("命令行参数逐项生效", async () => {
    const cfg = await cfgOf({
      args: [
        "--versions-keep", "5",
        "--archive-days", "2",
        "--archives-keep", "3",
        "--changes-keep", "7",
        "--quota-per-save", "1",
        "--quota-window-ms", "1000",
        "--quota-per-window", "4",
        "--roster-trust-ms", "60000",
      ],
    })
    expectAll(cfg, {
      versionsKeep: 5,
      archiveDays: 2,
      archivesKeep: 3,
      changesKeep: 7,
      quotaMaxPerSave: 1,
      quotaWindowMs: 1000,
      quotaMaxPerWindow: 4,
      rosterTrustMs: 60000,
    })
  })

  await check("没给参数时环境变量兜底", async () => {
    const cfg = await cfgOf({
      env: {
        ABYSS_EDITOR_VERSIONS_KEEP: "9",
        ABYSS_EDITOR_ARCHIVE_DAYS: "4",
        ABYSS_EDITOR_ARCHIVES_KEEP: "6",
        ABYSS_EDITOR_CHANGES_KEEP: "11",
        ABYSS_EDITOR_QUOTA_PER_SAVE: "2",
        ABYSS_EDITOR_QUOTA_WINDOW_MS: "2000",
        ABYSS_EDITOR_QUOTA_PER_WINDOW: "5",
        ABYSS_EDITOR_ROSTER_TRUST_MS: "120000",
      },
    })
    expectAll(cfg, {
      versionsKeep: 9,
      archiveDays: 4,
      archivesKeep: 6,
      changesKeep: 11,
      quotaMaxPerSave: 2,
      quotaWindowMs: 2000,
      quotaMaxPerWindow: 5,
      rosterTrustMs: 120000,
    })
  })

  await check("参数压过环境变量", async () => {
    const cfg = await cfgOf({
      args: ["--versions-keep", "1", "--quota-per-save", "0"],
      env: { ABYSS_EDITOR_VERSIONS_KEEP: "99", ABYSS_EDITOR_QUOTA_PER_SAVE: "99" },
    })
    expectAll(cfg, { versionsKeep: 1, quotaMaxPerSave: 0 })
  })

  await check("0 是合法值（0 = 不存 / 不限）", async () => {
    const cfg = await cfgOf({
      args: ["--versions-keep", "0", "--changes-keep", "0", "--archive-days", "0", "--archives-keep", "0"],
    })
    expectAll(cfg, { versionsKeep: 0, changesKeep: 0, archiveDays: 0, archivesKeep: 0 })
  })

  await check("负数 / 非数字回落 DEFAULTS", async () => {
    const cfg = await cfgOf({
      args: ["--versions-keep", "-1", "--archive-days", "abc", "--changes-keep", "-5", "--quota-per-window", "NaN"],
    })
    expectAll(cfg, {
      versionsKeep: DEFAULTS.versionsKeep,
      archiveDays: DEFAULTS.archiveDays,
      changesKeep: DEFAULTS.changesKeep,
      quotaMaxPerWindow: DEFAULTS.quotaMaxPerWindow,
    })
  })

  await check("环境变量非法也回落 DEFAULTS", async () => {
    const cfg = await cfgOf({ env: { ABYSS_EDITOR_QUOTA_PER_SAVE: "x", ABYSS_EDITOR_ROSTER_TRUST_MS: "-1" } })
    expectAll(cfg, { quotaMaxPerSave: 3, rosterTrustMs: DEFAULTS.rosterTrustMs })
  })
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err?.message ?? err}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 数值配置自检失败 ${failed} 项` : "\n✅ 数值配置自检通过")
process.exitCode = failed ? 1 : 0
