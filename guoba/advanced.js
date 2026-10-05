/**
 * 锅巴接入：高级
 *
 * 平时不用动的一项：云端快照的本地备份。
 * 数据以云端为准，这份备份是防手滑 / 防服务端事故用的，**默认开着**；
 * 落点固定 `<插件根>/data/backup`（不可配置），保留份数是代码里的常量。
 */

export function getSchema() {
  return [
    { label: "高级", component: "SOFT_GROUP_BEGIN" },

    {
      field: "snapshot_backup.enable",
      label: "本地备份云端快照",
      bottomHelpMessage: "每次成功拉到云端表就往 data/backup 写一份（按日期命名，只留最近几份）。默认开启；关掉后本地不留兜底副本",
      component: "Switch",
    },
    {
      field: "remote.autostart",
      label: "本机编辑器启动器",
      bottomHelpMessage:
        "本机联调兜底：拉不到云端表时按这个路径把编辑器拉起来（例：<插件根>/data/editor-launch.mjs）。正式部署留空",
      component: "Input",
      componentProps: { placeholder: "（留空）" },
    },
  ]
}
