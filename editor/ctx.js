/**
 * 运行期句柄：装配根（`editor.mjs`）算好之后放进来，其余模块**只读**
 *
 * 这里放的是"必须由装配根决定、但很多模块都要用"的那几样：
 * 解析后的配置（`config`）、表与绑定的单例、版本/归属/名单等服务。
 *
 * 为什么要这样一层：这些值在 `editor.mjs` 里是 `await createConfig()` 之后才有的局部常量，
 * 直接让子模块 `import` 会形成环；把它们塞进一个只读对象，装配顺序仍然只有一处、
 * 子模块也不用知道配置怎么来的。
 *
 * **只有 `editor.mjs` 能调用 `installCtx`**，其余模块一律只读；新增句柄要在这里写清楚用途。
 */
export const ctx = {
  /** 解析后的配置（`editor/config.js` 的 `internal.config`：表头、别名、选项、额度和各路径） */
  config: null,
  /** 表模型（读 `openWorkbook()` 的结果；`table()` 每次拿最新） */
  table: null,
  /** 绑定表（`BindStore` 单例） */
  store: null,
  /** 版本快照（`createVersions`） */
  versions: null,
  /** 归属/锁（`createOwnership`） */
  ownership: null,
  /** 白名单与完成情况锁（`createAcl`） */
  acl: null,
  /** 群成员名单（`createRoster`） */
  roster: null,
  /** 变更流水（`createChanges`） */
  changes: null,
  /** 保存额度（`createQuota`） */
  quota: null,
  /** 开播提醒订阅（`createAlerts`） */
  alerts: null,
}

/** 由装配根调用：把算好的句柄放进 `ctx`（可以分批装，只覆盖传进来的键） */
export const installCtx = patch => Object.assign(ctx, patch)