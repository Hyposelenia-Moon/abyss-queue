# 排队表编辑器（`abyss-queue/editor/`）

排队表的**写入程序**，就住在本插件里，由插件在加载时挂到机器人自己的 HTTP server 上（前缀 `/queue`），
随机器人一起启停。「**本机**」= 跑着机器人的那台机器：编辑器与机器人**同进程**，没有另一份远端服务。

## 谁在改表

| 角色 | 能不能改表 |
|---|---|
| **编辑器**（挂在机器人 HTTP server 的 `/queue`） | ✅ 唯一的写表实现，正式部署只跑这一份 |
| 三路深渊排队插件（机器人） | ❌ 只读：每次现读 `data/queue.json`（`queue.xlsx` 是导出镜像）；写操作经 `editor/service.js` 调编辑器的进程内实例 |
| **独立跑的编辑器**（同一份代码，`node editor/editor.mjs`，可加 `--owner-only`） | ✅ 本机调试 / 回归套件用；正式部署不另起进程（两个写者会抢同一张表） |

## 与插件的关系

编辑器和插件住在一起，但**表格读写、别名归一、身份签名只有一份实现**（复制一套迟早漂移，那才是会污染数据的做法）。
编辑器按绝对路径从插件目录加载共用模块：`--plugin <插件目录>` / `ABYSS_PLUGIN_DIR` / 默认 `editor/` 的上一级。
复用的部分：`model/`（表格读写 + 绑定存储 + 身份签名）、`modules/`（queue 定位 / 进度）、`components/`（配置 / 字体 / 别名 / 渲染）。

本目录自己的文件按职责分（完整目录树见 [`../docs/开发说明.md`](../docs/开发说明.md)）：

| 文件 | 职责 |
|------|------|
| `editor.mjs` | 装配根：配置 → 服务单例（表 / 绑定 / 名单 / 版本 / 额度 / 审计）→ 装配 `ctx` → 注入 handler |
| `http/server.js` | 路由分发：`createHandler(deps)` 按路径把请求交给对应处理段（依赖由装配根注入） |
| `ctx.js` | 运行时句柄袋：装配根写（`installCtx`）、其余模块只读（避免 import 成环） |
| `defs.js` / `status.js` / `rows.js` | 常量与列定义 / 完成情况串解析 / 行校验、行指纹与冲突 |
| `anchors.js` / `table-ops.js` / `roster-sync.js` | 主播区 / 表操作 / 名单对账（各带自己的写临界区） |
| `cycle-ledger.js` / `versions.js` / `ownership.js` / `acl.js` | 清榜账本 / 历史版本 / 归属对账 / 白名单与完成情况锁 |
| `queue-view.js` / `actions.js` | 读投影（`buildPayload`）/ 写动作（`createActions`）。`queue-view.js` 的推荐度档位表来自 `components/render.js`——那个文件是**纯计算**（只 import 队列 / 别名 / 文本 / 进度，不引模板引擎、无副作用），别往里加渲染或 IO |
| `config.js` / `cli.js` / `plugin-root.js` / `util.js` / `audit.js` / `roster.js` | 启动配置与 fail-closed / argv / 插件根与 `shared()` / JSON 与日期工具 / 审计 / 群名单 |
| `http/respond.js` · `auth.js` · `session.js` · `link-guard.js` · `pages.js` | 收发与限额 / 鉴权 / 管理员会话 / 短码防枚举 / 提示页与页脚 |
| `editor.html` | 前端（单文件、无构建；内联脚本与样式） |
| `test/` | 本目录的回归套件（34 个：会写表的起编辑器进程打 HTTP，页面状态类的走 node:vm 假 DOM） |

## 怎么起（两种模式，同一份代码）

**① 随机器人跑（正式部署 · 默认）**：`modules/editor-host.js` 在插件加载时把它挂到 **bot 自己的 HTTP server** 上，
前缀 `/queue`；状态文档固定 `<插件根>/data/queue.json`（同目录 `queue.xlsx` 是导出镜像），
口令 / 签名密钥 / 管理口令由宿主从 `config/config.yaml` 的 `editor` 段注入。**没有单独的进程要维护、也没有 `editor-path.txt`**：
bot 起它起、bot 退它退。nginx 把 `/queue` 指到 **bot 的端口**（`server.port`）。

插件与编辑器之间**没有 HTTP**：读表直接读同一个 `data/queue.json`，写操作（名单同步 / 每日整理 / 插队 / 退队 /
完成情况…）经 `editor/service.js` 的注册表（`registerEditorService` / `getEditorService`）直调进程内同一份实现
（同一个 `JsonTable`、同一套锁、版本与审计）。编辑器没挂载时 `getEditorService()` 为 `null`，插件直接报错，不做 HTTP 兜底。

**② 独立跑（本机调试 / 回归套件）**：`node editor/editor.mjs …`，参数见下表。

**数据目录固定为 `<插件根>/data`**，不可配置、也不允许离开插件目录——表、日志、白名单、版本与绑定都在这里。
`data/` 已被 git 忽略，所以框架的 `#更新` 只动代码不动数据。编辑器按自身位置（`editor.mjs` 的上一级）自定位插件根：
**从哪儿起，数据就落在哪儿的 `data/` 下**。

```bash
# 独立调试：自己挑表、自己给口令（正式部署不用这么起）
node editor.mjs --file "<Yunzai>/plugins/abyss-queue/data/queue.xlsx" --port 7788 --token <口令> --sign-key <密钥>
# 浏览器打开 http://127.0.0.1:7788/queue/?k=<口令>（要主人身份就再带 &u=<QQ>&s=<签名>）
```

### 数据落点：生产 vs 测试（只有这一处例外）

| 模式 | 怎么进 | `--file` / 数据文件 |
|---|---|---|
| **生产**（默认） | 什么都不设 | `--file`（或 `ABYSS_EDITOR_FILE`）**必须**落在 `<插件根>/data` 里，否则**报错退出**；`ABYSS_EDITOR_*_FILE` / `_DIR` 与 `--admins` 一律**忽略**（记 warn），绑定 / 白名单 / 锁 / 群名单 / `versions/` / `archives/` 全部派生自 `<插件根>/data` |
| **测试**（回归套件） | `ABYSS_EDITOR_TEST_PATHS=1` | 允许指到系统临时目录。**生产部署绝不要设它** |

启动日志会打出「数据目录」「表文件」「状态文档」三行，核对这几行就知道落点对不对。

**挂载与鉴权（随机器人跑那一路）**：宿主在 `http.Server` 这一层接管——`/queue` 与它下面的路径交给编辑器，其余原样交回框架
（`/queueX` 不算）。**不经框架的 express 中间件**是有原因的：框架先装了四个 body parser 且没有路径过滤，编辑器又自己读原始
请求体，挂在中间件之后会**收不到 body 事件、请求永久挂起**。也正因为不走 express，`/queue` **不过框架的 `server.auth`**——
它的鉴权就是编辑器自己的 `?k=` 与身份签名。**挂载之后不要再往那个 `http.Server` 上直接 `server.on("request")`**：
Node 会把同一条请求发给所有监听器，后来的那个会与编辑器同时处理 `/queue`（双写竞态、`ERR_HTTP_HEADERS_SENT`）；
分发器只会"响应写完了就不再往后转"，挡不住后来者——要加请求级钩子就挂 express 中间件。

## 参数

独立跑时的参数（**正式部署里这些都不存在**，凭证由宿主注入）：

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--file <xlsx>` | `ABYSS_EDITOR_FILE` | 要编辑的表格；**生产必须落在 `<插件根>/data` 内**，否则拒绝启动 |
| `--plugin <dir>` | `ABYSS_PLUGIN_DIR` | 插件目录（共用模块来源，同时决定数据目录） |
| `--port` / `--bind` / `--mount` | `ABYSS_EDITOR_PORT` / `_BIND` / `_MOUNT` | 监听端口（默认 7788）/ 地址（默认 127.0.0.1）/ 挂载前缀（默认 `/queue`） |
| `--token` / `--sign-key` / `--admin-token` | `ABYSS_EDITOR_TOKEN` / `_SIGN_KEY` / `_ADMIN_TOKEN` | 访问口令 / 身份签名密钥 / 管理口令（三者互不相同；签名密钥不配则退回用口令签，正式部署必须单独配） |
| `--owner-only` / `--owner` / `--admins` | `ABYSS_EDITOR_OWNER_ONLY` / `_OWNER` / `_ADMINS_FILE` | 只有主人能打开 / 主人 QQ 名单（只认 QQ）/ 白名单文件（生产固定 `data/abyss-editor-admins.json`） |
| `--versions-keep` / `--archive-days` / `--archives-keep` / `--changes-keep` | `ABYSS_EDITOR_*` | 版本份数 20 / 每日归档 7 天 / 每月归档 12 月 / 改动记录 2000 条 |
| `--quota-per-save` / `--quota-window-ms` / `--quota-per-window` | `ABYSS_EDITOR_QUOTA_*` | 群友改别人行的额度：一次 3 位 / 10 分钟 / 窗口内 10 位 |
| `--roster-trust-ms` / `--roster-qq` | `ABYSS_EDITOR_ROSTER_TRUST_MS` / `_ROSTER_QQ` | 名单当权限用的时长（48 小时）/ 允许推名单的机器人身份（别配成真人 QQ） |
| `--cloud` / `--log` | `ABYSS_EDITOR_CLOUD` / `_LOG` | 另一份部署的地址（可选，配了才有「上传覆盖云端」）/ 日志文件 |
| — | `ABYSS_EDITOR_TEST_PATHS=1` | **只给回归套件**：允许数据落在插件外。生产不要设 |

数值参数「参数优先、环境变量兜底」，非法或负数回落到 `editor/config.js` 的 `DEFAULTS`（默认值只有这一个出处）。

## 接口

> **插件不再调用下面的写接口**：`#插队`、每日整理、名单同步、退队、完成情况等动作都走 `editor/service.js` 的进程内注册表，
> 直接调编辑器同一份表与锁；这些 HTTP 路由仍保留给页面与独立调试，权限判据在路由层（进程内调用不经过它）。

| 路径 | 说明 |
|---|---|
| `GET /` | 未授权时给固定入口页（输入群里 6 位口令换完整链接）；已授权时给主页面，boot 自己也兑换 `#code` |
| `GET /api/link-code?code=` | 公开：用 5 分钟内的口令换回完整链接；**同一条口令可被多人反复兑换（成功不计数、不作废）**；失效 / 不对一律 410，同一 IP 10 分钟内失败 10 次后冷却 5 分钟（429 + `retry-after`） |
| `GET <前缀>` | 规范化尾斜杠：`/queue` → 301 `/queue/`（页面里都是相对路径，不以 `/` 结尾会全部 404） |
| `GET /api/avatar?qq=` | **公开**（`<img src>` 带不了 `x-abyss-*` 头）：QQ 只认 5~12 位数字；先取名单里那份头像，没有就按 QQ 拼 `q.qlogo.cn`；上游主机白名单；内存缓存 30 分钟；取不到 404（页面回落金圆章 + 首字）。CSP 仍 `img-src 'self' data:` |
| `GET /healthz?k=` | 版本、字段、功能清单、口令 / 签名密钥 / 白名单 / 群名单状态 |
| `GET /api/data?k=&u=&s=` | 按身份裁剪后的数据，含群昵称候选；**每行带 `fp`**（页面存着当 `base` 带回来判行级冲突）；推荐度档位表 `recTiers` 与每张主播卡的 `recRank` / `recTier` 来自 `components/render.js`（与 `#主播` 出图同一口径） |
| `GET /api/version?k=` | 当前表指纹；`?fast=1` 给页面轮询（按 `mtime:size` 认一版，没变就不读盘） |
| `GET /api/meta?k=` | 页面元信息：`footer`（自由 HTML + 自动追加的署名行）、版本、历史版本份数；不含表格数据 |
| `POST /api/save` · `POST /api/anchors` | 保存数据行 / 主播列表；可带 `version`（对不上 409，一个字不写）；成员保存可带 `base` ⇒ 行级冲突；回执可能多 `compacted` / `tidied` / `nickSync` / `rowMap`（只在这件事真发生时才出现） |
| `POST /api/move-row` | 插队 `{ sheet, row, mode: "queue-front", nick? }`；路由只认管理员 / 主人，本人与访客 403 |
| `GET /api/versions` · `POST /api/restore {id}` | 历史版本列表 / 回退（回退前自动存一份当前状态） |
| `GET /api/changes?limit=` | 改动记录：管理员看全部，本人看"自己发的 + 改到我自己那些行的"，访客 403 |
| `GET /api/download?id=` | 下载某一份历史版本 / 归档 |
| `POST /api/upload` / `POST /api/push-cloud` | 用上传的 xlsx 覆盖当前表（主人）/ 独立跑的本机编辑器推给 `--cloud`（正式部署用不到） |
| `GET/POST /api/ownership` | 归属状态（主人）：查看 QQ → 行的可信度 / 按当前表重建 |
| `POST /api/roster` · `POST /api/tidy` | 推群成员名单 / 每日整理（插件现在进程内直调 `service.roster` / `service.tidy`，路由保留给页面与调试） |
| `GET/POST /api/admins` | 白名单维护（主人或管理口令） |
| `GET /font/cn.woff` · `GET /favicon.ico` | 页面字体（随源码入库，按固定路径直吐）/ 标签页图标（**先于口令校验**；href 按请求带的挂载前缀填） |

## 分册（按需阅读）

| 想了解 / 要改的东西 | 先读 |
|---|---|
| 页面结构、缩放、表格与已完成栏、主播区、页脚、窄屏 | [`../docs/编辑器-页面.md`](../docs/编辑器-页面.md) |
| 身份与权限、归属对账、改动记录、实时刷新与行级冲突 | [`../docs/编辑器-权限与归属.md`](../docs/编辑器-权限与归属.md) |
| 身份只来自链接、权限只问群名单、5 分钟时间窗、群内短码、退群整理 | [`../docs/编辑器-链接与认领.md`](../docs/编辑器-链接与认领.md) |
| 插队、整理、主播列表、草稿与自动保存、数据安全 | [`../docs/编辑器-写入与安全.md`](../docs/编辑器-写入与安全.md) |
| 架构、挂载与安全口径（规范面） | [`../docs/编辑器.md`](../docs/编辑器.md) |

## 测试

在插件根目录 `node test/run.mjs` 会一起跑两侧全部套件（63 套）；编辑器自己的 34 个在 `editor/test/`，
清单与口径**只在 [`../test/README.md`](../test/README.md) 维护**。会起编辑器进程的套件都显式设
`ABYSS_EDITOR_TEST_PATHS=1`；「生产口径只认插件内的 data」由 `editor/test/data-confinement.test.mjs` 钉住。

## 部署

见 [`DEPLOY.md`](./DEPLOY.md)（随机器人跑、nginx `location /queue` 的写法、口令与签名密钥、健康检查、权限矩阵与换月流程）。
要点：**把插件目录一起带上**（共用模块），并**务必单独配签名密钥**。