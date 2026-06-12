# 协议交互场景集

本目录用真实抓取的逐帧 JSON 消息,演示 VoxelCraft 两层网络协议在每个关键场景下的完整交互过程。
面向第一次接触本项目的读者:每个场景一个文件,含 mermaid 时序图、逐条消息(标注方向)和"信任边界要点"。

## 权威来源与抓取方法

- 协议的唯一权威实现:`server/index.js`(中继层)、`public/js/host.js`(游戏层·房主端)、
  `public/js/network.js`(中继层客户端)、`public/js/main.js`(游戏层·成员端与编排)。
  架构契约见 `DESIGN.md`。
- 本目录所有 JSON 消息均为**实测抓取**:用环境变量 `PORT` 在空闲端口临时启动一个
  `server/index.js` 实例,以原生 ws 客户端逐帧打印收发内容(抓取脚本为一次性临时文件,未入库)。
- 中继层行为可随时用 `node tools/relay-test.js` 复现(自带 22 项 PASS/FAIL 断言,
  自动在端口 18097 起一个临时服务器)。`tools/host-bot.js` / `tools/member-bot.js`
  是可长跑的游戏层房主/成员机器人,适合手工联调。

## 两层协议速览

JSON 文本帧,WebSocket 路径 `/ws`,入站帧上限 64 KB(超限 ws 自动以 1009 关闭连接)。

**中继层**(服务器唯一理解的内容,零游戏知识):

| 方向 | 消息 |
|---|---|
| 客户端 → 中继 | `host` `join` `list` `msg` `cast` |
| 中继 → 客户端 | `hosted` `accepted` `rooms` `msg`(转发) `peer-in` `peer-out` `promote` `newhost` `error` |

错误码仅四个:`bad-name` `taken` `no-room` `full`。

**游戏层**(封在 `d` 字段内不透明转发,中继**从不解析**;权威逻辑跑在房主浏览器标签页里):

| 方向 | 消息 |
|---|---|
| 成员 → 房主 | `hello` `move` `block` |
| 房主 → 成员 | `joined` `pjoin` `pmove` `pleave` `block` `resync` |

## 阅读约定

- 方向标注:`成员M1 → 中继` 表示一条上行 ws 帧;`中继 → 房主A` 表示一条下行 ws 帧。
  游戏层语义上的"成员 → 房主"在线路上永远是两帧:成员发 `{t:'msg', d}` 给中继,
  中继转发 `{t:'msg', from, d}` 给房主。
- 每个连接获得一个整数 id(每次服务器运行从 1 起递增,连接建立即分配)。
  示例中的 id 来自一次真实抓取会话:房主 A=1、成员 M1=4、M2=5、M3=19 等,
  数值本身无含义,只保证同一会话内唯一。
- 示例房间「石榴小镇」、玩家 阿石/小梅/小树/阿迁 贯穿多个场景,前后帧可以互相对照。

## 场景目录

| 文件 | 场景 |
|---|---|
| [01-host-room.md](01-host-room.md) | 建房成功 / 房名被占(taken)/ 非法房名(bad-name) |
| [02-join-room.md](02-join-room.md) | 加入成功(accepted + peer-in)/ 房间不存在(no-room)/ 满员(full) |
| [03-lobby-list.md](03-lobby-list.md) | 大厅 `list` → `rooms`:公开房、players 计数、meta 透传 |
| [04-hello-handshake.md](04-hello-handshake.md) | 入房握手:`hello` → `joined` + `pjoin` 广播 |
| [05-move-sync.md](05-move-sync.md) | 移动同步:`move` → `pmove`(except 发送者) |
| [06-block-convergence.md](06-block-convergence.md) | 放块收敛:`block` 全员回声(含发起者)、幂等重放 |
| [07-host-migration.md](07-host-migration.md) | 房主迁移:`promote` + `newhost` → 重发 `hello` → `resync` |
| [08-member-leave.md](08-member-leave.md) | 成员离开:close → `peer-out` → `pleave` |
| [09-msg-routing.md](09-msg-routing.md) | `msg` 路由规则:成员只达房主;房主必须带 `to` |
| [10-heartbeat.md](10-heartbeat.md) | 心跳活性:10s ping/pong,死连接 terminate |
