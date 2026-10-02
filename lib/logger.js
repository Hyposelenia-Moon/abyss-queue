/**
 * 日志出口（纯工具，不依赖 Yunzai 分层）
 *
 * 框架会把 logger 挂在全局；脱离框架跑（离线套件）时回落到 console。
 */
export const log = (level, ...args) => {
  if (typeof logger !== "undefined" && logger?.[level]) logger[level](...args)
  else console.log(...args)
}
