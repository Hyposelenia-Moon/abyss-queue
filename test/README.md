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

`verify-xlsx.ps1` 不是套件，而是**独立复核工具**：用 .NET 的 ZIP/XML 解析器（与插件实现完全不同的一套实现）检查生成文件的回读值、结构标签数量与未改动工作表的逐字节一致性。

```powershell
powershell -File test/verify-xlsx.ps1 -Modified <生成的文件> -Original <原表格> -Sheet 2 -Row 27
```

## 约定

1. **任意 cwd 可跑**：路径一律经 `_helper.mjs` 的 `Paths` 推导，禁止裸相对字面量与盘符绝对路径；被测表格位置用 `XLSX_PATH` 覆盖。
2. **缺前置就跳过、不算失败**：`requireSource()` 在表格不存在时打印 `⏭ 跳过：…` 并 `exit 0`。否则新克隆的仓库一跑全红，套件会被当成"坏掉的东西"而忽略。
3. **不改动源数据**：临时产物只写系统临时目录（`fs.mkdtemp`），被测表格复制成副本后再改。
4. **必须有断言与退出码**：`createChecker()` 记录每条断言，`finish()` 按失败数设置退出码；只打印不判定的脚本不是回归。
5. **框架全局桩集中在 `_helper.mjs`**：`installFrameworkStubs()` 提供 `plugin`/`logger`/`segment`/`Bot`，必须在 import 插件代码**之前**调用。上下文按「规则集 + 会话」隔离，因此一个插件目录下的多个 app 类不会互相串上下文。
6. **入口类必须经 `index.js` 装载**：`workflow.test.mjs` 用 `const { apps } = await import("../index.js")`，与框架 loader 的取法一致（插件根有 `index.js` 时 loader 只加载它，见 `lib/plugins/loader.js:58-62`、`:130`）。这样"apps 导出漏了某个类"这类回归才测得到。
