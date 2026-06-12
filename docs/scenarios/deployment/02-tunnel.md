# 场景 02:外网隧道联机(cloudflared quick tunnel)

## 目标

不买服务器、不配端口映射,把跑在自己电脑上的 VoxelCraft 服务器临时暴露到公网,
让任何地方的朋友(网页或 App)都能进你的房间。适合临时开黑、功能演示;
**不适合长期运营**(域名每次重启会变,见下文)。

## 前提

- 场景 01 已经跑通:本机 `http://localhost:8080` 能正常进游戏。
- 下载 cloudflared 可执行文件。**本仓库不含该 exe**(`tools/bin/` 在 `.gitignore`
  里被排除,不随仓库分发),请从官方渠道获取:
  - 官方发布页:<https://github.com/cloudflare/cloudflared/releases>
    (Windows 选 `cloudflared-windows-amd64.exe`,下载后可改名为 `cloudflared.exe`)
  - 官方文档(各平台安装方式):<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>
- quick tunnel 模式**不需要注册 Cloudflare 账号**。

## 操作步骤

1. 启动游戏服务器(`npm start` 或 `start.cmd`),确认 8080 端口已在监听。
2. 另开一个终端,启动隧道(假设 exe 放在 `tools/bin/` 下,放哪都行):

   ```powershell
   tools\bin\cloudflared.exe tunnel --url http://localhost:8080
   ```

3. 等 cloudflared 输出一个形如 `https://xxxx-yyyy.trycloudflare.com` 的地址。
   这就是你的临时公网入口,把它发给朋友。
4. 朋友侧两种接入方式,任选:
   - **网页**:直接浏览器打开 `https://xxxx-yyyy.trycloudflare.com`。
     页面、WebSocket 都走这条隧道,"服务器地址"留空(= 本站)即可。
   - **App / 已打开的本地网页**:不换页面,只在大厅"服务器地址"输入框填
     `xxxx-yyyy.trycloudflare.com`(裸域名,不带 `https://` 也行——
     无端口的裸域名按 `wss://` 安全连接处理,见 `public/js/network.js` 的 `relayUrl`),
     点"刷新"重连即可看到你的房间。
5. 玩完后 `Ctrl+C` 关掉 cloudflared,隧道即消失。

## 预期结果

- 朋友无论在哪个网络(异地宽带、手机流量)都能进房;
  你本机继续用 `localhost:8080`,两边在同一个房间相遇。
- cloudflared 控制台能看到请求与连接日志;游戏服务器控制台照常打印进出房日志。

## 重要特性:域名每次重启会变

quick tunnel 的 `*.trycloudflare.com` 域名是**每次启动随机分配**的,
重启 cloudflared 就换一个。应对方式:

- 把新域名重新发给朋友;
- 朋友**不需要重装 App、也不需要换页面**——只要在 App(或网页)大厅的
  "服务器地址"输入框改成新域名再点刷新即可。该输入框的值会持久保存
  (localStorage 键 `vc-server`),优先级高于 App 打包时烤入的默认地址。

想要固定地址,见[场景 06:自建公网中继](06-self-hosted-relay.md)。

## 常见故障与排查

| 现象 | 原因与处理 |
|---|---|
| cloudflared 启动报错连不上上游 | 先确认本机 `http://localhost:8080` 能打开;`--url` 里写的端口要和游戏服务器实际端口一致(换过 `PORT` 的话同步改)。 |
| 朋友打开隧道页面很慢 / 时好时坏 | quick tunnel 经 Cloudflare 境外节点中转,中国大陆访问延迟与丢包看运气,属正常现象。长期方案是把本项目部署到一台延迟可控的服务器(场景 06)。 |
| 朋友在服务器地址栏填了完整 `https://xxxx.trycloudflare.com/` 还带斜杠 | 没关系,`relayUrl` 会剔除路径并按 `wss://` 连接;但**不要**手滑写成 `域名:443` 这种"裸 host:port"形式——带端口的裸地址按 `ws://` 明文处理,隧道只收 TLS,会连不上。直接填裸域名最稳。 |
| 房间列表是空的 | 列表只显示**公开**房间;私密房不出现在列表,只能凭房间名输入进入。另外确认两边连的是同一个地址(看大厅顶部连接状态行)。 |
| 隧道正常但进房后频繁掉线 | 中继每 10 秒对所有连接做 ping/pong 活性检查,网络抖动超时会被判定断线。房主掉线不毁房:最老成员自动接任(见[场景 04](04-host-migration.md))。 |
| 担心陌生人进房 | trycloudflare 域名随机性提供的是"不易被猜到",不是访问控制;建房时**不勾选公开**可避免出现在房间列表,但知道房间名的人仍可进入。当前版本无房间密码。 |
