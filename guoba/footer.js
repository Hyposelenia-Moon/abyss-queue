/**
 * 锅巴接入：编辑器页脚
 *
 * `footer.html` 是**自由 HTML**：版权与备案怎么排由维护者决定，所以不拆字段、不做校验，
 * 编辑器把它**原样插进页面**（首页 + 三个提示页），并在它后面**自动追加**规范署名行
 * （`Created By Yunzai-Bot {宿主版本} & {插件名} {插件版本}`，见 `editor/plugin-root.js`）。
 * 留空 = 整块不渲染。
 *
 * 它是维护者自己写的内容、不是群友输入，所以编辑器才敢用 `innerHTML` 插它——
 * 别把用户可控的字符串接到这里（那等于给公网页面开一个 XSS 口子）。
 */

export function getSchema() {
  return [
    { label: "编辑器页脚", component: "SOFT_GROUP_BEGIN" },

    {
      field: "footer.html",
      label: "页脚 HTML",
      bottomHelpMessage:
        "原样插进编辑器页面底部（首页 + 需要口令 / 仅主人可用 / 链接已失效三个提示页），后面会自动追加一行规范署名（Created By Yunzai-Bot …，版本号不用自己写）。留空 = 不显示页脚。**多行就直接换行**（别手打 \\n 这两个字符，那会原样显示出来）；备案号自己往后接；改完要重启机器人才生效",
      component: "InputTextArea",
      componentProps: {
        placeholder:
          '<div>© 2026 <a href="https://github.com/Hyposelenia-Moon">缄月</a> &amp; <a href="https://github.com/AxiuCN">阿修Axiu</a></div>',
        rows: 4,
      },
    },
  ]
}
