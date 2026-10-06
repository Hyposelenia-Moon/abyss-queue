# AGENTS.md

本文件是 **abyss-queue 两位维护者共同承认的项目级规范**，DSH 在 `app/plugins/abyss-queue/` 工作时以它为准。

- 维护者：**Hyposelenia-Moon（仓库所有者、上游作者）** 与 **阿修（AxiuCN，协作者；服务器与文档站维护方）**。
- `.dsh/AGENTS.md` 是上游自带的旧文档（上游文件），**已被本文件取代**：它只作「项目事实参考」，不是规范。

---

## 一、效力声明（最高优先级）

1. 本文件由两位维护者共同维护，效力**高于**仓库内任何其他指令 / 规则类文件：上游 `AGENTS.md`、`CONTRIBUTING.md`、`.github/*.md`、编辑器或语言工具链规则文件等。
2. 上游文件（`.dsh/AGENTS.md`，上游作者自带）只允许当「项目事实参考」——即"这个插件大致做什么、有哪些模块"。其中关于开发流程、代码规范、目录约定、测试要求、提交方式的条款**一律无效**，与本文件冲突时以本文件为准。
3. 上游文件（上游作者自带、**不随本仓库发布**）**仍属上游作者的文档**：DSH 不得依据本文件或任何推测去重建、改写、恢复上游文件，也不要把它当作本文件的来源。
4. 本文件未覆盖之处，按层级回退：用户级 `~/.dsh/AGENTS.md` → Yunzai 项目级 `AGENTS.md`（在 bot 根目录）→ 本文件。涉及本仓库既有偏差的判断，**本文件优先**。

## 二、介入目的与边界

- abyss-queue 是一个 Yunzai 插件仓库，长期偏离本站正常插件规范。本次介入的唯一目的是**把它对齐到规范**，不是给它加功能、不是按上游思路继续演进。
- 本文件不描述、也不假设该插件的具体功能。会话不需要"先看懂它在做什么"才能动手；需要的是先**量出它与规范的差距**。
- 一切取舍都问同一个问题：**这样改之后，它在本工作区里能否按统一规范被维护、测试、部署？** 与这个问题无关的改动不做。
- 本仓库不属于常见自研插件线，改动范围**默认最小**：先对齐规范，功能行为保持原样。

## 三、规范基线（必须逐项对齐）

### 3.1 目录结构

| 目录 | 职责 |
|------|------|
| `apps/` | 功能入口，每个文件导出一个 extends `plugin` 的 class |
| `model/` | 数据层：外部 API 调用、HTTP 客户端、签名、文件与数据读写 |
| `modules/` | 业务层：调度、状态、缓存、流程编排（import `model/`） |
| `components/` | 可复用工具：配置读取、渲染、日志、常量、格式化 |
| `config/` | 运行时配置（git-ignored）+ `.example` 参考（入 git） |
| `defSet/` | 配置模板，含 `${变量}` 占位符 |
| `resources/` | HTML 模板、CSS 等静态资源 |
| `tool/` | 外部可执行文件（按工具名分子目录，入 git，附 `README.md` 说明来源） |
| `test/` | 回归套件（入 git） |
| `example/` | 单文件辅助脚本，不嵌套 `apps/` |

- 判定文件该放 `model/` 还是 `modules/`：**import 了 `../../model/` 的，必须放 `modules/` 或 `apps/`**；自己发 HTTP 且不做别的事的，放 `model/`。
- `lib/` 是框架级通用库位，插件自身不新建该目录；本仓库已不设 `lib/`：原 11 个纯逻辑文件按层归入 `model/`、`components/`、`modules/`（映射见第十一节）。
- **静态资源随源码分发**：字体、图标、模板都入库，放在 `resources/` 下（字体用 `resources/common/font/`，与 Axiu-Plugin / Atlas-Plugin 同位置）。**不做"首次使用时联网下载 + 本地缓存"**——那会引入网络失败分支、缓存目录与镜像配置，而这些都不是这个插件该管的事。需要某个静态资源时直接放进仓库并读本地文件；文件缺失要给出可读的降级（例如回落到系统字体）而**不是**再去下载。

### 3.2 入口加载

- 目录下存在 `index.js` → **单入口模式**，Yunzai 只加载该文件；无 `index.js` → 目录遍历模式，逐个 `.js` 注册。
- 两种模式都合法，但**不得在未与维护者确认的情况下切换**（见第五节）。
- 单入口模式下，`index.js` 负责动态发现并按文件名导出 apps：
  - 先 `readdir` 过滤出 `.js`，import 数组与命名遍历**同源**，避免索引错位；
  - 用 `Promise.allSettled` 并行 import；
  - 用 `isPluginClass()`（判断 `prototype` 属性不可写）挑出插件 class，**不得用 `Object.keys(mod)[0]`**——ESM 命名空间对象的 key 按名字排序，多导出一个常量就会顶掉 class，且 loader 会静默跳过无效导出，导致整条规则不注册；
  - 每个 apps 文件**只能导出一个 class**，其余导出（常量/工具函数）随意；
  - 逐条打印 `[abyss-queue] 载入: xxx`，漏注册时能一眼看出。
- 单入口插件**没有热重载**：loader 只为目录遍历模式注册文件 watcher，任何 `.js`/模板改动都必须完整重启 Yunzai。

### 3.3 插件 class API

```js
export default class SomeFeature extends plugin {
  constructor() {
    super({
      name: '中文功能名',        // 必填，中文
      dsc: '功能描述',           // 必填，中文
      event: 'message',         // 默认 message
      priority: 5000,           // 数字越小越先执行
      rule: [{
        reg: /^#命令/,
        fnc: 'methodName',      // 指向 this.methodName，接收 e
        permission: 'all',       // master | owner | admin | all
        log: true,              // false 时不打印执行日志
      }],
      task: [{ name: '任务名', cron: '0 30 5 * * *', fnc: 'taskMethod', log: false }],
      handler: {},
      namespace: 'abyssQueue',
    })
  }
}
```

- 类名 PascalCase，与文件名对应；`name`/`dsc` 一律简体中文。
- 方法返回 `true` 表示命令已处理（阻止低优先级插件继续匹配）。
- 拦截类命令（需要抢在其他插件之前处理的）必须把 `priority` 调到足够小，并在报告中说明理由。
- 插件注册失败、规则不生效这类问题，先查 `rule` 是否真的注册上了，再查业务逻辑。

### 3.4 配置三层结构

```
Plugin/
├── defSet/config.yaml          ← 模板：完整注释 + ${变量} 占位符（锅巴保存时用）
├── config/config.yaml.example  ← 参考默认值（入 git，可手动编辑）
└── config/config.yaml          ← 运行时（不纳入 git）
```

- 用**模板变量替换法**写配置，禁止 `YAML.stringify` 整写（会抹掉注释）。
- 锅巴 field 用点分隔路径（`section.key`），模板变量用下划线（`section_key`）。
- `getPluginConfig` 兜底：`config.yaml` 不存在时从 `.example` 复制；**禁止**解析 `defSet/config.yaml` 过滤 `${变量}` 当兜底——替换成空会生成非法 YAML。
- 每个 `${变量}` 必须在锅巴 `defaultValues` 里能找到对应项；锅巴 schema 每个大 label 一个文件，`guoba/index.js` 只做拼装。
- 配置写入必须保留注释（按模板渲染后写回，或走锅巴同一路径）。

### 3.5 日志、版本号、注释

- 日志一律 `logger?.info` / `logger?.warn` / `logger?.error`，**不用 `logger?.debug`**。
- 版本号走 `components/pluginVersion.js`，导出 `pluginVersion`（读本插件 `package.json`）与 `yunzaiVersion`（读 bot 根 `package.json`）；HTML 模板底部统一显示 `Created By Yunzai-Bot {yunzaiVersion} & {PluginName} {pluginVersion}`。
- 保留原有注释风格（`/** */` 块注释、语句旁 `//`）；函数写 JSDoc（功能/输入/输出）；对边界条件与设计决策写注释，对"调了什么 API"不写注释。
- 注释**不记录单次 bug 修复过程**（不写"修复了…的 bug""之前是…现在改为…"）。
- **历史沿革不写在代码里**：注释只讲"现在是什么、为什么这样设计、边界在哪"；**代码与配置文档中不出现**"以前是…／已经删掉…／老配置／旧键／不再…"这类**沿革说明**——它们一律记进本文件的「历史沿革」表（见第十一节）。配置模板（`config/config.yaml.example`）只描述当前键与当前语义，**不解释"某个键为什么没了"、也不为已删的键留说明性注释**。
- **改动落盘时同步写对应文档**：改到目录结构 / 配置键 / 命令 / 接口 / 部署口径，必须同一轮更新 `README.md`、`docs/开发说明.md`、`config/config.yaml.example`、`editor/README.md` 里对应的那份，**不留到最后补**；结构性变更同时补进「历史沿革」表。

### 3.6 命名

| 元素 | 规范 | 示例 |
|------|------|------|
| 插件目录 | kebab-case，带 `-plugin` 后缀 | `LinkFlow-Plugin` |
| 功能文件名 | camelCase | `cmdExport.js` |
| 导出的 class | PascalCase，与文件名对应 | `class cmdExport` |
| 子目录 | kebab-case | `linkparse/` |
| 配置键 | 点分隔小写驼峰 | `gallery.autoUpdate` |

本仓库目录名 `abyss-queue` 不含 `-plugin` 后缀，属既有偏差；**是否改名由两位维护者共同决定**，不得自行执行。

### 3.7 回归套件 `test/`

- 结构：`<主题>.test.mjs` + `_helper.mjs`（路径/前置/断言/框架全局桩）+ `run.mjs`（入口）+ `fixtures/`。
- `pnpm test` = `node test/run.mjs`，**任意 cwd 可跑**，不启动 bot。
- **缺前置一律打印「跳过」并 `exit 0`**，不得直接失败。
- 临时产物写 `test/.test-tmp/`（gitignore）。
- 套件只测**对外行为与契约**：不为内部实现细节导出函数，不写只覆盖死代码的断言（`test/` 内不出现仅测试用的导出）。

### 3.8 开发与部署

- **两份源码仓库，各自开发**：两位维护者各持一份源码仓库（不是共享目录，也不做软链接——框架要求插件真实位于 `<bot根>/plugins/` 下）；各自在自己那份上改代码、跑测试、提交、推送。
- **运行实例由部署方维护**：插件运行目录只由更新指令（框架的 `#更新`）从远端拉取，**不接受任何手工拷贝**——手工同步会制造未提交改动，下一次更新必然报本地改动冲突。
- **验证顺序**：改到影响运行行为的代码，先在源码仓库跑离线套件（`pnpm test`）；需要真机验证时，由部署方按自己的部署流程同步到运行实例；DSH **不直接改运行实例目录里的文件**。
- **加日志验证后必须还原**：临时调试日志（`logger?.info('[模块名-DEBUG] ' + JSON.stringify(data))`）在验证通过后一律删除，再提交。

### 3.9 Git

- **不执行任何 git 操作**：不 `git add` / `commit` / `push` / `merge` / `checkout` / `clone` / `pull`。
- 改动完成后给提交摘要：单行标题 `prefix: 中文描述`（`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`），详细列表每行 `- ` 一项；**代码与仓库内文档（`AGENTS.md` / `README.md` / `docs/` / 各 README）都算改动**，一并列入。
- 摘要只反映本次 diff 的真实内容，不写与改动无关的说明。

## 四、工作流程（先调查，再设计，后实现）

1. **只读调查**：量出本仓库与第三节规范的实际差距，形成**差距清单**（逐条：现状 → 规范要求 → 影响）。此阶段不写任何文件。
2. **出方案**：针对差距清单给出对齐方案，含改动范围、文件级影响、风险点、以及**明确不做什么**。技术选型可自行决定并说明理由，不必逐项征询。
3. **等确认**：方案得到维护者确认后才写实现代码。确认前不落盘。
4. **实施**：按确认的范围改，**不顺手改无关代码**，不夹带重构。
5. **验证**：跑 `test/`（若有）或给出可复现的验证方式；实测失败就说失败，跳过就说跳过。

**授权粒度（这条踩过坑，必须守住）**：

- **一次授权 = 一步**。维护者认可某一步，只授权**那一步**；做完立刻停下汇报，**等下一次明确授权**才能动下一步。
- **"定方案"不等于"开始执行"**：让 DSH 出方案、把方案写下来、确认方案内容，都只到"方案已定"为止；宁可多问一句"现在开始执行第 N 步吗"，也不要顺手往下做。
- **批量/连续执行不成立**：即使方案里写了"步骤 1、2、3"，也不代表 1 做完可以接着做 2。
- **不自行判断"顺理成章"**：改动互为前提、共享同一批文件、只差一处 import 之类，都不是可以自行推进的理由。
- 越界的代价要认：已经把改动落盘了，也**先停下来报告越界**，由维护者决定是保留、回退还是重做——不要靠"再补做一步"把问题糊过去。

**越权防线（执行时的硬约束）**

以下行为一律算越权；一旦发生，立刻停下报告，由维护者决定保留、回退还是重做：

1. **不得把"全做完 / 都改了吧 / 下一步 / 你看着办"解读成批量授权**：`下一步` 只授权**当前清单里的那一步**；要连做必须逐步拿到明确同意——"这几步互为前提""共享同一批文件""只差一处 import"都不是理由。
2. **不得一边做一边扩大范围**：已确认范围之外的**文件与行为**一律不碰；发现"顺手也该改"的，先停下问，不要自己拍板。
3. **不得碰运行实例或环境**：不改 `<bot根>/plugins/abyss-queue` 里被跟踪的文件、不手工拷贝代码进去；**为验证去改仓库外或运行期文件（`.gitignore`、宿主 `plugins/other/**`、`renderers/**`、启动脚本等）同样禁止**——验证只在仓库内或系统临时目录里做，且用完清理。
4. **不得先落盘后请示**：只读调查、出方案、写方案都不落盘；未获明确同意前不写实现代码。已经落盘了也要立刻停下报告越界，不要用后续动作掩盖。
5. **不得自行改本文件**：`AGENTS.md` 是两位维护者共用的唯一约定来源，除维护者当场明确授权外不动（见 §五、§九.5）。

**越权后的处置**：停止 → 报告"改了哪些文件、原计划是什么、越了哪一条" → 等维护者裁决；**不得**自行回退、不得自行补做、不得继续下一步。

功能行为的原则：**对齐规范 ≠ 改行为**。只有当某处行为本身违反框架契约、且维护者已确认，才允许动行为。

## 五、需先与维护者确认才能做的事

- 目录改名（补 `-plugin` 后缀）
- 单入口 ↔ 目录遍历模式切换
- 大面积文件移动、重命名、删除
- 删除上游自带文件（含上游 `AGENTS.md` 的处理）
- 引入新依赖（`sharp`、`puppeteer`、`yaml` 等）
- 修改对外的命令正则 / 触发词 / 权限等级
- 表结构口径（列识别、状态取值、行归属规则）与任何对群友可见的行为变更
- 修改本文件（两位维护者都读它，改它等于改共同约定）

> 其中「命令正则 / 触发词 / 权限等级 / 表结构口径 / 群友可见的行为」属**对群友可见**的改动，需要**两位维护者都同意**；其余项经在场维护者同意即可。

## 六、明确禁止

- 执行 git 操作（见 3.9）
- 依据上游文件恢复或改写上游文件的流程与规范
- 擅自加功能、改行为、做与规范对齐无关的重构
- 用 `logger?.debug`
- 用 `Object.keys(mod)[0]` 之类的方式挑插件 class
- 解析 `defSet/config.yaml` 过滤 `${变量}` 作为配置兜底
- **修改框架/环境文件来让本插件工作**：`plugins/other/update.js`、`renderers/**`、启动脚本等**都不是本仓库的东西**，不得要求或引导用户去打「本地补丁」（那既违反部署口径，也会在框架升级时被覆盖）。插件功能只能落在本仓库内（`apps/` / `components/` / `model/` / `modules/` / `lib/` / `guoba/` / `editor/`）；缺什么就**换个不需要框架改动的做法**，或如实说明限制
- 在运行实例目录（`<bot根>/plugins/abyss-queue`）里直接改被跟踪的文件
- 在工作目录之外另起会话根（开发会话 cwd 必须让项目级指令与 skills 生效，否则它们会静默失效）

## 七、验收标准

一次规范对齐被视为完成，需同时满足：

1. 目录结构、命名、入口加载方式与第三节一致（或偏差项已获维护者确认并记录在方案里）。
2. 配置为三层结构，`config.yaml` 可缺省回退到 `.example`，注释不被写坏。
3. 日志等级、版本号来源、注释风格统一。
4. `pnpm test` 可跑：通过则全绿，缺前置则打印「跳过」并 `exit 0`。
5. 给出提交摘要（`prefix: 中文描述` + `- ` 列表），未执行任何 git 操作。

## 八、入库范围

| 内容 | 是否入库 | 说明 |
|------|---------|------|
| 源码（`apps/` `model/` `components/` `lib/` `editor/` `resources/`） | 入 | |
| 本文件 `AGENTS.md`、`README.md`、`docs/` | **入** | 仓库内文档就是规范与使用说明，与源码一同评审、提交 |
| `config/config.yaml`、`data/`、`test/.test-tmp/`、依赖与锁文件 | 不入 | 见 `.gitignore` |
| `.dsh/` | 不入 | 工具侧工作区，目录内容不随仓库发布 |
| **文档站** `D:\nginx\html\docs.axiu.uno\`（docs.axiu.uno） | **不入** | 独立于本仓库维护，直接在 D 盘编辑；插件功能 / 命令变更时同步更新对应页面，但不进本仓库的提交 |

## 九、协作约定（两人共同维护）

1. **分工口径**：本仓库有两份源码仓库、一个运行实例；运行实例由部署方维护，代码经远端同步。改代码前先看清自己改的是哪一份，改动只在源码仓库里落。
2. **改动前对齐**：动第三节基线里的东西（目录、入口、命名、配置三层、部署口径）或第五节的"需双确认"项，先在会话里说清"改什么、为什么、影响面"，另一位维护者确认后再落。
3. **同步冲突的由来**：运行实例只接受更新指令的改动。若某次更新报「本地改动会被覆盖」，先看 `test/check-deploy.mjs` 的输出，再决定是丢弃本地改动还是提交；**不要**用强制对齐去覆盖别人未提交的现场改动。
4. **文档跟着行为走**：命令 / 配置键 / 表结构口径变了，同步更新 `README.md`、`config/config.yaml.example`、对应 `docs/` 页面与文档站页面（文档站不入库，见第八节）。
5. **本文件的改动同样要留痕**：改 `AGENTS.md` 需两位维护者同意，并在提交摘要里列明改了哪一节——它是两个人共用的唯一约定来源。
6. **不替对方拍板**：拿不准归属的口径，问；不要"先按自己的理解改一版再让别人接受"。

## 十、已知问题（待另一位开发者处理）

> 这一节是**交接清单**，不是规范。条目在解决后从本节删除，并把结论记进第十一节「历史沿革」。

*（暂无待办条目：已结案的记在第十一节「历史沿革」。）*

---

## 十一、历史沿革（代码里不写，只记在这里）

**用途**：代码注释与配置模板只描述"当前是什么"，**沿革一律记在本表**（规则见 3.5）。
每做一次结构性变更（删配置键、挪模块、改口径、换落点）就在表末追一行；
「说明」写清**变了什么、为什么**，供以后判断"这处为什么长这样"。

| 变更 | 说明 |
|------|------|
| 数据落点配置项全部删除 | 原 `store_file` / `notify.state_file` / `snapshot_backup.dir` 三个配置键被删。它们能填的有效值只有一个（`confineDataPath` 会把出圈的值挡回插件内），属**假配置**；现在三个落点由 `components/config.js` 直接拼成 `<插件根>/data` 下的常量。回归套件改用 `ABYSS_QUEUE_STORE_FILE` / `_STATE_FILE` / `_BACKUP_DIR` / `_XLSX_PATH` 环境变量重定向，仍受 `ABYSS_QUEUE_TEST_PATHS=1` 与 `confineDataPath` 把守。插件侧 `xlsx_path` 一并删除（插件不写表，只有回归套件用过） |
| `apps/_base.js` 拆解 | 删除该文件（`apps/` 恢复"只放入口 class"）：`AppBase` → `components/base.js`，启动装配 → `components/boot.js`，主人提示 → `components/notify.js`，群消息发送侧 → `components/notify-send.js`，填报入口 → `components/fill-entry.js`，状态文件读写 → `model/queue-state.js`；`apps/queue.js` 拆出 `apps/anchors.js`（`#主播`）与 `apps/init.js`（`#排队初始化`） |
| `lib/` 收边界 | `lib/logger.js` → `components/logger.js`（吃 bot 全局 `logger`，不属两入口共用面）；`lib/patches.js` → `model/patches.js`（读宿主文件、推导宿主根，属数据访问）。`lib/` 剩 11 个"可被编辑器直接加载的纯逻辑"文件 |
| `model/patches.js` 归位 | 与上一条同批：判定口径是「加载它会不会产生副作用」，而不是「目录层级顺序」。`lib/commands.js` / `lib/router.js` 仍 import `components/constants.js`，那是无副作用纯常量，按同一口径判为**可以留** |
| 编辑器模块化 | `editor/editor.mjs` 从 2433 行降到 1622 行，依次抽出：`config.js`（启动装配 + fail-closed）、`cli.js`（argv 原语）、`plugin-root.js`（插件根定位）、`util.js`、`acl.js`（白名单与锁）、`roster.js`（群名单）、`versions.js`（版本与归档）、`ownership.js`（归属对账）、`http/{respond,auth,pages}.js`（HTTP 收发 / 鉴权 / 提示页）。工厂注入 `deps`，不读全局 |
| 编辑器页脚改为配置提供 | 新增 `footer.html`（自由 HTML，原样插入页面），由 `GET /api/meta` 提供给首页，三个提示页共用；不拆字段、不转义（只由维护者维护，不接用户输入） |
| 定时任务合并为一条 | 原四条 cron（队列推送 / 完成轮询 / 月末催办 / 名单同步）合并为唯一一条 `notify.cron`（默认每 3 分钟），四件事在 `lib/notify.js` 的 `tickTasks()` 里按内部时间判断，去重状态同写 `data/progress.json`。定时推送功能（`push.enable` / `push.cron` / `push.sheets` / `push.limit`）随之删除；它留下的 `push.groups` 兼容键后来也删了（见「假配置清理（第二批）」） |
| 编辑器 `http/` 抽出 | 见上「编辑器模块化」；同轮删掉无引用的 `footerHome` 常量（容器已硬编码在 `editor.html`） |
| 死代码清理 | 删除无引用的 `configHint()`、`LOCAL_XLSX_NAME`、`rowMatches`、`joinCells`、`indexToCol`、`SAMPLE_QQS` 与若干未使用的 import / 局部声明 |
| 假配置清理（第二批） | 删 `push.groups`（与 `notify.groups` 语义完全重复的兼容键，`push` 整节消失）；`snapshot_backup.keep` → `snapshot_backup.enable`（份数在代码里固定 `BACKUP_KEEP`，开放"开关"而不是"份数"）；`backup` 从插件配置删除（它只被编辑器消费，属归属错位，`Table` 回到默认 `backup: true`） |
| `notify.enable` 修复 | 原实现只在"注册定时任务"处看它，`tick()` 里不看 ⇒ 配了 `roster.group` 时设 `false` 通知照发、且连"没配群号"的提示都不发（看着关了其实没关）。现把它落进 `notifyGroups()`：`false` → 群号列表为空 → 三条 @ 通知全空、也不再提示；**群名单同步不受影响**（只看 `roster.group`）。`test/notify.test.mjs` 补 4 条断言 |
| `render_max` 合并 | `render_name_max` / `render_status_max` 合并为 `render_max`：两者在 `components/render-html.js` 里永远一起传，从没分开配过。`lib/render.js` 的参数签名（`nameMax` / `statusMax`）保持不变——那是内部接口，套件直接按它调用 |
| 配置键归属成文 | `docs/开发说明.md` 新增「配置键归属」一节：插件键 / 编辑器键 / 编辑器部署参数三分，明确"只有 `footer.html` 一个键跨层"，并定下"编辑器部署参数不进 `config.yaml`、也不进锅巴"。这是接锅巴（`defSet/` 模板 + `guoba/`）的前置依据 |
| 锅巴接入 | 新增三段式配置与面板：`defSet/config.yaml`（模板 + `${变量}`）→ 锅巴保存时渲染 → `config/config.yaml`（注释完整保留），两份配置键结构必须一致；`guoba/{index,connection,display,footer,advanced}.js` + 根 `guoba.support.js`。变量名由 `fieldToVar()` 从配置路径推导（`remote.url` → `${remote_url}`），**不手写映射表**；值序列化 `yamlValue()` 一律 `JSON.stringify`（含 `#` / `:` / 引号 / 换行的值也写不坏 YAML）。面板只列 25 个插件键，**编辑器那 7 个启动参数不在面板内**（理由见「配置键归属」）。图标用 `pluginInfo.iconPath`（绝对路径，锅巴 `res.sendFile` 直吐），复用 `resources/image/HuTao_LeLouvre.ico`。`test/guoba.test.mjs` 49 项：三份结构一致 + 真往返 + schema 漂移守卫 |
| 编辑器标签页图标 | 新增 `GET /favicon.ico` 路由，**排在 `authorized()` 之前**——浏览器请求 favicon 时不会带 `?k=`（页面口令在 localStorage 里、不是 cookie），放在口令校验之后会让正式部署拿到 403、图标根本不显示。编辑器按自己算出的插件根读，**不需要新增启动参数**；favicon 用 256×256 那版（标签页 16/32/48、任务栏与 apple-touch-icon 可达 180，64 会插值发虚），锅巴面板仍用 64 那版；`editor.html` 用绝对路径 `/favicon.ico` 引用。`editor/test/editor.test.mjs` 补 5 条断言（其中"不带口令也能取到"是关键那条——**带上口令测就测不出这个坑**） |
| 不再要求改框架 | 删掉 `docs/仓库之外的改动.md`（「怎么给框架打补丁」的清单）与三处指向不存在章节的死引用，并在 §六 明确禁止"改框架/环境文件来让插件工作"。**起因**：插件启动时的「部署补丁缺失」提示要求用户去改 `plugins/other/update.js` 与 `renderers/**`，那既违反部署口径、也会被框架升级覆盖。**核实**：那三条里 ① `#更新` 认简称、② `#强制更新` 后重启**只能改框架**（命令路由与进程重启都在框架侧），③ 高清出图**插件侧早已做完**——`config.render_scale` → `render(..., { scale })` → 框架的 `data.sys.scale`，只等渲染后端认；④ 启动器联动的插件侧（`components/boot.js` 写 `data/restart.flag`）一直在做。另外确认框架 `getPlugin()` 只按 `plugins/<名字>/.git` 找、无别名表，所以 `#更新 abyss` 本来就匹配不上——**正确做法是用目录名 `#更新 abyss-queue`**，不是打补丁 |
| 自我更新落到 apps | 新增 `apps/update.js`（`#排队更新` / `#排队强制更新`，主人专用）与 `components/update.js`（纯逻辑，注入 `exec`/`restart`）。**为什么自己实现**：框架 `#更新` 的规则是 `^#(安?静)?(强制)?更新` 且 `priority: -Infinity`，**任何以 `#更新` 开头的消息都被它先吃掉**，插件用 `#更新…` 写法抢不到；所以改用 `#排队**更新**`（与 `#排队` / `#排队初始化` 同族）。更新成功调框架的 `Bot.restart()` 重启——那是框架自己暴露的能力，不算改框架；本机启动器再据 `data/restart.flag` 把编辑器一并拉起。**判定口径**：有没有新代码**看提交号变化，不看 `git pull` 输出**（强制更新先 `reset --hard`，随后 pull 必然报 `Already up to date`，按输出判会"更新了却不重启"）。同时删掉整套「框架补丁自检」（`model/patches.js`、`test/patches-host.test.mjs`、`AppBase` 构造函数里的调用），因为按新规定它检查的东西**不该被要求**。`test/update.test.mjs` 20 项；`workbook.test.mjs` 的规则数与命令表断言同步（3 → 5 条） |
| 字体改为随源码分发 | 字体（原神标准字体「汉仪文黑-65W」`HYWH-65W` 与 `tttgbnumber`）改为**入库**在 `resources/common/font/`，与 Axiu-Plugin / Atlas-Plugin 同位置同文件（各带 `.woff` + `.ttf`），并逐字节等同旧缓存。删掉整套「首次渲染联网下载 + `data/fonts` 缓存 + 镜像列表」：`components/font.js` 只剩"按名取 `file://` 路径"，配置键 `font_download` / `font_mirrors` 与其锅巴字段一并删除，编辑器 `/font/cn.woff` 改为直达入库文件。**注意 `components/render-html.js` 的 `themeData` 必须是 `async`**：调用方写 `const theme = await themeData()`，若它同步返回 Promise，`{ ...view, ...theme }` 展开的是 Promise 自身属性（一个都没有）——字体字段会静默丢掉且不报错（`test/guoba.test.mjs` 有一条断言专门钉这个）。**遗留**：`test/commands.test.mjs` 一条断言因此暴露失败，结论见本表「`test/commands.test.mjs` 的「多榜总览」断言竞态」一行 |
| `tools/` 目录退役 | 删除整个 `tools/`（`deploy-windows.ps1`、`一键部署.cmd`、`make-template.mjs`）。**理由**：前两个与 `#排队初始化` 是同一件事的两套实现（一个 PowerShell、一个指令），留着必然漂移；`make-template.mjs` 是一次性工具，它生成的 `resources/空模板.xlsx` 早已入库。**入口链收敛为一处**：启动器产物（`editor-path.txt` + `editor-launch.mjs` + 两个 vbs）只由 `#排队初始化` 生成，本机编辑器的自动拉起只由 `remote.autostart`（`model/remote.js` 的 `ensureEditor`，插件加载后与首次读表两处触发）负责——**这两条都不依赖 `tools/`**。连带把引用它的注释与文档（`editor/editor.mjs` 顶部、`editor/README.md`、`editor/DEPLOY.md`、`model/remote.js`、`components/init/secrets.js`、`editor/test/compare-editors.mjs`、两个套件的"跳过"提示语）一并改掉 |
| 部署回归改为走 `#排队初始化` | `test/deploy-windows.test.mjs` → `test/init-launcher.test.mjs`。原套件跑的是已删除的 `tools/deploy-windows.ps1`，脚本退役后它只会「套件跳过」——那段"产物 → 拉起 → 探活"的覆盖就没人守了。新套件不碰 PowerShell：在**临时合成宿主**里调用 `runInit`（`#排队初始化` 的编排），拿产物再按 `remote.autostart` → `ensureEditor()` 真拉起编辑器探 `/healthz`。覆盖收敛为六类：产物落点固定在 `<插件根>\data` 且不创建旧口径的仓库外目录、不再生成 `editor.cmd`；启动器是 `.mjs`（`autostartCommand` 认得）、`node --check` 可解析、按 `import.meta.url` 自定位且不写死盘符；`/healthz` 通过且表格/端口/挂载/主人专用/日志参数都对；口令与签名密钥真传进编辑器；重复跑初始化逐字节不变且口令不被换掉；初始化只改 `remote.token` / `remote.sign_key` 两行。**计划任务**只走注入的 `schtasks` 桩（复核查询也照走），**探活**走注入的 `fetch` 桩，绝不在真机上注册任务。**注意**：套件**不**在"第二遍初始化之后"再断言编辑器还活着——结论见本表「`test/init-launcher.test.mjs` 的「编辑器活不过两三秒」」一行 |
| `#排队初始化` 砍掉多余的两步 | 由七步收成五步：删掉「数据目录」与「本地表格副本」——它们都是"反正会有人建"的东西。数据目录现在由**第一个往那儿写东西的步骤**按需建（`stepLauncherArtifacts` 里 `existsSync` 判断后 `mkdirSync`），编辑器写文件时（`editor/util.js`）与启动器复制表格时也会建；本地表格副本本来就由启动器在"本机还没有表"时用 `resources/空模板.xlsx` 起一份（`editor-launch.mjs`）。**收益**：初始化不再碰空模板（夹具也就不用搬它），少两次落盘，报告短两行；`initPaths` 去掉 `templateXlsx`，`STEP_TITLES` 收成 5 项。**遇错即停/幂等/不覆盖三条硬规矩不变**：`existsSync` 后再 `mkdirSync` 正是为了重复跑仍然"零落盘"（`test/init.test.mjs` 有一条断言钉住）。连带改：`test/init.test.mjs`（遇错即停的用例从"空模板缺失停在第 2 步"换成"配置里没有 `remote:` 段停在第 1 步"；异常注入的用例按新编号对到第 2 步）、`test/init-launcher.test.mjs`（`26` 项：本地副本改由**启动器**生成，断言换成"初始化不许建它"+「拉起后副本内容等于入库空模板」）、`README.md`、`docs/开发说明.md`、`editor/README.md` |
| `test/commands.test.mjs` 的「多榜总览」断言竞态（原第十节 K1） | **测试自身的竞态，不是产品缺陷**。该条 `check("多榜总览仍是 #排队 一条", async () => …)` 没有 `await`，回调在 `await say("#排队")` 处让出后与紧接着的「图片模式：`#排队 危战`」交错，`lastCall()`（`sent.renderCalls.at(-1)`）读到的是后者的 `queue/queue`，于是「期望 `queue/menu`」那条偶发变红；隔离环境下 `#排队` 稳定渲染 `queue/menu`。**处置**：给该 check 补 `await`，三条精确断言（`fnc === "menu"`、`tpl === "queue/menu"`、`sheets.length === 3`）原样保留；**不采用**「只要记录里出现过 menu 就算过」的弱化写法。修后该套件 17/0、全套件 47 套绿 |
| `test/init-launcher.test.mjs` 的「编辑器活不过两三秒」（原第十节 K2） | **结论：非缺陷——那是套件自己的收尾动作，不是进程被环境回收**。实测（仪表化跑真套件）：`/healthz` 在 +377/379/380ms 返回 200 且 body 里带 `pid`；该 pid +454ms 仍在、**+513ms 消失**，套件 **+756ms** 才退出——正好对上套件的 `finally { killEditor() → wait(300ms) → rmSync }`（`killEditor()` = `spawnSync("taskkill", ["/PID", pid, "/T", "/F"])`）。对照实验（与本插件无关的最小 HTTP 服务，同 `detached + windowsHide + unref` 方式起）：独立脚本、"套件形态"、"套件形态 + 起完纯等"各 3 次全部探到 +8s 仍 200；把套件里第三段之后的动作复刻到临时脚本但**去掉它自己的收尾**，同样一路 200。**误判成因**：本机整套只跑 0.8–1.6s，"过一两秒再探"必然落在 `finally` 之后；独立脚本"能活 5 秒以上"只是因为它没有那段 `finally`。**另修正原记录一条**：桩编辑器以 `stdio: "ignore"` 起，`process.on("exit")` 里的 `console.log` 无处可写，"没打日志"不能推出"不是 `process.exit()`"。**覆盖写法**（已落地：`test/init-launcher.test.mjs` 在 `ensureEditor()` 之后、收尾之前延时复探并核对 `pid`，套件 26 → 27 项；已知局限：延时固定 1.8s，若 `ensureEditor()` 之后新增更长的动作会贴近收尾而失真，更硬的写法是把复探放进独立子进程）：探活放在 `ensureEditor` 之后、清理之前（或搬进独立脚本 + pid 文件）；`detached + windowsHide + unref` 与 `execSync` 都不动 |
| `AGENTS.md` 增设「越权防线」 | §四 的授权粒度只写了"一次授权 = 一步"，但实际执行中仍被解读成批量授权（把"请全部做完"当成连做 S01–S05）、也出现过为验证临时改 `.gitignore`、以及早期手工把代码拷进运行实例目录。现在把这三类写成硬约束：不得把"全做完/下一步"当批量授权、不得超出已确认范围、不得碰运行实例与环境（验证只在仓库内或系统临时目录）、不得先落盘后请示、不得自行改本文件，并写明越权后的处置（停止→报告→等裁决，不自行回退或补做） |
| 日志等级归一 | 原来有 11 处用 `log("mark", …)`：框架 logger 没有 `mark` 这一档，这些日志整条落到 `console.log`（无时间戳/等级/来源，警告与报错被降级成普通输出）；`components/config.js` 那处写成 `globalThis.logger?.mark?.(…)`，因为 `?.` 连 console 都落不到，那句提示彻底打不出来。现在等级只用 `info` / `warn` / `error`（§3.5），`components/logger.js` 的 console 回退也按等级走、未知等级归 `info`；日志文案未改 |
| `components/roster.js` → `model/roster.js` | 该文件自己 `fetch` 编辑器的群名单接口，按 §3.1「自己发 HTTP 且不做别的事的放 `model/`」归数据层。仅路径与 import 变化（`apps/queue.js`、`components/notify-send.js`、`test/roster.test.mjs` 已同步，`docs/开发说明.md` 目录树同步），导出与行为未动 |
| 去掉 `model/index.js` 聚合入口 | §3.2 规定 `index.js` 只应存在于插件根。原聚合的两个单例搬进具体模块：`getRemote()` → `model/remote.js`、`getStore()` → `model/store.js`（导出名与语义逐字不变）；引用方（`components/base.js`、`apps/queue.js` 与 6 个套件）改为直接引用具体模块 |
| 快照构造器归位 | `test/_snapshot-xlsx.mjs` → `test/fixtures/_snapshot-xlsx.mjs`（§3.7：夹具与构造器进 `fixtures/`），内容零改动；`test/remote-cache.test.mjs`、`test/snapshot-backup.test.mjs` 的引用与 `test/README.md` 清单同步 |
| 安全整改（编辑器与启动器） | 成员保存补业务行范围校验（安全整数 + 数据区下界 + 业务上界；越界时不改表/绑定/锁/版本，保留合法追加）；公网模式缺独立 `SIGN_KEY` 或凭证互等时拒绝启动，本地兼容限回环 + 显式测试开关；请求体改累计字节计数、超限停止保留分块并只结算一次；启动器端口冲突改为探测后停止（不再按端口杀未知进程）、快照经工作簿与业务结构验收通过才原子替换（失败另存诊断、不覆盖有效 `.bak`）。对应回归：`editor/test/{member-row-area,fail-closed,body-limit}.test.mjs`、`test/launcher-guard.test.mjs` |
| 收掉 `lib/` 目录 | §3.1 规定 `lib/` 是框架级通用库位、插件自身不新建。原 11 个纯逻辑文件按层归位：→ `model/`：`xlsx.js`、`schema.js`、`identity.js`；→ `components/`：`text.js`、`aliases.js`、`render.js`；→ `modules/`：`notify.js`、`progress.js`、`queue.js`、`commands.js`、`router.js`，`lib/` 随之删除。全仓 51 个文件的 import / `shared()` / 文档路径同步（含 `resources/init/editor-launch.mjs`、`editor/editor.mjs` 与两个入口的套件）。**编辑器侧不变量**：这批文件一律不引用 bot 全局（`logger`/`Bot`/`segment`/`globalThis.*`），因此编辑器仍可直接加载它们（已用"不加框架桩逐个 `import()`"验证）。本条取代此前「`lib/` 剩 11 个纯逻辑文件」的说法 |
| 编辑器页脚注入规范署名行 + `hasFont` 私有化 | **页脚（编辑器这第二个入口的署名）**：页脚内容仍由配置 `footer.html` 提供（自由 HTML，不拆字段、不校验、留空 = 整块不渲染），但 `editor/config.js` 现在会在它**后面自动追加**一行 `Created By Yunzai-Bot {yunzaiVersion} & {PluginName} {pluginVersion}`——§3.5 要求 HTML 输出统一带这行署名，而编辑器此前只有维护者自定内容。新增 `editor/plugin-root.js` 的 `attributionLine(pluginDir)`：插件版本读**编辑器自己定位到的插件根**下的 `package.json`，宿主版本按「插件根的上一级必须叫 `plugins/`」推导（与 `components/pluginVersion.js` 同一口径），插件名取插件 `components/constants.js` 的 `PLUGIN_NAME`（与 `versionFooter` 同源）；三者推导不到一律给「未知」，不抛错、不用 `process.cwd()`。编辑器可能按并排布局部署，这一路**没有静态 import 插件的 `components/`**（仍走 `makeShared` 动态加载）。**为什么这样切**：署名行是规范、不由配置提供，所以配置里那份自由 HTML 照旧可自由编辑，**版本号不进任何默认 footer 文本**（`DEFAULTS.footerHtml` / `defSet` / `config.yaml.example` 的默认值一字未动）。文档同步：`editor/README.md`、`docs/开发说明.md`、`guoba/footer.js`。**字体**：`components/font.js` 的 `hasFont` 改为**不导出**（§3.7：不为内部实现细节留接口）；`test/guoba.test.mjs` 第 6 组随之改成按**公开接口**断言，`fontUrl(key)` 文件在时给 `file://` 且文件真的存在、**缺失时给空串**（模板 `@font-face` 整条失效、回落系统字体，即 §3.1 的"可读降级"）。**是换测法不是放宽**：缺失那一支由"只改内存里的 `FONTS`、`finally` 还原、不动磁盘上的字体文件"走到；删掉/挪走一个入库字体文件，这两条断言都会红 |
