/**
 * 日志出口（bot 侧适配器）
 *
 * 框架会把 logger 挂在全局；脱离框架跑（离线套件）时回落到 console。
 *
 * 放在 `components/` 而不是 `lib/`：它依赖 bot 进程里的全局 `logger`，
 * 编辑器那类第二入口不该、也不会加载它。
 */
export const log = (level, ...args) => {
  if (typeof logger !== "undefined" && logger?.[level]) logger[level](...args)
  else console.log(...args)
}
