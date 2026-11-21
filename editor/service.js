/**
 * 编辑器动作的进程内注册表
 *
 * 为什么是"注册"而不是"装配"：表的写权必须只有一份。编辑器启动时把自己的 live 实例
 * （同一个 `Table`、同一套锁/版本/审计）注册进来，插件从 `getEditorService()` 取用——
 * 若插件自己 new 一套，就会出现两个写者、两套锁，那是比 HTTP 更危险的情况。
 *
 * 使用方式：
 *   - 编辑器侧（`editor/editor.mjs`）：装配完成后 `registerEditorService({ moveRow, ... })`
 *   - 插件侧（`model/*.js`）：`const svc = getEditorService()`，为空说明编辑器没在进程内挂载
 */

/** @type {null | Record<string, Function>} */
let service = null

/**
 * 注册（可重复调用，后注册的生效——等价于"编辑器重启后换了一份实例"）
 * @param {Record<string, Function>} api
 */
export function registerEditorService(api) {
  service = api && typeof api === "object" ? api : null
  return service
}

/** 取当前注册的实例；未挂载时为 null */
export function getEditorService() {
  return service
}

/** 测试用：清空注册，回到"未挂载" */
export function resetEditorService() {
  service = null
}
