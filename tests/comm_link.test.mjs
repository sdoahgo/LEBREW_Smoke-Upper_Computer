// comm_link.test.mjs — 通信核心自测（无需硬件）
// 运行：node tests/comm_link.test.mjs

import assert from 'node:assert/strict';
import {
  BleTransport,
  LineFramer,
  Link,
  MagicLengthFramer,
  SerialTransport,
  TransportState,
  bytesToHex,
  crc16Modbus,
  ensureLineEnding,
  isLikelyAsciiLine,
  trimTrailingZeros,
} from '../comm_link.js';
import {
  buildFrame,
  createMockBluetooth,
  createMockSerial,
} from '../comm_mock.js';
import { NEXT_LIVE_FRAME, createNextLiveFramer, parseNextLiveFrame } from '../examples/next.js';

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log('\n[' + name + ']');
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ group: currentGroup, name, ok: true });
    console.log('  PASS  ' + name);
  } catch (error) {
    results.push({ group: currentGroup, name, ok: false, error });
    const detail = error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n        ') : String(error);
    console.log('  FAIL  ' + name + '\n        ' + detail);
  }
}

function tick(times = 3) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return chain;
}

const GENERIC_FRAME = {
  magic: [0x01, 0x02],
  lengthSize: 2,
  trailer: [0x0d, 0x0a],
  crc: crc16Modbus,
  crcRange: 'payload',
  crcSize: 2,
};

function genericFrame(payloadBytes) {
  return buildFrame({ ...GENERIC_FRAME, payload: payloadBytes });
}

function payloadOf(length, seed = 0) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (seed + i * 7) & 0xff;
  return bytes;
}

group('工具函数');
await test('bytesToHex 大写空格分隔', () => {
  assert.equal(bytesToHex(new Uint8Array([0xaa, 0x55, 0x0f])), 'AA 55 0F');
  assert.equal(bytesToHex(new Uint8Array(0)), '');
});
await test('trimTrailingZeros 去掉尾部 0x00', () => {
  assert.deepEqual([...trimTrailingZeros(new Uint8Array([0x41, 0x00, 0x00]))], [0x41]);
  assert.deepEqual([...trimTrailingZeros(new Uint8Array([0, 0, 0]))], []);
});
await test('isLikelyAsciiLine 判定', () => {
  assert.equal(isLikelyAsciiLine(new TextEncoder().encode('OK:1')), true);
  assert.equal(isLikelyAsciiLine(new Uint8Array([0xaa, 0x55])), false);
  assert.equal(isLikelyAsciiLine(new Uint8Array(0)), false);
});
await test('ensureLineEnding 统一行尾', () => {
  assert.equal(ensureLineEnding('CMD'), 'CMD\r\n');
  assert.equal(ensureLineEnding('CMD\n'), 'CMD\r\n');
  assert.equal(ensureLineEnding('  '), '');
  assert.equal(ensureLineEnding('CMD', '\n'), 'CMD\n');
});
await test('crc16Modbus 标准校验值 0x4B37', () => {
  assert.equal(crc16Modbus(new TextEncoder().encode('123456789')), 0x4b37);
});

group('LineFramer 文本行组帧');
await test('一次收到两行（含 CRLF）', () => {
  const framer = new LineFramer();
  const result = framer.push(new TextEncoder().encode('A:1\nB:2\r\n'));
  assert.equal(result.claimed, true);
  assert.deepEqual(result.messages.map((m) => m.text), ['A:1', 'B:2']);
});
await test('跨分片拼接半行', () => {
  const framer = new LineFramer();
  assert.equal(framer.push(new TextEncoder().encode('Y_time')).messages.length, 0);
  const result = framer.push(new TextEncoder().encode(':12\n'));
  assert.deepEqual(result.messages.map((m) => m.text), ['Y_time:12']);
});
await test('UTF-8 多字节字符跨分片', () => {
  const framer = new LineFramer({ accept: () => true });
  const full = new TextEncoder().encode('状态:完成\n');
  framer.push(full.slice(0, 5));
  const result = framer.push(full.slice(5));
  assert.deepEqual(result.messages.map((m) => m.text), ['状态:完成']);
});
await test('二进制字节不认领', () => {
  const framer = new LineFramer();
  const result = framer.push(new Uint8Array([0xaa, 0x55, 0x00, 0xff]));
  assert.equal(result.claimed, false);
});
await test('空行被忽略', () => {
  const framer = new LineFramer();
  const result = framer.push(new TextEncoder().encode('\n\nA\n'));
  assert.deepEqual(result.messages.map((m) => m.text), ['A']);
});

group('MagicLengthFramer 二进制帧组帧');
await test('整帧一次到达', () => {
  const framer = new MagicLengthFramer(GENERIC_FRAME);
  const frame = genericFrame(payloadOf(12));
  const result = framer.push(frame);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].kind, 'frame');
  assert.deepEqual([...result.messages[0].payload], [...payloadOf(12)]);
});
await test('逐字节到达仍能组帧', () => {
  const framer = new MagicLengthFramer(GENERIC_FRAME);
  const frame = genericFrame(payloadOf(8, 3));
  let frames = 0;
  for (const byte of frame) {
    frames += framer.push(new Uint8Array([byte])).messages.filter((m) => m.kind === 'frame').length;
  }
  assert.equal(frames, 1);
});
await test('帧前有垃圾字节仍能定位', () => {
  const framer = new MagicLengthFramer(GENERIC_FRAME);
  const frame = genericFrame(payloadOf(6));
  const noise = new Uint8Array([0x00, 0x12, 0x34, 0x01]);
  const merged = new Uint8Array(noise.length + frame.length);
  merged.set(noise, 0);
  merged.set(frame, noise.length);
  const result = framer.push(merged);
  assert.equal(result.messages.filter((m) => m.kind === 'frame').length, 1);
});
await test('一次到达两帧', () => {
  const framer = new MagicLengthFramer(GENERIC_FRAME);
  const a = genericFrame(payloadOf(4, 1));
  const b = genericFrame(payloadOf(9, 2));
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  const result = framer.push(merged);
  assert.equal(result.messages.filter((m) => m.kind === 'frame').length, 2);
  assert.deepEqual([...result.messages[1].payload], [...payloadOf(9, 2)]);
});
await test('CRC 错误被标记且不丢后续帧', () => {
  const framer = new MagicLengthFramer(GENERIC_FRAME);
  const bad = genericFrame(payloadOf(5));
  bad[bad.length - 3] ^= 0xff;
  const good = genericFrame(payloadOf(5, 7));
  const merged = new Uint8Array(bad.length + good.length);
  merged.set(bad, 0);
  merged.set(good, bad.length);
  const result = framer.push(merged);
  assert.equal(result.messages[0].kind, 'crc-error');
  assert.equal(result.messages[1].kind, 'frame');
});
await test('半帧挂起，不误判', () => {
  const framer = new MagicLengthFramer(GENERIC_FRAME);
  const frame = genericFrame(payloadOf(10));
  assert.equal(framer.push(frame.slice(0, 5)).messages.length, 0);
  assert.equal(framer.push(frame.slice(5)).messages.length, 1);
});
await test('断言载荷长度时非法长度会重新同步', () => {
  const framer = new MagicLengthFramer({ ...GENERIC_FRAME, payloadLength: 8 });
  const fake = buildFrame({ ...GENERIC_FRAME, payload: payloadOf(3) });
  const good = genericFrame(payloadOf(8));
  const merged = new Uint8Array(fake.length + good.length);
  merged.set(fake, 0);
  merged.set(good, fake.length);
  const result = framer.push(merged);
  assert.equal(result.messages.filter((m) => m.kind === 'frame').length, 1);
});
await test('不配 CRC 时只分帧不校验', () => {
  const framer = new MagicLengthFramer({ magic: [0x7e], lengthSize: 1 });
  const frame = buildFrame({ magic: [0x7e], lengthSize: 1, payload: payloadOf(3) });
  const result = framer.push(frame);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].kind, 'frame');
  assert.equal(result.messages[0].expected, null);
});
await test('CRC 覆盖范围三种模式都能配', () => {
  for (const crcRange of ['payload', 'lengthAndPayload', 'headerAndPayload']) {
    const options = { ...GENERIC_FRAME, crcRange };
    const framer = new MagicLengthFramer(options);
    const result = framer.push(buildFrame({ ...options, payload: payloadOf(6) }));
    assert.equal(result.messages[0].kind, 'frame', crcRange + ' 应校验通过');
  }
});
await test('缺少 magic 直接报错', () => {
  assert.throws(() => new MagicLengthFramer({}), /magic/);
  assert.throws(() => new MagicLengthFramer({ magic: [] }), /magic/);
});
await test('crcRange 取值非法直接报错', () => {
  assert.throws(() => new MagicLengthFramer({ magic: [0x01], crcRange: 'nope' }), /crcRange/);
});
await test('NEXT 预设能解析出 27 字节实时帧', () => {
  const payload = payloadOf(20, 11);
  const frame = buildFrame({ ...NEXT_LIVE_FRAME, payload });
  assert.equal(frame.length, 27);
  const result = createNextLiveFramer().push(frame);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].kind, 'frame');
  const parsed = parseNextLiveFrame(result.messages[0].payload);
  assert.equal(typeof parsed.curveAgtron, 'number');
  assert.equal(parsed.voice, payload[4]);
  assert.equal(parsed.recordNo, payload[18] | (payload[19] << 8));
});

group('SerialTransport 串口传输');
await test('连接时按参数打开串口', async () => {
  const mock = createMockSerial();
  const transport = new SerialTransport({ serial: mock.serial, baudRate: 921600, bufferSize: 131072 });
  await transport.connect();
  assert.equal(transport.state, TransportState.CONNECTED);
  const options = mock.port.openedOptions[0];
  assert.equal(options.baudRate, 921600);
  assert.equal(options.dataBits, 8);
  assert.equal(options.stopBits, 1);
  assert.equal(options.parity, 'none');
  assert.equal(options.flowControl, 'none');
  assert.equal(options.bufferSize, 131072);
  await transport.disconnect();
});
await test('默认不传 bufferSize，openOptions 可覆盖', async () => {
  const mock = createMockSerial();
  const transport = new SerialTransport({ serial: mock.serial });
  await transport.connect();
  assert.equal('bufferSize' in mock.port.openedOptions[0], false);
  await transport.disconnect();

  const mock2 = createMockSerial();
  const transport2 = new SerialTransport({ serial: mock2.serial, openOptions: { stopBits: 2 } });
  await transport2.connect();
  assert.equal(mock2.port.openedOptions[0].stopBits, 2);
  await transport2.disconnect();
});
await test('设备字节触发 data 事件', async () => {
  const mock = createMockSerial();
  const transport = new SerialTransport({ serial: mock.serial });
  const received = [];
  transport.on('data', ({ bytes }) => received.push([...bytes]));
  await transport.connect();
  mock.port.emit(new Uint8Array([0x41, 0x42]));
  await tick();
  assert.deepEqual(received, [[0x41, 0x42]]);
  await transport.disconnect();
});
await test('write 落到串口写入器', async () => {
  const mock = createMockSerial();
  const transport = new SerialTransport({ serial: mock.serial });
  await transport.connect();
  await transport.write(new TextEncoder().encode('PING\r\n'));
  assert.equal(mock.port.writtenText, 'PING\r\n');
  await transport.disconnect();
});
await test('断开时取消读取、释放写入器并关闭端口', async () => {
  const mock = createMockSerial();
  const transport = new SerialTransport({ serial: mock.serial });
  await transport.connect();
  await transport.disconnect();
  assert.equal(transport.state, TransportState.DISCONNECTED);
  assert.equal(mock.port.cancelCount, 1);
  assert.equal(mock.port.closeCount, 1);
  assert.equal(transport.reader, null);
  assert.equal(transport.writer, null);
});
await test('断开后可重新连接', async () => {
  const mock = createMockSerial();
  const transport = new SerialTransport({ serial: mock.serial });
  await transport.connect();
  await transport.disconnect();
  await transport.connect();
  assert.equal(transport.state, TransportState.CONNECTED);
  assert.equal(mock.port.openCount, 2);
  await transport.disconnect();
  assert.equal(mock.port.closeCount, 2);
});
await test('用户取消选择串口', async () => {
  const mock = createMockSerial({ requestFails: true });
  const transport = new SerialTransport({ serial: mock.serial });
  await assert.rejects(() => transport.connect(), (error) => error.code === 'DEVICE_NOT_SELECTED');
  assert.equal(transport.state, TransportState.DISCONNECTED);
});
await test('浏览器不支持 Web Serial', async () => {
  const transport = new SerialTransport({ serial: null });
  await assert.rejects(() => transport.connect(), (error) => error.code === 'SERIAL_UNSUPPORTED');
  assert.equal(transport.state, TransportState.DISCONNECTED);
});
await test('打开失败时关闭端口并抛 OPEN_FAILED', async () => {
  const mock = createMockSerial({ openFails: true });
  const transport = new SerialTransport({ serial: mock.serial });
  await assert.rejects(() => transport.connect(), (error) => error.code === 'OPEN_FAILED');
  assert.equal(mock.port.closeCount, 1);
  assert.equal(transport.state, TransportState.DISCONNECTED);
});
await test('未连接时 write 抛 NOT_CONNECTED', async () => {
  const transport = new SerialTransport({ serial: createMockSerial().serial });
  await assert.rejects(() => transport.write(new Uint8Array([1])), (error) => error.code === 'NOT_CONNECTED');
});

group('BleTransport 蓝牙传输');
await test('连接后自动打开 Notify，并把 filters 传给 requestDevice', async () => {
  const mock = createMockBluetooth();
  const transport = new BleTransport({
    bluetooth: mock.bluetooth,
    filters: [{ namePrefix: 'MY-DEVICE' }],
    serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
    characteristicUuid: '0000fff1-0000-1000-8000-00805f9b34fb',
  });
  await transport.connect();
  assert.equal(transport.state, TransportState.CONNECTED);
  assert.equal(transport.notifyOpen, true);
  assert.equal(mock.state.notifyCount, 1);
  assert.equal(mock.requestCalls[0].filters[0].namePrefix, 'MY-DEVICE');
  assert.deepEqual(mock.requestCalls[0].optionalServices, ['0000fff0-0000-1000-8000-00805f9b34fb']);
});
await test('支持 acceptAllDevices 通用选择器', async () => {
  const mock = createMockBluetooth();
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true, autoNotify: false });
  await transport.connect();
  assert.equal(mock.requestCalls[0].acceptAllDevices, true);
  assert.equal(transport.notifyOpen, false);
  assert.equal(transport.isConnected, true);
});
await test('不给 filters 也不给 acceptAllDevices 时报错', async () => {
  const mock = createMockBluetooth();
  const transport = new BleTransport({ bluetooth: mock.bluetooth });
  await assert.rejects(() => transport.connect(), (error) => error.code === 'BLE_FILTER_REQUIRED');
});
await test('不给 UUID 时自动取第一个服务与特征', async () => {
  const mock = createMockBluetooth();
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true });
  await transport.connect();
  assert.equal(transport.characteristic, mock.characteristic);
  assert.equal(transport.notifyOpen, true);
});
await test('特征不支持 notify 时不订阅但保持连接', async () => {
  const mock = createMockBluetooth({ properties: { write: true } });
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true });
  await transport.connect();
  assert.equal(transport.isConnected, true);
  assert.equal(transport.notifyOpen, false);
  assert.equal(mock.state.notifyCount, 0);
  await transport.write(new Uint8Array([1]));
  assert.equal(mock.characteristic.written.length, 1);
});
await test('通知触发 data 事件', async () => {
  const mock = createMockBluetooth();
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true });
  const received = [];
  transport.on('data', ({ bytes }) => received.push([...bytes]));
  await transport.connect();
  const delivered = mock.feed(new Uint8Array([0xaa, 0x55]));
  await tick();
  assert.equal(delivered, 1);
  assert.deepEqual(received, [[0xaa, 0x55]]);
});
await test('优先使用 writeValueWithResponse', async () => {
  const mock = createMockBluetooth({ withResponse: true });
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true });
  await transport.connect();
  await transport.write(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...mock.characteristic.written[0]], [1, 2, 3]);
});
await test('无 writeValueWithResponse 时退回 writeValue', async () => {
  const mock = createMockBluetooth({ withResponse: false });
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true });
  await transport.connect();
  await transport.write(new Uint8Array([4, 5]));
  assert.deepEqual([...mock.characteristic.written[0]], [4, 5]);
});
await test('掉线后状态复位且 Notify 关闭', async () => {
  const mock = createMockBluetooth();
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true });
  await transport.connect();
  let disconnected = 0;
  transport.on('disconnected', () => {
    disconnected += 1;
  });
  mock.simulateDisconnect();
  await tick();
  assert.equal(disconnected, 1);
  assert.equal(transport.state, TransportState.DISCONNECTED);
  assert.equal(transport.notifyOpen, false);
});
await test('重连后重新打开 Notify', async () => {
  const mock = createMockBluetooth();
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true });
  await transport.connect();
  mock.simulateDisconnect();
  await tick();
  await transport.connect();
  assert.equal(transport.notifyOpen, true);
  assert.equal(mock.state.notifyCount, 2);
  assert.equal(mock.device.connectCount, 2);
});
await test('未连接时 write 抛 NOT_CONNECTED', async () => {
  const transport = new BleTransport({ bluetooth: createMockBluetooth().bluetooth, acceptAllDevices: true });
  await assert.rejects(() => transport.write(new Uint8Array([1])), (error) => error.code === 'NOT_CONNECTED');
});
await test('浏览器不支持 Web Bluetooth', async () => {
  const transport = new BleTransport({ bluetooth: null, acceptAllDevices: true });
  await assert.rejects(() => transport.connect(), (error) => error.code === 'BLE_UNSUPPORTED');
});
await test('用户取消选择设备', async () => {
  const mock = createMockBluetooth({ requestFails: true });
  const transport = new BleTransport({ bluetooth: mock.bluetooth, acceptAllDevices: true });
  await assert.rejects(() => transport.connect(), (error) => error.code === 'DEVICE_NOT_SELECTED');
  assert.equal(transport.state, TransportState.DISCONNECTED);
});

group('Link 收发与组帧路由');
await test('二进制帧走 MagicLengthFramer，文本行走 LineFramer', async () => {
  const mock = createMockSerial();
  const transport = new SerialTransport({ serial: mock.serial });
  const link = new Link();
  link.add(transport);
  link.use(new MagicLengthFramer(GENERIC_FRAME));
  link.use(new LineFramer());
  const messages = [];
  link.on('message', (message) => messages.push(message));
  await transport.connect();

  mock.port.emit(genericFrame(payloadOf(6, 2)));
  await tick();
  mock.port.emit(new TextEncoder().encode('Y_time:12,FC_time:34\n'));
  await tick();

  assert.equal(messages.length, 2);
  assert.equal(messages[0].kind, 'frame');
  assert.deepEqual([...messages[0].payload], [...payloadOf(6, 2)]);
  assert.equal(messages[1].kind, 'line');
  assert.equal(messages[1].text, 'Y_time:12,FC_time:34');
  await transport.disconnect();
});
await test('解析器可以只挂到指定通道', async () => {
  const serialMock = createMockSerial();
  const bleMock = createMockBluetooth();
  const link = new Link();
  link.add(new SerialTransport({ serial: serialMock.serial }));
  link.add(new BleTransport({ bluetooth: bleMock.bluetooth, acceptAllDevices: true }));
  link.use(new LineFramer(), { target: 'BLE' });
  const messages = [];
  link.on('message', (message) => messages.push(message.transport.name));
  const unhandled = [];
  link.on('unhandled', (entry) => unhandled.push(entry.transport.name));
  await link.get('UART0').connect();
  await link.get('BLE').connect();

  serialMock.port.emit(new TextEncoder().encode('A\n'));
  bleMock.feed(new TextEncoder().encode('B\n'));
  await tick();

  assert.deepEqual(messages, ['BLE']);
  assert.deepEqual(unhandled, ['UART0']);
  await link.disconnectAll();
});
await test('按目标名选择发送通道并补行尾', async () => {
  const serialMock = createMockSerial();
  const bleMock = createMockBluetooth();
  const link = new Link();
  const serial = link.add(new SerialTransport({ serial: serialMock.serial }));
  const ble = link.add(new BleTransport({ bluetooth: bleMock.bluetooth, acceptAllDevices: true }));
  await serial.connect();
  await ble.connect();

  const sent = await link.send('START', { targets: ['BLE'] });
  assert.deepEqual(sent, ['BLE']);
  assert.equal(serialMock.port.writtenBytes, 0);
  assert.equal(new TextDecoder().decode(bleMock.characteristic.written[0]), 'START\r\n');

  const both = await link.send('BOTH');
  assert.deepEqual(both.sort(), ['BLE', 'UART0']);
  assert.equal(serialMock.port.writtenText, 'BOTH\r\n');
  await link.disconnectAll();
});
await test('空命令不发送', async () => {
  const serialMock = createMockSerial();
  const link = new Link();
  const serial = link.add(new SerialTransport({ serial: serialMock.serial }));
  await serial.connect();
  const sent = await link.send('   ');
  assert.deepEqual(sent, []);
  assert.equal(serialMock.port.writtenBytes, 0);
  await link.disconnectAll();
});
await test('通道未连接时抛错，另一通道仍收到', async () => {
  const serialMock = createMockSerial();
  const bleMock = createMockBluetooth();
  const link = new Link();
  link.add(new SerialTransport({ serial: serialMock.serial }));
  link.add(new BleTransport({ bluetooth: bleMock.bluetooth, acceptAllDevices: true }));
  const errors = [];
  link.on('error', (error) => errors.push(error.code));
  await link.get('UART0').connect();

  const sent = await link.send('PING');
  assert.deepEqual(sent, ['UART0']);
  assert.deepEqual(errors, ['NOT_CONNECTED']);
  await link.disconnectAll();
});
await test('全部通道失败时抛出首个错误', async () => {
  const link = new Link();
  link.add(new SerialTransport({ serial: createMockSerial().serial }));
  await assert.rejects(() => link.send('PING'), (error) => error.code === 'NOT_CONNECTED');
});
await test('rx / tx 事件带 hex', async () => {
  const serialMock = createMockSerial();
  const link = new Link();
  const serial = link.add(new SerialTransport({ serial: serialMock.serial }));
  const rx = [];
  const tx = [];
  link.on('rx', (entry) => rx.push(entry.hex));
  link.on('tx', (entry) => tx.push(entry.hex));
  link.use(new LineFramer());
  await serial.connect();
  await link.send('PING');
  serialMock.port.emit(new TextEncoder().encode('OK\n'));
  await tick();
  assert.deepEqual(tx, ['50 49 4E 47 0D 0A']);
  assert.deepEqual(rx, ['4F 4B 0A']);
  await link.disconnectAll();
});

const failed = results.filter((result) => !result.ok);
console.log('\n========================================');
console.log('用例总数 ' + results.length + '，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
if (failed.length > 0) {
  for (const item of failed) console.log('  x [' + item.group + '] ' + item.name);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
