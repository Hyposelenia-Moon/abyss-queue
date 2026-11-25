# 排队表编辑器（`abyss-queue/editor/`）

排队表的**写入程序**，就住在本插件里（`editor/`），由插件在加载时挂到机器人自己的 HTTP server 上
（前缀 `/queue`），随机器人一起启停。

本文档里的「**本机**」= 跑着机器人的那台机器：编辑器默认与机器人**同进程**，没有另一份远端服务。

## 谁在改表

| 角色 | 能不能改表 |
|---|---|
| **编辑器**（`editor/`，挂在机器人 HTTP server 的 `/queue`） | ✅ 唯一的写表实现，正式部署只跑这一份 |
| 三路深渊排队插件（机器人） | ❌ 只读：每次现读 `data/queue.json`（无快照、无缓存；`queue.xlsx` 是导出镜像）；写操作经 `editor/service.js` 调编辑器的进程内实例 |
| **独立跑的编辑器**（同一份代码，`node editor/editor.mjs`，可加 `--owner-only`） | ✅ 本机调试 / 回归套件用；正式部署不另起进程（两个写者会抢同一张表，见「同一张表只允许一个写者」） |

## 与插件的关系

编辑器和插件住在一起，但**表格读写、别名归一、身份签名只有一份实现**（复制一套迟早漂移，
那才是会污染数据的做法）。编辑器按绝对路径从插件目录加载共用模块：

```
--plugin <插件目录>            显式指定
ABYSS_PLUGIN_DIR=<插件目录>    环境变量
默认                           自己所在的插件根（editor/ 的上一级）
```

被复用的部分：`model/`（表格读写 + 绑定存储 + 身份签名）、`modules/`（queue 定位 / 进度）、
`components/`（配置 / 字体 / 别名 / 渲染）、`test/_helper.mjs`（断言脚手架）。

本目录自己的文件（入口薄、按职责分模块）：

| 文件 | 职责 |
|------|------|
| `editor.mjs` | 装配根：配置 → 服务单例（表 / 绑定 / 名单 / 版本 / 额度 / 审计）→ **HTTP 路由分发**（写动作在 `actions.js`、读投影在 `queue-view.js`） |
| `ctx.js` | 运行时句柄袋：装配根写（`installCtx`）、其余模块只读（避免 import 成环） |
| `defs.js` | 列定义、状态词、榜单简称、公共队列、冷却等纯常量 |
| `status.js` | 完成情况串的解析与生成（含攻炼复合串、剧诗 / 螺旋周期态、改名计划） |
| `rows.js` | 行校验与差异：必填 / 选项、两条红线、行指纹与冲突、改动记录造单 |
| `cycle-ledger.js` | 周期清榜账本与 intent：同一轮不清第二次、手动收录名单 |
| `anchors.js` | 主播区：可选值（名单 ∪ 表里在用的值）与别名单 |
| `queue-view.js` | 读投影：`buildPayload`（页面要的整份数据）与排队文案 / 胶囊等展示小工具 |
| `actions.js` | 写动作：保存、插队呼叫、整理、清榜、上传 / 恢复等（`createActions`） |
| `config.js` | 启动配置：所有路径与开关的唯一口径 + fail-closed 拒绝启动 |
| `cli.js` | argv 解析原语（`flag` / `boolFlag`）与日志重定向 |
| `plugin-root.js` | 插件根定位 + `shared()`（从插件目录加载共用模块） |
| `util.js` | JSON 读写与日期小工具（多模块共用） |
| `acl.js` | 白名单（**只认 QQ**）+ 完成情况锁（连昵称与表指纹一起记） |
| `ownership.js` | 归属状态：绑定/锁与表的对账（按昵称重建、绝不按旧行号认人）、审计、按 QQ 重建 |
| `audit.js` | 写操作的请求级审计：一行一条（qq / action / status + 路由补的细节），出口由宿主注入 |
| `roster.js` | 群成员名单：昵称候选 + 按 QQ 取当前名片 |
| `versions.js` | 历史版本与归档：命名口径（含下载校验的正则）、滚动保留、每日/换月归档 |
| `http/respond.js` | HTTP 收发基本动作：回 JSON、读请求体（4MB / 32MB 上限）、取口令、`FEATURES` |
| `http/auth.js` | 鉴权：口令、身份签名、主人与白名单（`createAuth`） |
| `http/session.js` | 管理员 24 小时会话 cookie（`createSession`，只认签名密钥） |
| `http/link-guard.js` | 填表口令兑换的防枚举：按来源 IP 限流、失败冷却；成功不计数、不作废 |
| `http/pages.js` | 三个提示页（需口令 / 仅主人 / 链接失效）+ 页脚（`createPages`） |
| `editor.html` | 前端（单文件、无构建；内联脚本与样式） |
| `test/` | 本目录的回归套件（41 个：会写表的走黑盒 spawn 编辑器 + 打 HTTP，页面状态类的走 node:vm 假 DOM） |

## 怎么起（两种模式，同一份代码）

**① 随机器人跑（正式部署 · 默认）**：`modules/editor-host.js` 在插件加载时把它挂到 **bot 自己的 HTTP server**
上，前缀 `/queue`；状态文档固定 `<插件根>/data/queue.json`（同目录 `queue.xlsx` 是它的导出镜像），口令 / 签名密钥 / 管理口令由宿主从
`config/config.yaml` 的 `editor` 段注入（`editor/injected.js`）。**没有单独的进程要维护、也没有 `editor-path.txt`**：
bot 起它起、bot 退它退。nginx 把 `/queue` 指到 **bot 的端口**（`config/config.yaml` 的 `server.port`）。

插件与编辑器之间**没有 HTTP**：插件读表直接读同一个 `data/queue.json`（`model/local.js` 投影成 models，每次现读），
写操作（名单同步 / 每日整理 / 插队 / 退队 / 完成情况…）经 `editor/service.js` 的注册表
（`registerEditorService` / `getEditorService`）直调编辑器进程内的同一份实现（同一个 `JsonTable`、同一套锁、
版本与审计）。编辑器没挂载时 `getEditorService()` 为 `null`，插件直接报错，不做 HTTP 兜底。

**② 独立跑（本机调试 / 回归套件）**：`node editor/editor.mjs …`，参数见下表。

**数据目录固定为 `<插件根>\data`**，不可配置、也**不允许离开插件目录**（本机例：
`D:\Program Files\Yunzai\Yunzai\plugins\abyss-queue\data`）——表、日志、白名单、版本与绑定都在这里。
`data/` 已被 git 忽略，所以 `#更新排队` 只动代码不动数据。
编辑器按自身位置（`editor.mjs` 的上一级）自定位插件根：**从哪儿起，数据就落在哪儿的 `data/` 下**。

```bash
# 独立调试：自己挑表、自己给口令（正式部署不用这么起）
node editor.mjs --file "<Yunzai>\plugins\abyss-queue\data\queue.xlsx" --port 7788 \
  --token <访问口令> --sign-key <签名密钥>
# 浏览器打开 http://127.0.0.1:7788/queue/?k=<口令>（要主人身份就再带 &u=<QQ>&s=<签名>）
```

### 数据落点：生产 vs 测试（只有这一处例外）

| 模式 | 怎么进 | `--file` / 数据文件 |
|---|---|---|
| **生产**（默认） | 什么都不设 | `--file`（或 `ABYSS_EDITOR_FILE`）**必须**落在 `<插件根>\data` 里；否则**报错退出**（不去纠正到别处继续跑）。`ABYSS_EDITOR_*_FILE` / `_DIR` 与 `--admins` 一律**忽略**（记 warn），绑定 / 白名单 / 锁 / 群名单 / `versions/` / `archives/` 全部派生自 `<插件根>\data` |
| **测试**（回归套件） | `ABYSS_EDITOR_TEST_PATHS=1` | 允许指到系统临时目录，数据文件派生自"表格所在目录"。**生产部署绝不要设它** |

启动日志会把「数据目录」「表文件」「状态文档」三行打出来，核对这几行就知道落点对不对（状态文档是事实源，表文件是导出镜像）。

**挂载与鉴权（随机器人跑那一路）**：宿主在 `http.Server` 这一层接管——`/queue` 与它下面的路径交给编辑器，
其余原样交回框架（`/queueX` 不算）。**不经框架的 express 中间件**是有原因的：框架先装了四个 body parser
且没有路径过滤，编辑器又自己读原始请求体，挂在中间件之后会**收不到 body 事件、请求永久挂起**。
也正因为不走 express，`/queue` **不过框架的 `server.auth`**——它的鉴权就是编辑器自己的 `?k=` 与身份签名。
**挂载之后不要再往那个 `http.Server` 上直接 `server.on("request")`**（框架代码与别的插件都不行）：
Node 会把同一条请求发给所有监听器，后来的那个会与编辑器同时处理 `/queue`（写接口双重处理、双写竞态、
`ERR_HTTP_HEADERS_SENT`）。分发器只会"响应写完了就不再往后转"，挡不住后来者——这条只能靠纪律，
要加请求级钩子就挂 express 中间件。


## 参数

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--file <xlsx>` | `ABYSS_EDITOR_FILE` | 要编辑的表格；**生产必须落在 `<插件根>\data` 内**，否则拒绝启动 |
| `--plugin <dir>` | `ABYSS_PLUGIN_DIR` | 插件目录（共用模块来源，同时决定数据目录 = `<插件根>\data`） |
| `--port` | `ABYSS_EDITOR_PORT` | 监听端口，默认 7788 |
| `--bind` | `ABYSS_EDITOR_BIND` | 监听地址，默认 127.0.0.1（独立跑并放到反向代理后面时用 0.0.0.0，靠 nginx/口令兜着） |
| `--token` | `ABYSS_EDITOR_TOKEN` | **访问口令**：决定"能不能用这个服务"，会出现在每个人的链接里 |
| `--sign-key` | `ABYSS_EDITOR_SIGN_KEY` | **身份签名密钥**：决定"你是谁"，不进链接；不配则退回用口令签（等于谁拿到链接都能伪造身份，正式部署必须单独配） |
| `--admin-token` | `ABYSS_EDITOR_ADMIN_TOKEN` | 管理口令：用它打开 `?a=<口令>` 维护白名单（主人的备用入口） |
| `--owner-only` | `ABYSS_EDITOR_OWNER_ONLY` | **只有主人能打开**（独立跑时用；`/api/version`、`/api/meta`、`/healthz` 仍只凭口令放行） |
| `--owner` | `ABYSS_EDITOR_OWNER` | 主人名单（**只认 QQ**，逗号分隔），与白名单文件里的 `owner` 合并；写群昵称等于没写（会进"不是权限"审计） |
| `--admins <json>` | `ABYSS_EDITOR_ADMINS_FILE` | 白名单文件；生产固定 `<插件根>\data\abyss-editor-admins.json`（**仅测试模式可改**） |
| `--cloud <url>` | `ABYSS_EDITOR_CLOUD` | 另一份部署的编辑器地址（可选；配了才有「上传覆盖云端」按钮。正式部署用不到） |
| `--roster-qq` | `ABYSS_EDITOR_ROSTER_QQ` | 允许推送群成员名单的机器人身份，默认 `0`。**别配成真人的 QQ**（这个身份在路由闸上有一条豁免，理由见 `editor/DEPLOY.md` 第 5 条） |
| `--versions-keep` | `ABYSS_EDITOR_VERSIONS_KEEP` | 历史版本保留份数，默认 20（0 = 不存版本） |
| `--archive-days` | `ABYSS_EDITOR_ARCHIVE_DAYS` | 每日归档保留天数，默认 7（只留最近几天的起始状态） |
| `--archives-keep` | `ABYSS_EDITOR_ARCHIVES_KEEP` | 每月归档保留月数，默认 12 |
| `--changes-keep` | `ABYSS_EDITOR_CHANGES_KEEP` | 改动记录（留痕）保留条数，默认 2000（见「改动记录」一节） |
| `--quota-per-save` / `--quota-window-ms` / `--quota-per-window` | `ABYSS_EDITOR_QUOTA_PER_SAVE` / `_WINDOW_MS` / `_PER_WINDOW` | 群友改"别人的行"的额度：一次 3 位 / 窗口 10 分钟 / 窗口内 10 位（见「权限」） |
| `--roster-trust-ms` | `ABYSS_EDITOR_ROSTER_TRUST_MS` | 群名单**当权限用**的时长，默认 48 小时（超过就不据此拒人） |
| `--mount` | `ABYSS_EDITOR_MOUNT` | 挂在子路径时的前缀，默认 `/queue` |
| `--log` | `ABYSS_EDITOR_LOG` | 把日志写进文件（本机启动器用） |
| — | `ABYSS_EDITOR_TEST_PATHS=1` | **只给回归套件**：允许数据落在插件外（临时目录）。生产不要设 |
| — | `ABYSS_EDITOR_{VERSIONS,ARCHIVES}_DIR`、`_LOCKS_FILE`、`_ROSTER_FILE` | 路径覆盖；**只在 `ABYSS_EDITOR_TEST_PATHS=1` 下生效** |
| — | `ABYSS_EDITOR_ADMINS` / `ABYSS_EDITOR_OWNER` / `ABYSS_EDITOR_ROSTER_QQ` | 是**名单/身份**不是路径，任何模式下都生效 |

> 上面这几个数值参数都是「参数优先、环境变量兜底」，非法或负数回落到 `editor/config.js` 的 `DEFAULTS`；
> 默认值也只有 `DEFAULTS` 一个出处。配置模板 / 校验 / 锅巴字段仍留待后续统一。

## 接口

> **插件不再调用下面的写接口**：`#插队`、每日整理、名单同步、退队、完成情况等动作都走
> `editor/service.js` 的进程内注册表，直接调编辑器同一份 `Table` 与锁；这些 HTTP 路由仍保留给
> 编辑器页面与独立调试，权限判据也在路由层（进程内调用不经过它）。

| 路径 | 说明 |
|---|---|
| `GET /` | 未授权时给固定入口页：无需口令也能打开，输入群里的 6 位数字填表口令后由 `/api/link-code` 换回完整链接；`--owner-only` 时非主人看到"只有主人能打开"。已授权时给主页面，主页面 boot 自己也兑换 `#code`（浏览器里存过口令 / 管理员 cookie 时点群内短链不会再用上一次的身份） |
| `GET /api/link-code?code=` | 公开接口：用 5 分钟内的填表口令换回完整链接；同一条口令 5 分钟内可被群里多人反复兑换（成功不计数、不作废）；失效/不对一律 410，同一来源 IP 10 分钟内失败 10 次后冷却 5 分钟（429 + `retry-after`）。无需 `k` |
| `GET <前缀>` | **规范化尾斜杠**：`/queue` → 301 `/queue/`。页面里的请求都是相对路径（`api/*`、`font/*`），地址栏不以 `/` 结尾时它们会解析到站根、全部 404 |
| `GET /api/avatar?qq=` | **公开接口**（口令校验之前就能到达）：`<img src>` 带不了 `x-abyss-*` 请求头。QQ 只认 5~12 位数字；先取群名单里存的那份头像、没有就按 QQ 拼 `q.qlogo.cn`，上游主机白名单只放 `q.qlogo.cn` / `p.qlogo.cn` / `api.dicebear.com`；内存缓存 30 分钟（≤400 条）、回 `cache-control: private, max-age=3600`；取不到 404（页面回落金色圆章 + 昵称首字）。CSP 仍是 `img-src 'self' data:` |
| `GET /healthz?k=` | 版本、字段、功能清单、口令/签名密钥/白名单/群名单状态（探活与一致性自检用） |
| `GET /api/data?k=&u=&s=` | 按身份裁剪后的数据（界面用），含群昵称候选。**每一行都带 `fp`（行指纹）**：页面存着它、保存时当 `base` 带回来，服务端据此判行级冲突（见「实时刷新与行级冲突」） |
| `GET /api/version?k=` | 当前表指纹（只读；推表前的冲突检测用）。**`?fast=1` 给页面轮询**：按 `mtime:size` 认一版，没变就回上次算出来的（不读盘、不算 sha256）；不带 `fast` 照旧现读现算 |
| `GET /api/meta?k=` | 页面元信息：`footer`（插件配置 `footer.html` 的自由 HTML + 自动追加的规范署名行，空串 = 不显示页脚）、版本、历史版本份数。**只凭口令**，不含表格数据 |
| `POST /api/save` · `POST /api/anchors` | 保存数据行 / 主播列表；两者都可带 `version`（页面读到的那一版表指纹），对不上返回 **409**，一个字都不写。成员保存**还可以带 `base`**（`{行号 → 行指纹}`，由 `/api/data` 下发）⇒ 改判**行级冲突**（见「实时刷新与行级冲突」）。主播列表另可带 `added: [{ values }]` 新增主播（见「主播列表：谁改、怎么加」）。**回执里可能多三样**（都只在这件事真的发生时才出现）：`compacted`（删行后把下面的行提上来，见「删行压紧」）、`tidied` 与 `nickSync`（改了完成情况就立刻整理 + 昵称检测，见「整理」）、以及 **`rowMap`**（`{老行号: 新行号}`——搬过行时页面的草稿键要按它搬） |
| `POST /api/move-row` | **插队**（HTTP 路由；插件侧 `#插队` 现在走 `editor/service.js` 的进程内 `moveRow`，见下节）：`{ sheet, row, mode: "queue-front", nick? }`。路由只认**白名单管理员 / 主人**，本人与访客一律 403；进程内调用只由插件按发起者身份判一次 |
| `GET /api/versions` · `POST /api/restore {id}` | 历史版本列表 / 回退到某个版本（**主人 / 管理口令 / 白名单管理员**；回退前自动存一份当前状态，可再退回来） |
| `GET /api/changes?limit=` | **改动记录**（留痕，见下节）：谁在什么时候改了哪一行的哪个字段。**有身份就能看**——管理员看全部，本人看"自己发的 + 改到我自己那些行的"，访客 403 |
| `GET /api/download?id=` | 下载某一份历史版本 / 归档（同一档权限；归档可以随身带走） |
| `POST /api/upload` | 用上传的 xlsx 覆盖当前表（主人；「上传覆盖云端」的目标端走这里） |
| `POST /api/push-cloud` | 独立跑的本机编辑器专用：把本机这份表推给 `--cloud` 指向的另一份部署覆盖（正式部署用不到） |
| `GET/POST /api/ownership` | **归属状态**（主人；见下节）：查看 QQ → 行 的可信度 / 按当前表重建 |
| `POST /api/roster` | 机器人推群成员名单（HTTP 路由；插件现在进程内直调 `service.roster`）。路由只认机器人身份或主人：候选 + 按 QQ 对账 |
| `POST /api/tidy` | **每日整理**（HTTP 路由；插件现在经 `model/editor-commands.js` 进程内直调 `service.tidy`，见下节）：`{ sheet? }`，不给 `sheet` 就整理所有榜。路由只认**机器人身份或主人**；已经是有序的榜一个字都不写 |
| `GET/POST /api/admins` | 白名单维护（主人或管理口令） |
| `GET /font/cn.woff` | 编辑器页面的中文字体（原神字体；随源码在 `resources/common/font/`，按固定路径直吐，不下载不缓存） |
| `GET /favicon.ico` | 网页标签页图标（读 `resources/image/HuTao_LeLouvre_256.ico`，随插件入库；**先于口令校验**——浏览器请求它时不会带 `?k=`；两份都缺才 404，不影响页面）。页面里的 href 由服务端按**请求带的挂载前缀**填（`editor.html` 写 `__MOUNT__/favicon.ico`）：挂在 `/queue` 下时是 `/queue/favicon.ico`，**不能指站根**——那条路径不归编辑器，浏览器只会拿到框架的 404 |

## 分册（按需阅读）

| 想了解 / 要改的东西 | 先读 |
|---|---|
| 页面结构、缩放、表格与已完成栏、主播区、页脚、窄屏 | [`../docs/编辑器-页面.md`](../docs/编辑器-页面.md) |
| 身份与权限、归属对账、改动记录、实时刷新与行级冲突 | [`../docs/编辑器-权限与归属.md`](../docs/编辑器-权限与归属.md) |
| 身份只来自链接、权限只问群名单、5 分钟时间窗、群内短码、退群整理 | [`../docs/编辑器-链接与认领.md`](../docs/编辑器-链接与认领.md) |
| 插队、整理、主播列表、草稿与自动保存、数据安全 | [`../docs/编辑器-写入与安全.md`](../docs/编辑器-写入与安全.md) |
| 架构、挂载与安全口径（规范面） | [`../docs/编辑器.md`](../docs/编辑器.md) |

## 测试

```bash
# 在插件根目录跑：同时包含插件与编辑器的全部套件
node test/run.mjs
# 编辑器自己的套件（41 个）：editor/test/{acl-roles,anchor-add,anchor-version,attack-status-scope,
#   auto-anchor,autosave,body-limit,changes,check-done,client-state,comma-status,config-flags,cycle-clear,
#   data-confinement,delete-compact,editor,empty-nick,fail-closed,identity,link-code,link-guard,link-identity,
#   live-refresh,lock-compact,member-row-area,mount,move-row,owner-only,ownership,quota-guard,
#   reload-drafts,reorder,roster,row-ownership,save-conflict,sign-key,status-rename,table-swap,tidy,
#   versions,write-queue}.test.mjs
# 拿不到真实表格时会自动跳过（可用 XLSX_PATH 指一份 xlsx；测试端到端建议 ABYSS_TEST_SYNTHETIC=1 用合成样本）
```

所有**会起编辑器进程**的套件都显式设 `ABYSS_EDITOR_TEST_PATHS=1`（它们的工作区在系统临时目录），
插件侧套件则由 `test/env.mjs` 统一设 `ABYSS_QUEUE_TEST_PATHS=1`；
"生产口径只认插件内的 data"这条规则由 `editor/test/data-confinement.test.mjs` 钉住。

## 部署

见 [`DEPLOY.md`](./DEPLOY.md)（随机器人跑、nginx `location /queue` 的写法、口令与签名密钥、健康检查、
权限矩阵与换月流程）。要点：**把插件目录一起带上**（共用模块），并**务必单独配签名密钥**。
