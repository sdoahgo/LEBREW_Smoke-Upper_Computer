// smoke_protocol.test.mjs — 除烟机协议层自测（无需硬件）
// 运行：node tests/smoke_protocol.test.mjs

import assert from 'node:assert/strict';
import {
  CMD,
  COMMAND_KEY,
  DEVICE_STATES,
  FAULTS,
  SMOKE_BLE,
  SMOKE_SERIAL,
  buildCommand,
  buildFaultEvent,
  buildOtaData,
  buildOtaStart,
  buildTelemetry,
  describeFault,
  frameSerial,
  gearToRpm,
  parseUplink,
  validateSn,
} from '../smoke_protocol.js';
import { MagicLengthFramer, crc16Modbus } from '../comm_link.js';

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log('  PASS  ' + name);
  } catch (error) {
    results.push(false);
    console.log('  FAIL  ' + name + '\n        ' + (error?.stack || error).toString().split('\n').slice(0, 4).join('\n        '));
  }
}

// —— 命令构造 ——
await test('命令帧 = 16B 密钥 + 命令 + 参数', () => {
  const frame = buildCommand(CMD.START_SMOKE, [50]);
  assert.equal(frame.length, 18);
  assert.deepEqual(frame.slice(0, 16), COMMAND_KEY);
  assert.equal(frame[16], CMD.START_SMOKE);
  assert.equal(frame[17], 50);
});

await test('密钥与固件 user_ble.c 一致', () => {
  assert.deepEqual(Array.from(COMMAND_KEY),
    [0xa6, 0xc3, 0xca, 0x4b, 0x9c, 0x1c, 0x46, 0xb8, 0x58, 0xe9, 0x4b, 0xd1, 0xd2, 0xa5, 0x56, 0xa6]);
});

// —— 串口帧 ——
await test('串口帧可被基座 MagicLengthFramer 解出且 CRC 正确', () => {
  const payload = buildCommand(CMD.READ_ALL);
  const frame = frameSerial(payload);
  assert.deepEqual(Array.from(frame.slice(0, 2)), [0x5a, 0xa5]);
  const framer = new MagicLengthFramer(SMOKE_SERIAL.frame);
  const result = framer.push(frame, 'test');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].kind, 'frame');
  assert.deepEqual(result.messages[0].payload, payload);
});

await test('串口帧 CRC 损坏被标记', () => {
  const frame = frameSerial(buildCommand(CMD.READ_VERSION));
  frame[frame.length - 1] ^= 0xff;
  const framer = new MagicLengthFramer(SMOKE_SERIAL.frame);
  const result = framer.push(frame, 'test');
  assert.equal(result.messages[0].kind, 'crc-error');
});

await test('串口帧跨分片到达仍可解出', () => {
  const frame = frameSerial(buildCommand(CMD.SET_GEAR, [70]));
  const framer = new MagicLengthFramer(SMOKE_SERIAL.frame);
  const first = framer.push(frame.slice(0, 5), 'test');
  assert.equal(first.messages.length, 0);
  const second = framer.push(frame.slice(5), 'test');
  assert.equal(second.messages.length, 1);
  assert.deepEqual(second.messages[0].payload, buildCommand(CMD.SET_GEAR, [70]));
});

// —— 遥测帧 ——
await test('遥测帧构造与解析互逆', () => {
  const sample = {
    state: 2, gear: 60, rpm: 3500, inletTemp: 88.6, outletTemp: 315.2, ssrPwm: 47,
    voc: 180, humidity: 41, ambientTemp: 25, purgeLevel: 2, switcherState: 1,
    boostActive: false, faultCode: 0,
  };
  const parsed = parseUplink(buildTelemetry(sample));
  assert.equal(parsed.type, 'telemetry');
  assert.equal(parsed.state, 2);
  assert.equal(parsed.gear, 60);
  assert.equal(parsed.rpm, 3500);
  assert.ok(Math.abs(parsed.inletTemp - 88.6) < 0.051);
  assert.ok(Math.abs(parsed.outletTemp - 315.2) < 0.051);
  assert.equal(parsed.ssrPwm, 47);
  assert.equal(parsed.voc, 180);
  assert.equal(parsed.humidity, 41);
  assert.equal(parsed.purgeLevel, 2);
  assert.equal(parsed.switcherState, 1);
  assert.equal(parsed.faultCode, 0);
});

await test('遥测帧含负温度（小端有符号）', () => {
  const parsed = parseUplink(buildTelemetry({
    state: 0, gear: 0, rpm: 0, inletTemp: -12.3, outletTemp: -5.1, ssrPwm: 0,
  }));
  assert.ok(Math.abs(parsed.inletTemp + 12.3) < 0.051);
  assert.ok(Math.abs(parsed.outletTemp + 5.1) < 0.051);
});

await test('遥测帧 CRC 损坏报 crc-error', () => {
  const frame = buildTelemetry({ state: 1, gear: 10, rpm: 2000 });
  frame[17] ^= 0xff;
  assert.equal(parseUplink(frame).type, 'crc-error');
});

await test('Boost 标志位', () => {
  const parsed = parseUplink(buildTelemetry({ state: 3, boostActive: true }));
  assert.equal(parsed.boostActive, true);
});

await test('挡位 120（Boost 挡）不被截断', () => {
  const parsed = parseUplink(buildTelemetry({ state: 2, gear: 120 }));
  assert.equal(parsed.gear, 120);
});

// —— 故障事件 ——
await test('故障事件构造与解析互逆', () => {
  const parsed = parseUplink(buildFaultEvent(0x03, true));
  assert.equal(parsed.type, 'fault');
  assert.equal(parsed.code, 0x03);
  assert.equal(parsed.active, true);
});

await test('故障码表覆盖设备屏全部 8+ 类文案', () => {
  for (const code of [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x10]) {
    const fault = describeFault(code);
    assert.ok(fault.zh.length > 0, 'code ' + code);
    assert.ok(FAULTS[code]);
  }
});

// —— 读回应答 ——
await test('版本/状态/传感器帧可解析（模拟器构造走 _emit 路径）', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator();
  const seen = [];
  const capture = (payload) => seen.push(parseUplink(payload));
  sim._serialOpen = true;
  const origEmit = sim._emit.bind(sim);
  sim._emit = (payload) => { capture(payload); return origEmit(payload); };
  sim._emitVersion();
  sim._emitState();
  sim._emitSensors();
  sim._emitSettings();
  const [version, stateMsg, sensors, settings] = seen;
  assert.equal(version.type, 'version');
  assert.ok(/^v\d+\.\d+\.\d+$/.test(version.sw));
  assert.equal(stateMsg.type, 'state');
  assert.equal(sensors.type, 'sensors');
  assert.ok(sensors.inletTemp > 0);
  assert.equal(settings.type, 'settings');
  assert.ok(settings.catalyticTemp >= 300 && settings.catalyticTemp <= 330);
});

await test('0xB1 状态帧第 7 字节为切换器位置（旧 6 字节帧兼容为 0）', () => {
  const withGear = parseUplink(Uint8Array.of(0xb1, 0, 50, 2, 2, 0, 3));
  assert.equal(withGear.type, 'state');
  assert.equal(withGear.switcherState, 2);
  assert.equal(withGear.switcherGear, 3);
  const legacy = parseUplink(Uint8Array.of(0xb1, 0, 50, 2, 2, 0));
  assert.equal(legacy.switcherGear, 0);
});

await test('模拟设备：切换器位置命令（已连接生效并推 0xB1，未连接忽略）', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    sim._serialOpen = true;
    const seen = [];
    const origEmit = sim._emit.bind(sim);
    sim._emit = (payload) => { seen.push(parseUplink(payload)); return origEmit(payload); };
    sim._dispatchCommand(CMD.SET_SWITCHER_GEAR, [3]);
    assert.equal(sim.switcherGear, 3);
    const pushed = seen.filter((m) => m.type === 'state').pop();
    assert.equal(pushed.switcherGear, 3);
    sim.switcherState = 0;   // 未连接
    sim._dispatchCommand(CMD.SET_SWITCHER_GEAR, [1]);
    assert.equal(sim.switcherGear, 3);   // 被忽略，保持原位置
  } finally {
    sim.stop();
  }
});

// —— SN 码（设备「设置→关于」页同款规则：PURE+YYMMDD+6位流水，一次写入）——
await test('SN 校验：图示样例 PURE251221000000 合法', () => {
  assert.equal(validateSn('PURE251221000000'), null);
  assert.equal(validateSn('pure251221000000'), null);   // 大小写不敏感（内部统一大写）
});

await test('SN 校验：长度/字符/前缀/流水号错误分别给出原因', () => {
  assert.match(validateSn('PURE25122100000'), /长度/);
  assert.match(validateSn('PURE2512210000-0'), /字母/);
  assert.match(validateSn('PF1C251221000000'), /前 4 位/);
  assert.match(validateSn('PURE25122100000A'), /流水号/);
});

await test('SN 校验：日期合法性（月份/大小月/闰年 0229）', () => {
  assert.match(validateSn('PURE251300000001'), /月份/);   // 13 月
  assert.match(validateSn('PURE250432000001'), /天数/);   // 4 月 32 日
  assert.match(validateSn('PURE260229000001'), /天数/);   // 2026 非闰年，0229 非法
  assert.equal(validateSn('PURE240229000001'), null);     // 2024 闰年，0229 合法
  assert.equal(validateSn('PURE250228000001'), null);     // 2025 平年 0228 合法
});

await test('0xB5 SN 读回帧解析（空 = 未烧录 / 16 字符）', () => {
  const empty = parseUplink(Uint8Array.of(0xb5, 0x00));
  assert.equal(empty.type, 'sn');
  assert.equal(empty.sn, '');
  const ascii = Array.from(new TextEncoder().encode('PURE251221000000'));
  const filled = parseUplink(Uint8Array.of(0xb5, ascii.length, ...ascii));
  assert.equal(filled.type, 'sn');
  assert.equal(filled.sn, 'PURE251221000000');
});

await test('模拟设备：SET_SN 一次写入锁定（合法写入→再写拒绝）并推 0xB5', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    sim._serialOpen = true;
    const seen = [];
    const origEmit = sim._emit.bind(sim);
    sim._emit = (payload) => { seen.push(parseUplink(payload)); return origEmit(payload); };

    sim._dispatchCommand(CMD.READ_SN, []);   // 出厂未烧录 → 空 SN
    assert.equal(seen.filter((m) => m.type === 'sn').pop().sn, '');

    const good = Array.from(new TextEncoder().encode('PURE261008000012'));
    sim._dispatchCommand(CMD.SET_SN, good);  // 首次写入成功
    assert.equal(sim.sn, 'PURE261008000012');
    assert.equal(seen.filter((m) => m.type === 'sn').pop().sn, 'PURE261008000012');

    sim._dispatchCommand(CMD.SET_SN, Array.from(new TextEncoder().encode('PURE261008000013')));
    assert.equal(sim.sn, 'PURE261008000012');   // 已烧录：拒绝改写，保持原值
    assert.equal(seen.filter((m) => m.type === 'sn').pop().sn, 'PURE261008000012');

    sim.clearSn();   // 联调辅助：清除后回到可写（真机等价操作是擦 NVS）
    assert.equal(sim.sn, '');
    sim._dispatchCommand(CMD.SET_SN, good);
    assert.equal(sim.sn, 'PURE261008000012');
  } finally {
    sim.stop();
  }
});

await test('模拟设备：SET_SN 格式非法被拒（空 SN 设备不烧录）', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    sim._serialOpen = true;
    sim._dispatchCommand(CMD.SET_SN, Array.from(new TextEncoder().encode('PF1C250914000001')));
    assert.equal(sim.sn, '');   // 前缀错误：拒绝
    sim._dispatchCommand(CMD.SET_SN, Array.from(new TextEncoder().encode('PURE2512210000')));   // 15 位
    assert.equal(sim.sn, '');
  } finally {
    sim.stop();
  }
});

// —— ACK 与传输包 ——
await test('ACK 解析（固件大端 seq）', () => {
  const parsed = parseUplink(Uint8Array.of(0xa0, 0x00, 0x00, 0x09));
  assert.equal(parsed.type, 'ack');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.seq, 9);
  const nack = parseUplink(Uint8Array.of(0xa0, 0x01, 0x01, 0x00));
  assert.equal(nack.ok, false);
  assert.equal(nack.seq, 256);
});

await test('OTA START 包为固件格式 [0x11][total:4BE][chunk:2BE]', () => {
  const packet = buildOtaStart(123456, 244);
  assert.deepEqual(Array.from(packet), [0x11, 0x00, 0x01, 0xe2, 0x40, 0x00, 0xf4]);
});

await test('OTA 数据包 [seq:2BE][chunk]', () => {
  const packet = buildOtaData(0x0203, Uint8Array.of(1, 2, 3));
  assert.deepEqual(Array.from(packet), [0x02, 0x03, 1, 2, 3]);
});

// —— 挡位转速对照 ——
await test('挡位-转速对照与固件表一致', () => {
  assert.equal(gearToRpm(0), 0);
  assert.equal(gearToRpm(10), 2000);
  assert.equal(gearToRpm(50), 3200);
  assert.equal(gearToRpm(100), 4700);
});

// —— 模拟设备端到端：命令 → 状态机 → 遥测 ——
await test('模拟设备：开始/停止除烟驱动状态机', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    sim.outletTemp = 147; // 让预热在一个节拍内完成，缩短用例耗时
    sim._dispatchCommand(CMD.START_SMOKE, [50]);
    assert.equal(sim.state, 1); // 预热
    for (let i = 0; i < 100 && sim.state === 1; i += 1) await new Promise((r) => setTimeout(r, 30));
    assert.equal(sim.state, 2); // 预热完成进入恒温
    sim._dispatchCommand(CMD.STOP_SMOKE, []);
    assert.equal(sim.state, 4); // 冷却
    sim.outletTemp = 30;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sim.state, 0); // 冷却完成回待机
  } finally {
    sim.stop();
  }
});

await test('0xB0 设置帧第 8 字节为风机上限（旧 7 字节帧兼容为 100）', () => {
  const withLimit = parseUplink(Uint8Array.of(0xb0, 0, 0, 5, 1, 0x4b, 0x0c, 120));
  assert.equal(withLimit.type, 'settings');
  assert.equal(withLimit.memoryMode, 1);
  assert.equal(withLimit.fanLimit, 120);
  const legacy = parseUplink(Uint8Array.of(0xb0, 0, 0, 5, 1, 0x4b, 0x0c));
  assert.equal(legacy.fanLimit, 100);
});

await test('模拟设备：风机上限设置（存档+钳位当前挡位+推送 0xB0）', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    sim._serialOpen = true;
    const seen = [];
    const origEmit = sim._emit.bind(sim);
    sim._emit = (payload) => { seen.push(parseUplink(payload)); return origEmit(payload); };
    sim._dispatchCommand(CMD.SET_FAN_LIMIT, [120]);
    assert.equal(sim.settings.fanLimit, 120);
    const pushed = seen.filter((m) => m.type === 'settings').pop();
    assert.equal(pushed.fanLimit, 120);
    sim.gear = 120;
    sim._dispatchCommand(CMD.SET_FAN_LIMIT, [100]);   // 收紧上限：挡位被钳位
    assert.equal(sim.settings.fanLimit, 100);
    assert.equal(sim.gear, 100);
    sim._dispatchCommand(CMD.SET_GEAR, [120]);        // 上限 100 时设置 120 被钳
    assert.equal(sim.gear, 100);
  } finally {
    sim.stop();
  }
});

await test('模拟设备：重连读状态时同步当前故障（READ_STATE 带 0xA2）', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    sim._serialOpen = true;
    sim.triggerFault(0x04);   // 风扇电机异常
    const seen = [];
    const origEmit = sim._emit.bind(sim);
    sim._emit = (payload) => { seen.push(parseUplink(payload)); return origEmit(payload); };
    sim._dispatchCommand(CMD.READ_STATE, []);   // 模拟重连握手
    const faults = seen.filter((m) => m.type === 'fault');
    assert.equal(faults.length, 1);
    assert.equal(faults[0].code, 0x04);
    assert.equal(faults[0].active, true);
    sim.clearFault();
    seen.length = 0;
    sim._dispatchCommand(CMD.READ_STATE, []);   // 清除后不再同步
    assert.equal(seen.filter((m) => m.type === 'fault').length, 0);
  } finally {
    sim.stop();
  }
});

await test('模拟设备：待机时停止除烟被忽略（不进入出烟/冷却界面）', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    assert.equal(sim.state, 0);
    sim._dispatchCommand(CMD.STOP_SMOKE, []);
    assert.equal(sim.state, 0);   // 仍待机：与实体按键一致，远程停止不许跳过设备逻辑
    sim.state = 4;                // 冷却中
    sim._dispatchCommand(CMD.START_SMOKE, [50]);
    assert.equal(sim.state, 4);   // 冷却中开始同样被忽略
  } finally {
    sim.stop();
  }
});

await test('模拟设备：OTA 传输全流程（窗口 ACK + END）', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    const acks = [];
    const origAck = sim._ack.bind(sim);
    sim._ack = (ok, seq) => { acks.push({ ok, seq }); return origAck(ok, seq); };
    const firmware = new Uint8Array(1000).fill(0xab);
    sim._onTransferControl(buildOtaStart(firmware.length, 100));
    assert.deepEqual(acks[0], { ok: true, seq: 0 });
    const packets = Math.ceil(firmware.length / 100);
    for (let seq = 0; seq < packets; seq += 1) {
      sim._onTransferData(buildOtaData(seq, firmware.subarray(seq * 100, (seq + 1) * 100)));
    }
    assert.equal(acks.length, 2); // START ACK + 最后一包 ACK
    sim._onTransferControl(Uint8Array.of(CMD.OTA_END));
    assert.equal(acks[acks.length - 1].ok, true);
    assert.equal(acks[acks.length - 1].seq, packets - 1);
    assert.equal(sim._transfer, null);
  } finally {
    sim.stop();
  }
});

await test('模拟设备：串口承载 OTA 跨过 seq 256 不被误判为控制包（回归）', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    const acks = [];
    const origAck = sim._ack.bind(sim);
    sim._ack = (ok, seq) => { acks.push({ ok, seq }); return origAck(ok, seq); };
    const firmware = new Uint8Array(244 * 300).fill(0xcd); // 300 包，覆盖 seq 256+
    sim._handlePayload(buildOtaStart(firmware.length, 244));
    assert.equal(acks[0].ok, true);
    for (let seq = 0; seq < 300; seq += 1) {
      sim._handlePayload(buildOtaData(seq, firmware.subarray(seq * 244, (seq + 1) * 244)));
    }
    // 窗口末包必须收到数据 ACK（旧实现 seq>=256 首字节撞控制码被静默丢弃）
    for (const seq of [9, 249, 259, 299]) {
      const hit = acks.find((a) => a.ok && a.seq === seq);
      assert.ok(hit, 'seq ' + seq + ' 未收到 ACK');
    }
    sim._handlePayload(Uint8Array.of(CMD.OTA_END));
    assert.equal(acks[acks.length - 1].seq, 299);
    assert.equal(sim._transfer, null);
  } finally {
    sim.stop();
  }
});

await test('模拟设备：乱序包触发 NACK 重发', async () => {
  const { SmokeSimulator } = await import('../smoke_sim.js');
  const sim = new SmokeSimulator().start();
  try {
    sim._onTransferControl(buildOtaStart(500, 100));
    sim._onTransferData(buildOtaData(0, new Uint8Array(100)));
    const nacks = [];
    const origAck = sim._ack.bind(sim);
    sim._ack = (ok, seq) => { if (!ok) nacks.push(seq); return origAck(ok, seq); };
    sim._onTransferData(buildOtaData(2, new Uint8Array(100))); // 跳过 seq=1
    assert.deepEqual(nacks, [1]); // 期望从 1 重发
  } finally {
    sim.stop();
  }
});

await test('蓝牙 UUID 与固件 0x180D 服务一致', () => {
  assert.ok(SMOKE_BLE.serviceUuid.startsWith('0000180d-'));
  assert.ok(SMOKE_BLE.telemetryUuid.startsWith('00002a37-'));
  assert.ok(SMOKE_BLE.commandUuid.startsWith('00002a38-'));
  assert.ok(SMOKE_BLE.transferCtrlUuid.startsWith('00002a39-'));
  assert.ok(SMOKE_BLE.transferDataUuid.startsWith('00002a40-'));
});

await test('设备状态文案齐全', () => {
  assert.equal(DEVICE_STATES.length, 6);
});

await test('crc16Modbus 标准校验值（Modbus 规范例）', () => {
  // "123456789" 的 CRC16-Modbus = 0x4B37
  assert.equal(crc16Modbus(new TextEncoder().encode('123456789')), 0x4b37);
});

console.log('\n========================================');
console.log('协议层测试 ' + results.length + '，通过 ' + results.filter(Boolean).length + '，失败 ' + results.filter((ok) => !ok).length);
if (results.some((ok) => !ok)) process.exitCode = 1;
