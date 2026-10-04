# lib/ 解构准备（只读调查产物，暂不执行）

> **性质**：这是**施工前的准备材料**，不是规范、也还没动手。规范以根目录 `AGENTS.md` 为准。
> 记录时间点：lib/ 共 13 个文件；编辑器与 bot 共用其中 4 个。**代码与 skill 均未改动**。

---

## 一、`lib/` 的实际定位（修正版）

`lib/` 不是 `-plugin` 规范里那个"框架级通用库位"，也**不只是**"与业务无关的工具函数"——它是本插件**两个入口之间的共用面**：

| 入口 | 怎么加载 `lib/` |
|------|----------------|
| bot 插件（`apps/` `components/` `model/`） | 静态 `import` |
| 云端编辑器 `editor/editor.mjs` | `shared(rel)` = `import(pathToFileURL(<插件根>/<rel>))`（`editor.mjs:122`），实际加载 `lib/identity.js`、`lib/xlsx.js`、`lib/queue.js`、`lib/aliases.js`（`:141-247`） |

所以 `lib/` 里可以放**业务纯逻辑**（`progress.js` 的完成判定就是），前提是它**纯到第二个入口能直接加载**。这也是编辑器能"与插件同一份表格读写实现"的落地方式。

## 二、13 个文件清单（行数 / 依赖 / 是否在共用面）

| 文件 | 行数 | 依赖 | 共用面 | 判定 |
|------|------|------|--------|------|
| `aliases.js` | 50 | 无 | ✅ 编辑器 | 留 |
| `commands.js` | 48 | `components/constants.js`（纯常量） | ❌ | 留 |
| `identity.js` | 182 | `node:crypto` | ✅ 编辑器 | 留（但**动它 = 动编辑器**，见 §5） |
| `logger.js` | 8 | `globalThis.logger` | ❌ | **候选移出**（吃 bot 全局） |
| `notify.js` | 136 | 本层 | ❌ | 留 |
| `patches.js` | 131 | `fs` / `path` / `components/config.js(pluginRoot)` | ❌ | **候选移出**（有 I/O + 引入会读文件的 config） |
| `progress.js` | 187 | 无 | ❌ | 留 |
| `queue.js` | 140 | 本层 | ✅ 编辑器 | 留（动它要跑编辑器套件） |
| `render.js` | 380 | 本层 | ❌ | 留 |
| `router.js` | 35 | `components/constants.js`（纯常量） | ❌ | 留 |
| `schema.js` | 170 | 本层 | ❌ | 留 |
| `text.js` | 56 | 无 | ❌ | 留 |
| `xlsx.js` | 449 | `jszip` | ✅ 编辑器 | 留（动它要跑编辑器套件） |

**只有 2 个文件与"纯逻辑层"定位不符**：`logger.js`（吃 bot 全局）、`patches.js`（文件 I/O + 引入会读文件的 `components/config.js`）。其余 11 个都满足"可脱离 bot 进程加载"。

## 三、两条硬边界（解构时必须保持）

1. **不许吃只在 bot 进程里存在的全局**：`Bot` / `segment` / `plugin` / `logger` / `redis` / `cfg`。
   编辑器是普通 Node 进程，模块顶层一旦引用这些就会抛 `ReferenceError`。
2. **不许做 I/O 与 `process.cwd()`**：要文件就由调用方把数据/路径传进来（`lib/schema.js` 的范式：进 xml、出 model）。

> ⚠️ **"不许 import `components/`"不是边界**——实测 `lib/commands.js` 与 `lib/router.js` 都 import 了 `components/constants.js`，而它是纯常量（无副作用、不读文件），编辑器加载它毫无问题。
> 真正的判据是**"加载这个模块会不会产生副作用"**：`components/constants.js` 不会（可以引），`components/config.js` 会（读 `config.yaml`、推导 `pluginRoot`，**不能引**）。

判定顺序：**"能不能被第二个入口直接 import？"** 不能 → 去 `components/`（bot 侧组装）或 `model/`（bot 侧数据访问）。

## 四、解构方案（待执行，二选一）

### 方案 A（建议）：只清边界，目录名与路径不动

- `lib/logger.js` → `components/logger.js`（它是 bot 侧日志适配器，不是纯逻辑）
- `lib/patches.js` → `components/patches.js`（或 `model/patches.js`：要读宿主文件、要推导宿主根）
- 其余 11 个不动 → **编辑器侧 `shared("lib/...")` 一行都不用改**
- 收益：`lib/` 变成名副其实的"可跨入口加载的纯逻辑层"，且零跨入口风险

### 方案 B：连同目录名一起重整

- `lib/` → 改名（如 `shared/`）或并回 `components/`
- 代价：**约 40 处 import 全改**，含 `editor/editor.mjs` 的 4 处 `shared()`、12 个 `test/*.mjs`、`test/fixtures/`、`tools/make-template.mjs`
- 结论：除非要彻底消掉 `lib/` 这个目录，否则不值得

## 五、动手时的连带面（★ = 跨入口，改完必须跑编辑器套件）

**编辑器动态加载的路径（写死在 `editor.mjs:141-247`，改路径必须同步）**

| 文件 | 加载方 |
|------|--------|
| `lib/identity.js` ★ | `editor.mjs:141` |
| `lib/xlsx.js` ★ | `editor.mjs:142` |
| `lib/queue.js` ★ | `editor.mjs:245` |
| `lib/aliases.js` ★ | `editor.mjs:246` |
| `components/config.js` `components/font.js` `components/pluginVersion.js` `model/table.js` `model/store.js` ★ | `editor.mjs:143,144,243,244,247` |

**静态 import `lib/` 的调用方（移文件时要改的 import 点）**

| 文件 | 引入的 lib 模块 |
|------|----------------|
| ~~`apps/_base.js`~~（已拆解，见 §8） | `logger` `patches` `router` |
| `apps/queue.js` | `commands` `identity` `aliases` `progress` `notify` `render` `router` |
| `components/render-html.js` | `render` `logger` |
| `components/roster.js` | `identity` `logger` |
| `model/remote.js` | `xlsx` `schema` `logger` |
| `model/table.js` | `xlsx` `schema` |

**测试与工具**

- 12 个 `test/*.mjs` 直接 import `lib/`（`aliases` `commands` `progress` `notify` `render` `router` `schema` `xlsx` `queue` `identity` `patches`）
- `test/fixtures/sample-table.mjs`、`tools/make-template.mjs` 各 import `schema` / `xlsx`
- `test/patches-host.test.mjs`、`test/workbook.test.mjs` import `patches`

**跑不了测试的当前限制**：本机三个位置都没有 `jszip`（插件目录 / bot 根 / 部署目录），`node test/workbook.test.mjs` 在模块加载期就 `ERR_MODULE_NOT_FOUND`。解构前需要先 `pnpm i`（联网操作，需维护者确认），否则验证只能停在"import 图与路径自查"。

## 六、执行清单（步骤 1 已完成，勾选见下）

1. ~~先跑一次基线：`pnpm test` 全绿（缺依赖则先装），记下当前通过数~~ —— **未做**（缺 `jszip`，见 §8 的验证说明）
2. [x] 按方案 A 移 `logger.js` → `components/`、`patches.js` → `model/`
3. [x] 全量替换 import 点（§5 两张表）
4. [x] `docs/开发说明.md` 的目录树同步
5. 编辑器侧验证：`editor/test/sign-key.test.mjs`、`short-link.test.mjs`、`data-confinement.test.mjs`
6. bot 侧验证：`pnpm test` 复跑
7. 出提交摘要（`refactor:` 前缀）

## 七、未决项

| # | 问题 | 现状 |
|---|------|------|
| 1 | `lib/` 是否保留"与业务无关的工具函数"这一类 | 倾向放宽为"纯 + 可跨入口"，两种并存 |
| 2 | `lib/` 内部分不分层（如 `lib/util/`） | 倾向不分（现 11 个文件、最大 449 行） |
| 3 | `patches.js` 落 `components/` 还是 `model/` | **已定：`model/`**（要读宿主文件 + 推导宿主根） |
| 4 | 是否把 `lib/` 定位写进 skill（`add-feature` / `create-plugin` / `plugin-tests` / `plugin-subagent`） | 维护者明确"不改了"，留待后续 |
| 5 | 与 `apps/_base.js` + `apps/queue.js` 拆分的先后 | 两者都已完成（§8、§9） |

## 九、附：lib/ 清边界已完成（2026-10-05）

| 动作 | 文件 |
|------|------|
| 搬迁 | `lib/logger.js` → `components/logger.js`（吃 bot 全局 `logger`，不属共用面） |
| 搬迁 | `lib/patches.js` → `model/patches.js`（读宿主文件 + 推导宿主根，属数据访问） |
| import 更新 | `index.js`、`apps/queue.js`、`components/{base,boot,notify,notify-send,render-html,roster}.js`、`model/{remote,queue-state}.js`、`test/{notice,patches-host,workbook}.test.mjs` |
| 结果 | `lib/` 由 13 → **11 个文件**，全部是"可被编辑器直接加载的纯逻辑"（`commands.js`/`router.js` 仍引 `components/constants.js`，那是纯常量、无副作用） |

**已验**（临时 `--import` 钩子把 `jszip` 指到内联空桩，真正 import `index.js`）：
三个 app 全部载入、三条规则齐备、`lib/` 只剩 11 个纯逻辑文件、新位置模块导出齐备、全仓库无残留旧路径引用。
**未验**：`pnpm test` 全量（仍缺 `jszip`）、编辑器侧三个套件。

## 八、附：apps 层拆解已完成（2026-10-05）

不用等 `lib/` 决策，apps 层已经拆完（`lib/` 保持原样、未动）：

| 动作 | 文件 |
|------|------|
| 删除 | `apps/_base.js`（`apps/` 恢复"只放入口 class"） |
| 新建 | `components/base.js`（AppBase）、`components/boot.js`（`boot()` 启动装配 + `restartFlagFile`）、`components/notify.js`（主人提示）、`components/notify-send.js`（群消息发送侧）、`components/fill-entry.js`（填报入口）、`model/queue-state.js`（状态文件读写） |
| 拆入口 | `apps/queue.js` 593 → 320 行（只剩 `#排队` + `tick` 及其三个通知方法）；新增 `apps/anchors.js`（`#主播`）、`apps/init.js`（`#排队初始化`） |
| 装配 | `index.js` 增加 `boot()` 调用（退出钩子/清理标记由"加载即生效"改为**显式调用 + 幂等**） |
| 测试 | `test/workbook.test.mjs`、`test/notice.test.mjs` 的 import 改指向新模块；`notice.test.mjs` 的退出钩子用例改为直接验 `boot()`（并新增"触发钩子会写出重启标记"） |

**契约保持不变**：三条规则仍是 `menu` / `anchors` / `queueInit`（`test/workbook.test.mjs` 按 `fnc` 计数，`test/init.test.mjs` 按 `fnc === "queueInit"` 找类），`initDeps` 注入点原样保留。

**已验**：`node --check` 全绿；不依赖 `jszip` 的模块真实 import 通过（装配、`boot()` 幂等、补丁自检只跑一次、退出钩子写标记）；`apps/queue.js` 因经 `model/remote.js → lib/xlsx.js → jszip` 无法 import，只做了静态断言。
**未验**：`pnpm test` 全量 —— 仍然缺 `jszip`（联网安装待维护者确认），全套件跑不了。
