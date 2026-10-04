/**
 * 回归测试公共设施：路径推导 / 断言计数 / 框架全局桩
 *
 * 约定见 test/README.md：
 *   - 路径一律经 Paths 推导，禁止裸相对字面量与盘符绝对路径（SOURCE 允许用环境变量覆盖）
 *   - 被测表格缺失时退到合成样本继续跑（`requireSource()` 不再整套跳过）；
 *     真正的缺前置跳过（部署目录、空模板、浏览器、假云端等）仍在，见 test/README.md
 */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

export const pluginRoot = path.resolve(import.meta.dirname, "..")

/** 配置模板内容（示例配置是新增配置键的唯一来源） */
export const exampleConfig =
  YAML.parse(fs.readFileSync(path.join(pluginRoot, "config", "config.yaml.example"), "utf8")) ?? {}

/**
 * 维护者机器上那份真实表（与插件同级目录）
 *
 * 它只是**方便本机对照真实数据**的一层来源，不再是回归套件的硬前置：
 * 干净克隆 / CI / 别人的机器上没有它，套件改用合成样本照样真跑（见下）。
 */
const maintainerTable = path.join(path.dirname(pluginRoot), "2026年10月三路深渊排队.xlsx")

let samplePromise = null

/** 合成样本的落点（`test/.test-tmp/` 已 gitignore）：不存在时由 `requireSource()` 现生成 */
const sampleFile = () => path.join(pluginRoot, "test", ".test-tmp", "sample-table.xlsx")

/**
 * 被测表格的三层来源（外部审核「改进意见 #3」）：
 *   1. 显式 `XLSX_PATH`：指哪份用哪份（**指向不存在的路径时也照跑**，不会整套跳过）
 *   2. 维护者机器上那份真实表：保持老行为，本机仍然对着真实数据跑
 *   3. 合成样本：`test/fixtures/sample-table.mjs` 以 `resources/空模板.xlsx` 为骨架现生成，
 *      匿名、可复现，写到 `test/.test-tmp/`（已 gitignore），不写进版本库
 *
 * 为什么不再"缺表就整套跳过"：套件跳过与通过以前都是退出码 0，汇总里看不出差别，
 * 于是干净克隆上"一半套件没跑"被当成了绿；现在缺表会退到合成样本，套件必须真跑完。
 */
function sourcePath() {
  /**
   * 强制走合成样本：`ABYSS_TEST_SYNTHETIC=1`
   *
   * 用来在本机（或 CI 上）复验"没有真实表时套件照样全绿且零跳过"，
   * 不必去动维护者那份真实表；也顺便让 XLSX_PATH 指空路径时不会悄悄回落到真实表。
   */
  if (/^(1|true|yes|on)$/i.test(String(process.env.ABYSS_TEST_SYNTHETIC ?? "").trim())) return null
  const explicit = process.env.XLSX_PATH
  if (explicit && fs.existsSync(explicit)) return explicit
  if (fs.existsSync(maintainerTable)) return maintainerTable
  return null
}

/**
 * 兼容两种调用姿势的路径对象（历史包袱，现在没人用了）
 *
 * 生成合成样本是异步的（要读 xlsx、重打包 zip），所以 `requireSource()` 必须 `await`。
 * 老代码里有 `const SOURCE = requireSource()` 这种同步写法（顶层直接当字符串用），
 * Node 的 fs **不接受**"字符串对象"（`new String()` 也不行，会报 src/path 类型错），
 * 所以这里只在"已知路径"这一支上做点兼容：`await` 能拿到字符串，`toString()` 也给出路径。
 * @param {string|null} direct 已知路径（真实表 / XLSX_PATH）
 * @param {Promise<string>|null} pending 需要现生成的样本
 */
function sourceHandle(direct, pending) {
  if (!pending) return direct
  const value = () => direct ?? sampleFile()
  return {
    async then(onFulfilled, onRejected) {
      try {
        return await (onFulfilled ? onFulfilled(await pending) : await pending)
      } catch (err) {
        if (!onRejected) throw err
        return onRejected(err)
      }
    },
    toString: value,
    valueOf: value,
    [Symbol.toPrimitive]: value,
    get length() {
      return value().length
    },
  }
}

export const Paths = {
  root: pluginRoot,
  /**
   * 被测表格的落点：真实表在就是它，否则是合成样本（要真用请 `await requireSource()`）
   */
  get source() {
    return sourcePath() ?? sampleFile()
  },
  /** 维护者那份真实表的位置（不论在不在），供套件判断"这次是不是真实数据" */
  realTable: maintainerTable,
  fixture: (dir, name = "queue.xlsx") => path.join(dir, name),
  config: (dir) => path.join(dir, "config.yaml"),
  store: (dir) => path.join(dir, "bindings.json"),
  /** posix 化，写临时 config.yaml 时用 */
  posix: p => p.replace(/\\/g, "/"),
}

/**
 * 这次跑的是不是"真实数据"（维护者那份真表，或 `XLSX_PATH` 明确指的别的真表）
 *
 * 有几条断言只在真实数据上才说明问题（例如"空模板的样式规范化对得上被清空的那批行"：
 * 合成样本本身就是照空模板生成的，自己跟自己比什么都看不出来）。这类断言在合成模式下
 * 应当**明确报"没验到"**，而不是假装通过。
 * @param {string} file 本次用的表格路径
 */
export function isRealTable(file) {
  const p = String(file)
  if (p === maintainerTable) return true
  const explicit = process.env.XLSX_PATH
  return Boolean(explicit && p === explicit)
}

/**
 * 断言计数器：全部跑完再按失败数退出，行为与框架里的 checker() 一致
 *
 * 支持 async 回调：`check(name, async () => ...)` 的断言在 finish() 之前会被等完。
 * （以前不 await，异步用例会跟后面的用例抢时序，偶发失败还查不出原因。）
 */
export function createChecker(title = "") {
  let passed = 0
  let failed = 0
  const lines = []
  const pending = []

  const record = (name, err) => {
    if (!err) {
      passed++
      lines.push(`  ✅ ${name}`)
      return
    }
    failed++
    lines.push(`  ❌ ${name}\n     ${err?.message ?? err}`)
    console.log(lines.join("\n"))
    console.error(`\n❌ ${title}失败：${name}\n${err?.message ?? err}`)
    process.exitCode = 1
  }

  return {
    get passed() {
      return passed
    },
    get lines() {
      return lines
    },
    check(name, fn) {
      let out
      try {
        out = fn()
      } catch (err) {
        record(name, err)
        throw new Error("__CHECK_FAILED__")
      }
      /** 异步用例：等它跑完再记结果，别让它和后面的用例抢时序 */
      if (out && typeof out.then === "function") {
        const p = out.then(
          () => record(name),
          err => record(name, err),
        )
        pending.push(p)
        return p
      }
      record(name)
      return undefined
    },
    async finish() {
      if (pending.length) await Promise.all(pending)
      console.log(lines.join("\n"))
      console.log(`\n${failed ? "❌" : "✅"} ${title}：通过 ${passed} 项断言${failed ? `，失败 ${failed} 项` : ""}`)
      if (failed) process.exitCode = 1
    },
  }
}

/**
 * 缺前置就跳过（打印 `⏭ 套件跳过：…` 并正常退出），不算失败
 *
 * 前缀写死成「套件跳过」是有意的：`run.mjs` 靠它把"整套没跑"和"某条断言按条件跳过"
 * （那些只印 `⏭ 原因`）区分开，汇总时才不会把 10 个没跑的套件算成"通过"。
 */
export function skip(reason) {
  console.log(`⏭ 套件跳过：${reason}`)
  process.exit(0)
}

/**
 * 前置：被测表格（永远拿得到）
 *
 * 与老实现的差别：**不再"缺表就整套跳过"** —— 退回合成样本继续跑。
 * 注意它**可能**要现生成合成样本，所以调用方必须 `await`：
 *   `const SOURCE = await requireSource()`
 */
export function requireSource() {
  const direct = sourcePath()
  if (direct) return sourceHandle(direct, null)
  /** 合成样本自己会打印「本次用合成样本（真实表不存在）」，且只在真正生成那一次打印 */
  samplePromise ??= import("./fixtures/sample-table.mjs").then(({ ensureSampleTable }) => ensureSampleTable())
  return sourceHandle(null, samplePromise)
}

/**
 * 框架全局桩：复刻 Yunzai 注入的全局（plugin / logger / segment / Bot）
 * 必须在 import 插件代码之前调用。
 */
export function installFrameworkStubs({ onSent, members = {} } = {}) {
  const stateArr = {}
  /** 渲染调用记录（供套件断言模板路径与数据） */
  const renderCalls = []
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
    /**
     * 框架的渲染入口
     *   retType=base64 → 只返回图片数据（图片段），不自己发（插件据此把图与文案合并成一条消息）
     *   默认 → 截图后自己发出，返回 true
     */
    async renderImg(plugin, tpl, data, cfg) {
      renderCalls.push({ plugin, tpl, data, cfg })
      if (cfg?.retType === "base64") return { type: "image", file: `base64://${tpl}` }
      this.reply(`[图片]${tpl}.html`)
      return true
    }
    /** 框架挂在插件实例上的运行时：真实入口是 this.e.runtime.render(plugin, tpl, data, {e, scale}) */
    get runtime() {
      return { render: (plugin, tpl, data, cfg) => this.renderImg(plugin, tpl, data, cfg) }
    }
  }

  globalThis.plugin = PluginStub
  globalThis.logger = {
    mark: () => {},
    info: () => {},
    warn: () => {},
    error: (...a) => console.error("[logger.error]", ...a),
  }
  globalThis.segment = { at: id => ({ type: "at", qq: id }), image: file => ({ type: "image", file }) }

  const sent = []
  /** 渲染调用记录也挂在返回值上，便于套件断言（sent.renderCalls） */
  sent.renderCalls = renderCalls
  globalThis.Bot = {
    pickGroup: gid => ({
      sendMsg: async msg => {
        sent.push({ gid, msg })
        onSent?.(gid, msg)
      },
      /**
       * 群成员名单：通知里 @ 人要靠它把群昵称映射回 QQ（members 可随时改，取用是动态的）
       *
       * 形状要跟**真实框架**一致：这个 TRSS 版本返回的是"以 QQ 为键的普通对象"，不是 Map
       * （早先桩用 Map、生产是普通对象，于是"群名单从没推成功、@ 人退化成纯文本"这类 bug 测不出来）。
       */
      getMemberMap: () => Object.fromEntries(Object.entries(members).map(([nick, qq]) => [String(qq), { user_id: String(qq), card: nick, nickname: nick }])),
    }),
  }
  return sent
}
