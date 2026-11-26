/** 运行期句柄：装配根（`editor.mjs`）算好之后放进来，其余模块**只读** */
export const ctx = {
  config: null,
  table: null,
  store: null,
  versions: null,
  ownership: null,
  acl: null,
  roster: null,
  changes: null,
  quota: null,
  alerts: null,
}

export const installCtx = patch => Object.assign(ctx, patch)
