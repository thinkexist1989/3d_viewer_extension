# 绞刀刀齿装配整站 URDF

来源：飞书「URDF 导出及视频记录」中的 `624初版.zip`（吴迪，2026-06-24）。

打开查看器后会自动加载 `station.urdf`。也可点工具栏 **Load Station**。

点位在同目录 `station.json`。

这份 URDF 的零位就是 SolidWorks/墨斗导出时的装配姿态，**不能再叠一套“预备关节角”**。取料/装配目前只按需求表改导轨：墨斗 2600mm = URDF 0（1 号刀齿一侧），墨斗 0mm = URDF +2.6m（9 号一侧）。手臂笛卡尔点位还没有逆解，未改关节角。

| 关节 | 类型 | 含义 |
|------|------|------|
| `link_002_joint` | prismatic | 导轨，约 -0.1～2.8 m |
| `link_003_joint` | revolute | ER155 J1 |
| `link_004_joint` | revolute | ER155 J2 |
| `joint_6` | revolute | ER155 J3 |
| `link_007_joint` | revolute | ER155 J4 |
| `link_008_joint` | revolute | ER155 J5 |
| `link_009_joint` | revolute | ER155 J6 |
| `link_010_joint` | revolute | 夹具/末端 |
