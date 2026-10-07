# 排队表编辑器（`abyss-queue/editor/`）

排队表的**写入程序**，就住在本插件里（`editor/`），随插件一起部署到云服务器。

本文档里的「**云端**」= 部署在云服务器上的这份编辑器；它不是任何第三方在线文档。

## 谁在改表

| 角色 | 能不能改表 |
|---|---|
| **云端编辑器**（云服务器，本目录的代码） | ✅ 唯一的程序写入方 |
| 三路深渊排队插件（机器人） | ❌ 只读：取快照 → 渲染 → 推送（顺带把群成员名单推给云端） |
| **本机编辑器**（同一份代码，开 `--owner-only`） | ✅ 但**只有主人**能打开；本机那份是云端数据的备份/工作副本，改完点「上传覆盖云端」才会回到云端 |

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
| `editor.mjs` | 入口：装配 → 表/绑定实例 → **HTTP 路由与业务**（归属、校验、保存、归档…） |
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
| `http/pages.js` | 三个提示页（需口令 / 仅主人 / 链接失效）+ 页脚（`createPages`） |
| `editor.html` | 前端（单文件、无构建；内联脚本与样式） |
| `test/` | 本目录的回归套件（23 个，黑盒：spawn 编辑器 + 打 HTTP） |

## 怎么起（两种模式，同一份代码）

**① 随机器人跑（正式部署 · 默认）**：`modules/editor-host.js` 在插件加载时把它挂到 **bot 自己的 HTTP server**
上，前缀 `/queue`；表固定 `<插件根>/data/queue.xlsx`，口令 / 签名密钥 / 管理口令由宿主从
`config/config.yaml` 注入（`editor/injected.js`）。**没有单独的进程要维护、也没有 `editor-path.txt`**：
bot 起它起、bot 退它退。nginx 把 `/queue` 指到 **bot 的端口**（`config/config.yaml` 的 `server.port`）。

**② 独立跑（本机调试 / 回归套件）**：`node editor/editor.mjs …`，参数见下表。

**数据目录固定为 `<插件根>\data`**，不可配置、也**不允许离开插件目录**（本机例：
`D:\Program Files\Yunzai\Yunzai\plugins\abyss-queue\data`）——表、日志、白名单、版本与绑定都在这里。
`data/` 已被 git 忽略，所以 `#排队更新` 只动代码不动数据。
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

启动日志会把「数据目录」与「表文件」两行打出来，核对这两行就知道落点对不对。

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
| `--bind` | `ABYSS_EDITOR_BIND` | 监听地址，默认 127.0.0.1（云端部署用 0.0.0.0 并靠 nginx/口令兜着） |
| `--token` | `ABYSS_EDITOR_TOKEN` | **访问口令**：决定"能不能用这个服务"，会出现在每个人的链接里 |
| `--sign-key` | `ABYSS_EDITOR_SIGN_KEY` | **身份签名密钥**：决定"你是谁"，不进链接；不配则退回用口令签（等于谁拿到链接都能伪造身份，正式部署必须单独配） |
| `--admin-token` | `ABYSS_EDITOR_ADMIN_TOKEN` | 管理口令：用它打开 `?a=<口令>` 维护白名单（主人的备用入口） |
| `--owner-only` | `ABYSS_EDITOR_OWNER_ONLY` | **只有主人能打开**（本机编辑器用；`/api/snapshot`、`/healthz` 仍只凭口令放行） |
| `--owner` | `ABYSS_EDITOR_OWNER` | 主人名单（QQ 或群昵称，逗号分隔），与白名单文件里的 `owner` 合并 |
| `--admins <json>` | `ABYSS_EDITOR_ADMINS_FILE` | 白名单文件；生产固定 `<插件根>\data\abyss-editor-admins.json`（**仅测试模式可改**） |
| `--cloud <url>` | `ABYSS_EDITOR_CLOUD` | 云端编辑器地址：配了才有「上传覆盖云端」按钮 |
| `--roster-qq` | `ABYSS_EDITOR_ROSTER_QQ` | 允许推送群成员名单的机器人身份，默认 `0` |
| `--versions-keep` ⏳ | `ABYSS_EDITOR_VERSIONS_KEEP` | 历史版本保留份数，默认 20（0 = 不存版本） |
| `--mount` | `ABYSS_EDITOR_MOUNT` | 挂在子路径时的前缀，默认 `/queue` |
| `--log` | `ABYSS_EDITOR_LOG` | 把日志写进文件（本机启动器用） |
| — | `ABYSS_EDITOR_TEST_PATHS=1` | **只给回归套件**：允许数据落在插件外（临时目录）。生产不要设 |
| — | `ABYSS_EDITOR_{VERSIONS,ARCHIVES}_DIR`、`_LOCKS_FILE`、`_ROSTER_FILE` | 路径覆盖；**只在 `ABYSS_EDITOR_TEST_PATHS=1` 下生效** |
| — | `ABYSS_EDITOR_ADMINS` / `ABYSS_EDITOR_OWNER` / `ABYSS_EDITOR_ROSTER_QQ` | 是**名单/身份**不是路径，任何模式下都生效 |

> ⏳ **带这个标记的参数当前不解析**（只读环境变量）：`--versions-keep`、`--archive-days`、`--archives-keep`。
> 它们与 `editor/config.js` 的 `DEFAULTS` 一起，留待编辑器配置层统一时接入
> （配置模板 / 校验 / 默认值都从 `DEFAULTS` 取）。**在那之前不要单独接某一个**——否则同一份文档会对应两套半成品口径。
> 眼下要调这几项，请直接设对应的环境变量。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /` | 填写界面（无口令给出口令输入页；`--owner-only` 时非主人看到"只有主人能打开"） |
| `GET <前缀>` | **规范化尾斜杠**：`/queue` → 301 `/queue/`。页面里的请求都是相对路径（`api/*`、`font/*`），地址栏不以 `/` 结尾时它们会解析到站根、全部 404 |
| `GET /healthz?k=` | 版本、字段、功能清单、口令/签名密钥/白名单/群名单状态（探活与一致性自检用） |
| `GET /api/data?k=&u=&s=` | 按身份裁剪后的数据（界面用），含群昵称候选 |
| `GET /api/snapshot?k=` | **表格快照**：返回 xlsx 原始字节，给机器人当只读数据源（插件按 `remote.ttl_ms` 定期拉） |
| `GET /api/version?k=` | 当前表指纹（只读；推表前的冲突检测用） |
| `GET /api/meta?k=` | 页面元信息：`footer`（插件配置 `footer.html` 的自由 HTML + 自动追加的规范署名行，空串 = 不显示页脚）、版本、历史版本份数。**只凭口令**，不含表格数据 |
| `POST /api/save` · `POST /api/anchors` | 保存数据行 / 主播列表；两者都可带 `version`（页面读到的那一版表指纹），对不上返回 **409**，一个字都不写。主播列表另可带 `added: [{ values }]` 新增主播（见「主播列表：谁改、怎么加」） |
| `GET /api/versions` · `POST /api/restore {id}` | 历史版本列表 / 回退到某个版本（主人） |
| `POST /api/upload` | 用上传的 xlsx 覆盖当前表（主人；本机「上传覆盖云端」走这里） |
| `POST /api/push-cloud` | 本机编辑器专用：把本机那份表推给云端覆盖（需要 `--cloud`） |
| `GET/POST /api/ownership` | **归属状态**（主人；见下节）：查看 QQ → 行 的可信度 / 按当前表重建 |
| `POST /api/roster` | 机器人推群成员名单（只认机器人身份或主人）：候选 + 按 QQ 对账 |
| `GET/POST /api/admins` | 白名单维护（主人或管理口令） |
| `GET /font/cn.woff` | 编辑器页面的中文字体（原神字体；随源码在 `resources/common/font/`，按固定路径直吐，不下载不缓存） |
| `GET /favicon.ico` | 网页标签页图标（读 `resources/image/HuTao_LeLouvre_256.ico`，随插件入库；**先于口令校验**——浏览器请求它时不会带 `?k=`；两份都缺才 404，不影响页面）。页面里的 href 由服务端按**请求带的挂载前缀**填（`editor.html` 写 `__MOUNT__/favicon.ico`）：挂在 `/queue` 下时是 `/queue/favicon.ico`，**不能指站根**——那条路径不归编辑器，浏览器只会拿到框架的 404 |

## 页脚（版权 / 备案）

页脚内容**不写死在页面里**，由插件配置 `config/config.yaml` 的 `footer.html` 提供。
前端从 `GET /api/meta` 取它（**与其它请求共用同一个 `withToken()`**：主脚本开局就把 `?k=` 收进
localStorage 并把地址栏清干净了，再自己读 `location.search` 会拿到空口令 → 403 → 页脚静默消失）。
模板（`config.yaml.example`）里**已经写好署名首行**，备案号自己往后接：

```yaml
footer:
  # 首行署名（`&` 用实体 `&amp;` 更稳；要改署名直接编辑这一行）
  html: |
    <div>© 2026 <a href="https://github.com/Hyposelenia-Moon">缄月</a> &amp; <a href="https://github.com/AxiuCN">阿修Axiu</a> · 由 <a href="https://github.com/Hyposelenia-Moon/abyss-queue">abyss-queue</a> 提供</div>
    <div><a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">京ICP备2026xxxxxx号-1</a></div>
```

- **规范署名行由编辑器追加**：这份自由 HTML 之后，编辑器会**自动追加**一行
  `Created By Yunzai-Bot {yunzaiVersion} & {PluginName} {pluginVersion}`（口径见仓库 `AGENTS.md` §3.5）。
  所以维护者改署名时**不用管版本号**，也别把版本号抄进 `footer.html`——
  版本取编辑器自己定位到的插件根下的 `package.json`，插件名取插件 `components/constants.js` 的
  `PLUGIN_NAME`（与回复页脚 `versionFooter` 同源）；两者都推导不到时显示「未知」，不会因此起不来。
  编辑器是第二个入口（可能按并排布局部署），这一路上**没有静态 import 插件的 `components/`**。
- **署名口径**：首行是两位维护者并列（缄月 / 阿修Axiu），与仓库 `AGENTS.md` 的权属一致。
  `&` 建议写成 `&amp;`（HTML 实体）——裸 `&` 浏览器一般也容错，但严格校验器会报错，显示效果一样。
- **备案号留给你**：不预填，避免把示例号当成真号带上线（备案号必须与本站实际备案一致）。

- **自由 HTML，不拆字段、不校验**：版权几行、备案号放哪、要不要公安备案（`https://beian.mps.gov.cn/#/query/webSearch?code=<号>`）、
  甚至放图片，都由维护者自己排。编辑器只负责"有就画、没有就不画"（空串 = 整块不渲染）。
- **覆盖四处**：填写界面 + 三个提示页（需要口令 / 仅主人可用 / 链接已失效）。提示页在鉴权之前就返回，
  所以它们由服务端直接拼进 HTML；填写界面走 `GET /api/meta` 下发、前端用 `innerHTML` 插入。
- **只由维护者维护**：它被当作可信内容原样插入页面，**不要**把群友可控的字符串接到这里（那等于给公网页面留 XSS）。
- 改完要**重启机器人**才生效（配置只在插件加载时读一次：凭证由宿主注入、页脚与开关进 `cfg`）；
  编辑器跑在机器人进程里，所以没有"单独重启编辑器"这回事。两种跑法见上面「怎么起」。

## 归属接口（`/api/ownership`，主人专用）

表格里**没有 QQ 列**，稳定身份只存在编辑器侧：绑定文件（`abyss-editor-bindings.json`）里的
`QQ → 行号`，外加"这份绑定是对着哪一版表写的"（表指纹）+ 完成情况锁。行号只在**同一版表**里才有意义，
所以外部（Excel/WPS/别的进程）改过表之后，归属随时可能"对不上账"。这两个接口就是把这层状态摊开：

### `GET /api/ownership`

```jsonc
{
  "ok": true,
  "version": "…当前表指纹…",
  "bindings": { "table": "…绑定记的那一版…", "stale": false, "count": 7 },   // stale = 版本对不上，下次有人开页面会先自动重建
  "locks": { "table": "…", "stale": false, "count": 2,
             "rows": [{ "sheet": "幽境危战", "row": 11, "nickname": "乙", "by": "主播", "at": 1, "current": "乙", "stale": false }] },
  "roster": { "group": "…", "updatedAt": 0, "count": 42 },
  "sheets": [
    { "name": "幽境危战", "bound": 7,
      "entries": [
        { "qq": "30001", "row": 11, "nickname": "别人", "current": "甲", "rowExists": true,
          "stale": true, "conflict": false, "conflictWith": [] }
      ] }
  ]
}
```

`entries` 里每一项就是一条绑定，四个字段回答"这条还信不信得过"：

- `nickname`：绑定里**记的**群昵称；`current`：表里那一行**现在**的群昵称；
- `stale`：`!rowExists || nickname !== current` —— 那一行没了，或已经换了人；
- `conflict` / `conflictWith`：同一行被**两个以上** QQ 都"有效"认领（绑定记的昵称与表里一致）。
  正常写入流程造不出这种状态（`validateRows` 拒重名、`dropBindsAt` 清旧绑定），只有手工改过的绑定文件 / 老数据才会；
- 表里已经没有的榜（绑定还在）也会列出来，标 `missingSheet: true`。

### `POST /api/ownership` `{ "action": "rebuild" }`

按**当前表**重算一遍（`rebuildOwnership`，与自动对账同一套规则）：绑定记的那一行还在、昵称也没变 → 保留；
按群昵称在表里**唯一**命中 → 跟过去（顺手纠正行号）；重名看不出是哪一位 / 表里没这个人 / 两个 QQ 争同一行
→ **一律作废**，绝不按旧行号认人。响应就是"做了什么"：

```jsonc
{ "ok": true, "version": "…", "kept": 2, "moved": 1, "dropped": 5,
  "unconfirmed": 3, "missing": 2, "locks": { "kept": 1, "dropped": 1 } }
```

- `kept` / `moved`：保留几条、其中几条纠正了行号；
- `dropped`：作废几条，并拆成 `unconfirmed`（重名/争同一行，**只能人工核对**）与 `missing`（这个人已经不在表里）；
- 重建**只写绑定与锁，不动表格**，所以不存历史版本；它走的是同一条写队列（AQ-06），
  页面上的做法是"查看 / 一键重建（二次确认）"，重建**不碰**用户没保存的草稿。

权限与 `/api/admins` 同一口径：**主人**（或管理口令这个备用入口）。白名单管理员与本人链接一律 403——
前者不该看到全表的归属，后者本来就只该看到自己那一行（`editor/test/ownership.test.mjs` 盯着）。

### 为什么不给表加"稳定成员 ID"列（方案 B）

加了 ID 列，"这一行是谁"就写成表里的数据，归属审计、跨版本对账都能退化成一次列比对。代价是：

- 表是**人工维护、还要给人看**的（腾讯文档那份同步同一张表）。多一列 ID 等于让每个人多维护一样东西，
  漏填一行就是"这个人没有身份"，而漏填是必然发生的；
- ID 得由程序发、程序写进用户正在编辑的那一行，等于把"报名"这件事拆成两步（填表 + 领号），
  群友拿到的还是同一份表，出错面反而更大；
- 稳定身份本来就在编辑器侧（QQ 是签名过的、不会变），表里的昵称只是**展示**。真正需要的不是 ID 列，
  而是"这层状态可审计、可重建"。

所以方案 B 选的是一条**代价明确**的路：表保持原样，编辑器侧的绑定承担稳定身份，
用表指纹 + `stale` / `conflict` 把风险显式暴露出来，并给主人一个一键重建的入口。要认下来的代价：

- 别人手工把 A 的名字写进 B 的那一行，原理上无法与"A 自己改了群名片"区分（两者对绑定而言长得一样）；
  这类改动靠**群名单对账**（`POST /api/roster`）+ 上面这份审计 + 人工核对兜底；
- 绑定文件丢了 / 换个部署目录，归属就得重建一次（重建规则是安全的：宁可让人重新认一次，
  也不会把别人的行认成自己的）。

## 权限

- **主人**：能改所有人的行、改主播列表（含新增主播）、维护白名单、看/回退历史版本、上传覆盖云端、**查看/重建归属状态**（`/api/ownership`）
- **白名单管理员**：能改所有人的行、改主播列表（含新增主播）
- **带身份签名的人**（`?u=&s=`，密钥是**签名密钥**）= 本人：只能改自己那一行；完成情况被主播填过的行对他上锁
- **没有签名** = 只读访客
- 本机编辑器开 `--owner-only`：以上之外的人一律 403（只有 `/api/snapshot`、`/healthz` 仍凭口令放行）

## 主播列表：谁改、怎么加

表头上方那份「主播列表」（`#主播` 与「选择主播」下拉的唯一来源）只有**主人与白名单管理员**能改：
判据是 `perm.role === 'admin'`，与白名单一样**只认 QQ**（群昵称随时能改，不当权限，见 `acl-roles.test.mjs`）。
**本人与访客的页面上根本没有这块面板与「＋ 新增主播」**——不是把按钮置灰：`renderAnchors()` 在非管理员时
收起面板、清空行表、连按钮都不渲染；服务端 `/api/anchors` 也只认 `caller.role`（否则 403）。

- **改既有行**：`rows: [{ row, values }]`。行号必须是表里**已有**的主修行（写到数据区或别处会被拒）。
- **新增主播**：`added: [{ values }]`（页面点「＋ 新增主播」就进这一份）。主播区没有空行可占，
  所以服务端在**最后一位主播下面插一行**：公告行 / 表头行 / 数据行连同它们的合并格、下拉验证范围、
  条件格式范围、超链接、冻结窗格与序号公式（`=ROW()-偏移`）一起下移一格，绑定与锁里的行号同步搬走
  （`model/xlsx.js` 的 `insertRowsAndShift` + `editor.mjs` 的 `shiftRowsOf`）。新行的行号由**服务端**定，
  页面保存成功后重新读表才拿到它；插入前会照常存一份历史版本（表写坏了能回退）。
  **注意口径**：主播区（表头**之上**）与排队区（表头**之下**）是同一张表里的两个区，行号却是一根轴
  —— 新增主播会把**表头与整个排队区一起下移（行号 +1）**，绑定与锁自动跟搬，排队区的内容一个字不变。
- **必填与落格**：主播名不能为空（前端与服务端都拦）；推荐度拼回 A 列原文「主播名【推荐度】」。
- **并发**：与成员行保存同一套语义——带 `version`（页面读到的那一版表指纹），对不上返回 **409**，
  一个字都不写（要插的那一行也不插），页面保留草稿、只提示、不自动重试也不自动重读。
- **删主播仍然要去表格里删行**：编辑器只做"改既有行 + 新增"，删行会让下面整体上移，是另一个动作。
- **窄屏（≤ 820px）看不到这块面板**：`editor.html` 的媒体查询里 `.anchors { display: none !important }`
  （主播表 7 列 × N 行会把手机页面拉得很长），所以**主人 / 管理员在手机上既看不到主播列表，
  也看不到「＋ 新增主播」**——不是按钮被藏了或权限丢了，换个宽屏（或手机横屏 + 桌面模式）就回来。
  这是**有意行为**，本次不改。

## 页面上的草稿、「重新读取」与「回到上一次修改状态」

草稿（改了还没保存的东西）只活在浏览器内存里，**没有第二份**：

- 保存时带上 `/api/data` 下发的那一版 `version`；服务端发现表已经变了就 **409**，
  页面只提示（常驻提示条 + 「读取最新并对比」）、**保留草稿**，既不自动重试也不自动重读；
  主播列表保存与成员行保存是**同一套**语义（`failConflict` / `keepDrafts` 共用一条路径）；
- 「重新读取」默认**保留草稿**并列出这一版的变化（同一个 `describeChanges`）；
- **丢草稿 = 刷新页面**（草稿只在内存里，页面不提供"丢草稿"按钮：那个名字会
  让人以为它能撤销保存，实际做不到）；
- 「回到上一次修改状态」（主人可见）= **服务端回退**：把表换回
  版本目录里最新那一份（每次写表**前**都会存一份，所以它就是"上一次修改之前的状态"），
  走 `POST /api/restore`，与「历史版本」里的「回退」同一条路；回退前也会先存一份当前状态
  ⇒ 点错了再点一次就回来了。带草稿时会先提醒"回退后草稿作废"；
- 首次进入页面、保存成功之后照旧：该榜（整表）的草稿照清；
- 头部「共 N 人 · 待保存 M 项」只数**真的跟表里不一样**的行：值改回原样不算一项，
  也**不会**为它发一次白写的保存请求（`rowChanged`）。

## 数据安全

- 写入是「读 → 改 → **写后自检**（重新解析新文件核对写入值）→ 原子替换」，核对不过就放弃写入
- 每次写表**前**把当前状态存进 `<插件根>\data\versions\`（生产口径；默认留最近 20 份，默认是空的，第一次写表才有第一份）
- 回退前也会先存一份当前状态 → 回退错了能再退回来
- 覆盖类操作（回退 / 上传）先校验「能否解析」+「工作表清单与当前一致」，防传错文件把表搞坏；
  解析这一步带**解压预算**（整表所有部件解出来合计 ≤ 256 MB、条目 ≤ 2048）——xlsx 就是 zip，
  1 MB 能解出几十 GB，而编辑器与机器人同进程，撑爆一次就是全群掉线
- 替换前落 `<表>.bak`；群成员名单为空时**拒绝**按它对账（防止全员被当成退群）
- 群成员退群时删掉他那行并**压紧**（下面的人整体上移，队列不留空洞），删前自动存版本
- **按 QQ 同步昵称只在"新名片非空"时发生**：本人打开页面时，若链接身份里的群名片为空
  （云端群名单里没有这个人，短链展开时 `editor/roster.js` 的 `nickOf` 补不出名片），
  **一个字都不写**——既不覆盖表里已有的昵称，也不写空串。群名片为空只是"这次取不到名片"，
  不是本人把名片清空；把它当成改名回写，会把成员填好的昵称清掉（界面上只剩 placeholder）。
  只有拿到**非空**新名片（本人真改了名片）才同步，退群删行与 stale/conflict 对账不受影响
- **同一张表只允许一个写者**：启动时探一次 `127.0.0.1:7788`（那儿有独立编辑器就**不挂载**），
  挂载成功后每 **5 分钟**再复探一次——"宿主起来之后才被拉起的旧编辑器"靠启动期那一次是挡不住的，
  那种情况下两个进程会各持写队列改同一张 xlsx。复探命中只记一条 **error** 提示人工处置
  （"停掉它 + 清掉拉起它的计划任务 / vbs + 重启机器人"），**不自动卸载**：撤掉主人正在用的编辑器是人的决定。

**响应头（公网面的最小加固）**：所有响应——含 301 / 403 / 410 / 500 这些提前返回的——都由
`handler` 开头统一带上三个头（`http/respond.js` 的 `SECURITY_HEADERS`）：

| 头 | 值 | 堵什么 |
|---|---|---|
| `X-Frame-Options` | `DENY` | 被任何站点 iframe 套住 → 诱导主人点"保存"（点击劫持） |
| `Referrer-Policy` | `no-referrer` | 口令在地址栏 / `?k=` 里，别顺着外链的 Referer 漏出去 |
| `X-Content-Type-Options` | `nosniff` | 提示页是 HTML、接口是 JSON，别让浏览器猜类型 |

**写操作留痕（审计）**：所有非 GET 请求在响应结束时记一行
`[abyss-editor] qq=… action=/api/xxx status=… <细节>`（`editor/audit.js`）——细节由各写接口补上
（`sheet` / `rows` / `written` / `version` / `members` / `add` 等）。用途是"表被改坏了能回溯是谁干的"：

- 出口**由宿主注入**：宿主模式走**框架 logger**（有时间戳与等级）；独立跑时走 `console`，
  而独立跑的 `setupLogFile` 会把它同时写进 `data/editor.log`；
- 这一行**只写显式字段，绝不带 `?k=`**（口令在 URL 里，不能顺手打进日志——nginx 那层的脱敏是另一件事）；
- **失败也记**（`status=403/400`）：谁在试，和谁改成了，一样重要。

接口响应（`json()`）另外统一 `cache-control: no-store`：里面是按身份裁剪过的行数据，不许被浏览器或
中间代理缓存。**只加这三个、不加整份 CSP**——页面全是内联 `<script>` / `<style>`，一份真 CSP 会打坏它；
以后新增**口令校验之前**就能到达的路由（现在只有 301 / 短链 / favicon 三条）时，要一并想清楚这三件事。

## 测试

```bash
# 在插件根目录跑：同时包含插件与编辑器的全部套件
node test/run.mjs
# 编辑器自己的套件：editor/test/{editor,identity,mount,owner-only,sign-key,versions,roster,
#   save-conflict,client-state,row-ownership,table-swap,write-queue,lock-compact,acl-roles,
#   anchor-version,anchor-add,reload-drafts,ownership,data-confinement,fail-closed,body-limit,
#   member-row-area,short-link,empty-nick}.test.mjs
# 拿不到真实表格时会自动跳过（可用 XLSX_PATH 指一份 xlsx；测试端到端建议 ABYSS_TEST_SYNTHETIC=1 用合成样本）
```

所有**会起编辑器进程**的套件都显式设 `ABYSS_EDITOR_TEST_PATHS=1`（它们的工作区在系统临时目录），
插件侧套件则由 `test/env.mjs` 统一设 `ABYSS_QUEUE_TEST_PATHS=1`；
"生产口径只认插件内的 data"这条规则由 `editor/test/data-confinement.test.mjs` 钉住。

## 部署到云服务器

见 [`DEPLOY.md`](./DEPLOY.md)（systemd + nginx `location /queue` 的写法、口令与签名密钥、备份、健康检查、
权限矩阵与换月流程）。要点：**把插件目录一起带上**（共用模块），并**务必单独配签名密钥**。
