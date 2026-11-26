/** 日志出口（bot 侧适配器） */

const LEVELS = new Set(["info", "warn", "error"])

export const log = (level, ...args) => {
  if (typeof logger !== "undefined" && logger?.[level]) return logger[level](...args)
  console[LEVELS.has(level) ? level : "info"](...args)
}
