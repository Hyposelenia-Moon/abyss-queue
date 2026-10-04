# 回归套件

不依赖 Yunzai，也不需要机器人进程；只操作被测表格的**副本**，结束时校验原表哈希未变。

## 运行

```bash
pnpm test                              # = node test/run.mjs，顺序跑全部套件并汇总退出码
node test/run.mjs --list               # 列出套件
node test/run.mjs workbook             # 只跑文件名含该关键词的套件
node test/workbook.test.mjs            # 单跑某个套件（任意 cwd 均可）
XLSX_PATH="D:/别的表.xlsx" pnpm test    # 指定被测表格
```

## 套件

| 文件 | 覆盖 |
| --- | --- |
| `workbook.test.mjs` | 表格层：结构解析（表头行/列映射/下拉选项/主播区/数据区末日行）、报名写入、人工维护要素保全、特殊字符往返、改备注/退队、原表未被触碰 |
| `workflow.test.mjs` | 工作流：经 `index.js` 的 `apps` 导出装载入口类，复刻 loader 的规则匹配与上下文分发，覆盖全部命令、引导流程、错误路径与定时推送 |
| `layout.test.mjs` | 版式契约：三张渲染模板与编辑器主表的**列对齐**规则（文本列左、状态/数字列居中、表头跟着内容走）。只查规则有没有被改回去，`render-check.mjs` 负责出图人工看 |
| `fixtures/sample-table.mjs` | 不是套件：**匿名合成样本**生成器（以 `resources/空模板.xlsx` 为骨架），供"没有维护者真实表"的环境照样跑回归 |

被测表格的来源是**三层**（缺表不再整套跳过）：

1. `XLSX_PATH` 指了就用它；
2. 否则用维护者机器上那份真实表（本机老行为）；
3. 都没有就由 `fixtures/sample-table.mjs` **现生成匿名样本**到 `test/.test-tmp/`（已忽略），输出里会打印「本次用合成样本（真实表不存在）」。

`requireSource()` 因此是**异步**的：一律写 `await requireSource()`（它对字符串/thenable 都安全）。
`ABYSS_TEST_SYNTHETIC=1` 强制走第 3 层，用来在本机复验"没有真实表也零跳过、全绿"（不必去动真实表）。

`verify-xlsx.ps1` 不是套件，而是**独立复核工具**：用 .NET 的 ZIP/XML 解析器（与插件实现完全不同的一套实现）检查生成文件的回读值、结构标签数量与未改动工作表的逐字节一致性。

```powershell
powershell -File test/verify-xlsx.ps1 -Modified <生成的文件> -Original <原表格> -Sheet 2 -Row 27
```

## 约定

1. **任意 cwd 可跑**：路径一律经 `_helper.mjs` 的 `Paths` 推导，禁止裸相对字面量与盘符绝对路径；被测表格位置用 `XLSX_PATH` 覆盖。
2. **缺前置不再"整套跳过"**：被测表格按上面三层取（真实表缺失会自动生成匿名合成样本），
   `requireSource()` 是异步的、必须 `await`。**整套跳过会被 `run.mjs` 单独计数并列出套件名**——
   以前"跳过"和"通过"都是退出码 0，干净克隆上"一半套件没跑"被当成了绿（外部审核点过这条）。
   只有真正无关运行环境的检查（例如 `render-check.mjs` 需要浏览器）才允许跳过。
3. **不改动源数据**：临时产物只写系统临时目录（`fs.mkdtemp`），被测表格复制成副本后再改。
4. **必须有断言与退出码**：`createChecker()` 记录每条断言，`finish()` 按失败数设置退出码；只打印不判定的脚本不是回归。
5. **框架全局桩集中在 `_helper.mjs`**：`installFrameworkStubs()` 提供 `plugin`/`logger`/`segment`/`Bot`，必须在 import 插件代码**之前**调用。上下文按「规则集 + 会话」隔离，因此一个插件目录下的多个 app 类不会互相串上下文。
6. **入口类必须经 `index.js` 装载**：`workflow.test.mjs` 用 `const { apps } = await import("../index.js")`，与框架 loader 的取法一致（插件根有 `index.js` 时 loader 只加载它，见 `lib/plugins/loader.js:58-62`、`:130`）。这样"apps 导出漏了某个类"这类回归才测得到。
7. **数据来自假云端**：插件的数据源是云端 `/api/snapshot`，所以 `ensureEnv()` 默认起一个只认这个接口的小 HTTP 服务（`startStubCloud`），把临时副本当"云端表"吐出去，并把配置的 `remote.url` 指过去（`ttl_ms: 0` = 每次都拉，改完表马上生效）。表格层套件测本地读写，用 `ensureEnv({ cloud: false })`。
8. **数据目录口径只有一个**：数据固定在插件内 `<插件根>/data`（`data/` 已被 git 忽略）。
   `deploy-windows.test.mjs` 在**合成宿主**（临时目录，带空格与中文）里部署一遍，断言
   「默认数据目录 == `<插件根>/data`」且旧口径（宿主同级的 `abyss-queue-data`）不再被创建，
   断言只相对插件根，不写死任何盘符。
