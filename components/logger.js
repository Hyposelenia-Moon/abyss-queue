/**
 * 日志出口（bot 侧适配器）
 *
 * 框架会把 logger 挂在全局；脱离框架跑（离线套件）时回落到 console。
 *
 * 放在 `components/` 而不是 `lib/`：它依赖 bot 进程里的全局 `logger`，
 * 编辑器那类第二入口不该、也不会加载它。
 */

/**
 * 本插件用到的等级：只有 `info` / `warn` / `error`
 *
 * 不用 `debug`（`AGENTS.md` §3.5）：离线套件里没有框架 logger，`debug` 那一档
 * 全靠 console 回退，等于给日志开了个没人管的口子。
 */
const LEVELS = new Set(["info", "warn", "error"])

export const log = (level, ...args) => {
  if (typeof logger !== "undefined" && logger?.[level]) return logger[level](...args)
  /**
   * 为什么保留 console 回退：离线跑时没有框架 logger——套件里只有调用过
   * `test/_helper.mjs` 的 `installFrameworkStubs()` 的才有桩，其它入口（脚本、子进程里的代码）
   * 一个都没有；这里必须留个出口，否则那些日志无处可去。
   *
   * 回退要按等级走 `console.info` / `console.warn` / `console.error`，不能整条落 `console.log`：
   * 后者的输出看不出等级，警告与报错会被降级成普通输出。
   * 未知等级（例如历史调用点上的 `mark`）归到 `info`，既不静默丢弃、也不冒充警告。
   */
  console[LEVELS.has(level) ? level : "info"](...args)
}
