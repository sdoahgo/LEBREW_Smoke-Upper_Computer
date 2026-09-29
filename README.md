# LEBREW SMOKE 除烟机 网页版上位机

电脑本地运行的网页版上位机，通过 **蓝牙（Web Bluetooth）** 或 **串口（Web Serial）** 连接除烟机，
支持整机操作、屏幕同款状态镜像、实时曲线、设置读写与三通道固件升级。
基于通信基座 comm_link（零 npm 依赖，原生 ES Module）。

## 快速开始

    start_server.cmd        一键起服务并用 Edge/Chrome 打开 http://127.0.0.1:8767/app.html
    tests\run_tests.cmd     全部自测（协议 22 + 基座 52 + 前端 5，不需要硬件，需要 Node 18+）

- 页面默认勾选「模拟设备」：不接硬件即可完整体验全部功能（含三条 OTA 通道演练）。
- 连真机：取消勾选，点「连接蓝牙」（设备广播名 `LEBREW SMOKE`）或「连接串口」选 COM 口。
- **浏览器要求 Chrome / Edge**（Web Bluetooth / Web Serial 仅这两家支持）。

## 目录

| 文件 | 作用 |
|---|---|
| `app.html` / `style.css` / `app.js` | 上位机页面（主控 / 实时曲线 / 设置 / 固件升级 / 日志 五标签） |
| `smoke_protocol.js` | 协议层：命令构造、串口 5A A5 帧、遥测/故障/ACK/读回解析（与固件 smoke_cmd 一一对应） |
| `smoke_ble.js` | 四特征蓝牙传输层（0x2A37/38/39/40，扩展自基座 Transport，不改基座） |
| `smoke_sim.js` | 模拟设备：状态机/遥测/故障/OTA/自检/热点模式全套 |
| `comm_link.js` / `comm_panel.js` / `comm_mock.js` | 通信基座（复制自公共资产，未改动） |
| `firmware_patch/` | **固件侧补丁与接入清单**（smoke_cmd / user_console / user_net_ota） |
| `上位机规划.md` | 设计规划（定稿） |
| `old_upper/` · `ref_purefluxion/` · `ref_project/` | 参考材料（旧上位机、PureFluxion 升级参考、基座仓库） |

## 功能一览

- **主控**：屏幕镜像（六态状态、净化等级、切换器、挡位/转速/进出风口温度/催化温度/PWM/VOC/湿度），
  开始/停止除烟、Boost、挡位调节；故障弹窗与横幅（与设备屏同款文案）
- **实时曲线**：进风口温度 / 出风口温度 / 电机转速 / 发热丝 PWM，同一时间轴，可暂停、切时间窗、导出 CSV
- **设置**：与设备设置菜单同款（语言/单位/蜂鸣器/夜间静音/静音上限/Boost 时长/记忆/风机上限/催化温度 300–330℃），
  传感器自检，关于（版本）
- **固件升级**：串口 .bin（5A A5 帧传输）/ 蓝牙（0x2A39/40 窗口 ACK 协议）/ WiFi 热点直传（设备 SoftAP，页面 POST）
- **日志**：双通道原始收发（HEX/文本、暂停、清空、导出）

## 协议摘要（详见 `上位机规划.md` 第三节与 `smoke_protocol.js`）

- 命令：16B 密钥 + 命令字节 + 参数；蓝牙写 0x2A38，串口套 `5A A5 | len:2LE | payload | CRC16`
- 上行：遥测 `0xA1`(17B+CRC)、故障 `0xA2`、读回 `0xB0-B4`、ACK `A0 ok seq:2BE`、文本
- 传输：OTA `0x11/12/13` 控制包 + `seq:2BE+chunk(≤244)` 数据包，每 10 包窗口 ACK，NACK 带重发序号

## 真机联调

固件需要先打上 `firmware_patch/`（命令分发、串口通道、热点 OTA），
接入步骤与对接点见 **`firmware_patch/接入清单.md`**。
