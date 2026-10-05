/**
 * 锅巴接入：展示与别名
 *
 * 出图与名单显示的长相（条数 / 分辨率 / 截断宽度 / 字体），以及 `#主播` 用的别名表。
 *
 * 别名表在配置里是"正名 → 别名列表"的映射（`{ 阿修Axiu: ["阿修"] }`），
 * 面板上用子表（一行一个主播）更好填，转换只发生在 `guoba/index.js` 那一层。
 */

export function getSchema() {
  return [
    { label: "展示与别名", component: "SOFT_GROUP_BEGIN" },

    { label: "名单", component: "Divider" },
    {
      field: "default_sheet",
      label: "默认榜",
      bottomHelpMessage: "`#排队 全部` 不带榜名时用哪个榜。例：幽境危战",
      component: "Input",
      componentProps: { placeholder: "幽境危战" },
    },
    {
      field: "list_limit",
      label: "列表显示条数",
      bottomHelpMessage: "出图时最多画几行；0 = 全部",
      component: "InputNumber",
      componentProps: { min: 0, placeholder: "20" },
    },
    {
      field: "render_max",
      label: "每列截断宽度",
      bottomHelpMessage: "「群昵称」与「帮帮完成情况」两列共用。按显示宽度计，中文算 2；0 = 不截断",
      component: "InputNumber",
      componentProps: { min: 0, placeholder: "40" },
    },

    { label: "出图", component: "Divider" },
    {
      field: "render_image",
      label: "用图片渲染",
      bottomHelpMessage: "队列 / 主播 / 菜单都出图；渲染后端不可用时自动回退成文本",
      component: "Switch",
    },
    {
      field: "render_scale",
      label: "出图分辨率倍数",
      bottomHelpMessage: "2 = 两倍宽高的高清图（插件把它下发成渲染链的 data.sys.scale）；1 = 与旧版一致",
      component: "InputNumber",
      componentProps: { min: 1, max: 4, placeholder: "2" },
    },

    { label: "字体（无需配置：汉仪文黑-65W 随源码在 resources/common/font/ 分发）", component: "Divider" },

    { label: "主播别名", component: "Divider" },
    {
      field: "anchor_aliases_list",
      label: "别名表",
      bottomHelpMessage:
        "正名 → 别名。表里或群里对同一位主播的其它写法（老昵称、简称）填在这里，读的时候会归一成正名（按正则整串匹配、忽略大小写）",
      component: "GSubForm",
      componentProps: {
        multiple: true,
        schemas: [
          { field: "name", label: "正名", component: "Input", required: true, componentProps: { placeholder: "阿修Axiu" } },
          { field: "aliases", label: "别名", component: "GTags", componentProps: { allowAdd: true, allowDel: true } },
        ],
      },
    },
  ]
}
