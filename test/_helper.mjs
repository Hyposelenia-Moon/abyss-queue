/**
 * 回归测试公共设施：路径推导 / 断言计数 / 框架全局桩
 *
 * 约定见 test/README.md：
 *   - 路径一律经 Paths 推导，禁止裸相对字面量与盘符绝对路径（SOURCE 允许用环境变量覆盖）
 *   - 缺前置（表格不存在等）要「跳过、不算失败」
 */
import fs from "node:fs"
import path from "node:path"

/** 插件根 = 本文件上一级 */
export const pluginRoot = path.resolve(import.meta.dirname, "..")

export const Paths = {
  root: pluginRoot,
  /** 被测的真实表格：环境变量 XLSX_PATH 可覆盖，便于在别的机器上跑 */
  get source() {
    return process.env.XLSX_PATH ?? path.join(path.dirname(pluginRoot), "2026年10月三路深渊排队.xlsx")
  },
  fixture: (dir, name = "queue.xlsx") => path.join(dir, name),
  config: (dir) => path.join(dir, "config.yaml"),
  store: (dir) => path.join(dir, "bindings.json"),
  /** posix 化，写临时 config.yaml 时用 */
  posix: p => p.replace(/\\/g, "/"),
}

/** 断言计数器：全部跑完再按失败数退出，行为与框架里的 checker() 一致 */
export function createChecker(title = "") {
  let passed = 0
  const lines = []
  return {
    get passed() {
      return passed
    },
    get lines() {
      return lines
    },
    check(name, fn) {
      try {
        fn()
        passed++
        lines.push(`  ✅ ${name}`)
      } catch (err) {
        lines.push(`  ❌ ${name}\n     ${err?.message ?? err}`)
        console.log(lines.join("\n"))
        console.error(`\n❌ ${title}失败：${name}\n${err?.message ?? err}`)
        process.exitCode = 1
        throw new Error("__CHECK_FAILED__")
      }
    },
    finish() {
      console.log(lines.join("\n"))
      const failed = lines.filter(l => l.startsWith("  ❌")).length
      console.log(`\n${failed ? "❌" : "✅"} ${title}：通过 ${passed} 项断言${failed ? `，失败 ${failed} 项` : ""}`)
      if (failed) process.exitCode = 1
    },
  }
}

/** 缺前置就跳过（打印 ⏭ 并正常退出），不算失败 */
export function skip(reason) {
  console.log(`⏭ 跳过：${reason}`)
  process.exit(0)
}

/** 前置：被测表格必须存在 */
export function requireSource() {
  if (!fs.existsSync(Paths.source)) skip(`被测表格不存在（用 XLSX_PATH 指定）：${Paths.source}`)
  return Paths.source
}

/**
 * 框架全局桩：复刻 Yunzai 注入的全局（plugin / logger / segment / Bot）
 * 必须在 import 插件代码之前调用。
 */
export function installFrameworkStubs({ onSent } = {}) {
  const stateArr = {}
  class PluginStub {
    constructor(opts = {}) {
      Object.assign(this, opts)
    }
    /* 一个插件目录下可以有多个 app 类且同名，直接按 name 建 key 会互相串上下文；
       用规则集（fnc 列表）区分：同一类的不同实例 key 相同，不同类必然不同。 */
    conKey(isGroup = false) {
      const owner = (this.rule ?? []).map(r => r.fnc).join("+") || this.name
      return `${owner}.${this.self_id ?? this.e.self_id}.${isGroup ? this.group_id ?? this.e.group_id : this.user_id ?? this.e.user_id}`
    }
    reply(msg) {
      this.__replies.push(msg)
      return true
    }
    setContext(type, isGroup, time = 120) {
      const key = this.conKey(isGroup)
      stateArr[key] ??= {}
      stateArr[key][type] = this.e
      return this.e
    }
    getContext(type, isGroup) {
      if (type) return stateArr[this.conKey(isGroup)]?.[type]
      return stateArr[this.conKey(isGroup)]
    }
    finish(type, isGroup) {
      const key = this.conKey(isGroup)
      if (stateArr[key]) delete stateArr[key][type]
    }
  }

  globalThis.plugin = PluginStub
  globalThis.logger = {
    mark: () => {},
    info: () => {},
    warn: () => {},
    error: (...a) => console.error("[logger.error]", ...a),
  }
  globalThis.segment = { at: id => ({ type: "at", qq: id }) }

  const sent = []
  globalThis.Bot = {
    pickGroup: gid => ({
      sendMsg: async msg => {
        sent.push({ gid, msg })
        onSent?.(gid, msg)
      },
    }),
  }
  return sent
}
