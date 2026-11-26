/** 锅巴接入：高级 */

export function getSchema() {
  return [
    { label: "高级", component: "SOFT_GROUP_BEGIN" },
    {
      field: "_runtime_info",
      label: "当前运行版本",
      bottomHelpMessage: "只读：确认线上进程已重启并加载了哪份代码；面板只读，不会写回配置",
      component: "InputTextArea",
      componentProps: { disabled: true, rows: 6 },
    },
    {
      field: "snapshot_backup.enable",
      label: "本地备份云端快照",
      bottomHelpMessage: "每次成功拉到云端表就往 data/backup 写一份（按日期命名，只留最近几份）。默认开启；关掉后本地不留兜底副本",
      component: "Switch",
    },
    {
      label: "本机编辑器启动器",
      bottomHelpMessage:
        "本机联调兜底：拉不到云端表时按这个路径把编辑器拉起来。路径由维护者自己准备（插件不生成启动脚本），按扩展名挑解释器（.mjs/.js/.cjs 用 node、.cmd/.bat 用 cmd.exe、.vbs 用 wscript）；例：<插件根>/data/launch-editor.cmd。正式部署留空",
      component: "Input",
      componentProps: { placeholder: "（留空）" },
    },
  ]
}
