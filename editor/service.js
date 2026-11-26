/** 编辑器动作的进程内注册表 */

let service = null

export function registerEditorService(api) {
  service = api && typeof api === "object" ? api : null
  return service
}

export function getEditorService() {
  return service
}

export function resetEditorService() {
  service = null
}
