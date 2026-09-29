// smoke_protocol.js — 除烟机（LEBREW SMOKE）上位机协议层
// 蓝牙与串口共用同一套命令载荷；串口方向再套一层 5A A5 帧。
// 与固件补丁 firmware_patch/smoke_cmd.h 里的定义一一对应。

import { crc16Modbus } from './comm_link.js';

// ---------------------------------------------------------------------------
// 蓝牙服务与特征（固件 user_ble.c 现状，NimBLE 16 位 UUID 转 128 位标准形式）
// ---------------------------------------------------------------------------

const u16 = (value) => value.toString(16).padStart(8, '0');

export const SMOKE_BLE = Object.freeze({
  namePrefix: 'LEBREW',
  serviceUuid: u16(0x180d) + '-0000-1000-8000-00805f9b34fb',
  telemetryUuid: u16(0x2a37) + '-0000-1000-8000-00805f9b34fb',   // Notify：遥测/故障/文本
  commandUuid: u16(0x2a38) + '-0000-1000-8000-00805f9b34fb',     // Write：参数命令（16B 密钥前缀）
  transferCtrlUuid: u16(0x2a39) + '-0000-1000-8000-00805f9b34fb', // Write+Notify：传输控制/ACK
  transferDataUuid: u16(0x2a40) + '-0000-1000-8000-00805f9b34fb', // WriteNoResponse：传输数据
});

// ---------------------------------------------------------------------------
// 串口承载帧：5A A5 | len:2B 小端(=payload 长度) | payload | CRC16-Modbus(2B LE，覆盖 len+payload)
// 与基座 MagicLengthFramer 的 lengthAndPayload 语义一致
// ---------------------------------------------------------------------------

export const SMOKE_SERIAL = Object.freeze({
  baudRate: 115200,
  frame: Object.freeze({
    magic: [0x5a, 0xa5],
    lengthSize: 2,
    crc: crc16Modbus,
    crcRange: 'lengthAndPayload',
    crcSize: 2,
  }),
});

// 参数命令的 16 字节密钥（固件 user_ble.c command_parameter，原样保留）
export const COMMAND_KEY = Uint8Array.of(
  0xa6, 0xc3, 0xca, 0x4b, 0x9c, 0x1c, 0x46, 0xb8,
  0x58, 0xe9, 0x4b, 0xd1, 0xd2, 0xa5, 0x56, 0xa6,
);

// ---------------------------------------------------------------------------
// 命令号（0x20 起为新增；传输类沿用固件现有编号）
// ---------------------------------------------------------------------------

export const CMD = Object.freeze({
  START_SMOKE: 0x20,      // [挡位 0-100]
  STOP_SMOKE: 0x21,       //
  BOOST_ON: 0x22,         // [时长分钟，0=用设置值]
  BOOST_OFF: 0x23,        //
  SET_GEAR: 0x24,         // [挡位 0-100]
  SET_LANGUAGE: 0x26,     // [0 中 1 英]
  SET_TEMP_UNIT: 0x27,    // [0℃ 1℉]
  SET_SWITCHER_GEAR: 0x28, // [切换器位置 1 左开 2 双开 3 右开]
  SET_BOOST_DURATION: 0x2d, // [5/10/15]
  SET_MEMORY_MODE: 0x2e,  // [0 保持上次 1 默认]
  SET_CATALYTIC_TEMP: 0x30, // [温度 x0.1℃ 2B LE]
  SELF_TEST: 0x32,        //
  READ_ALL: 0x40,         //
  READ_STATE: 0x41,       //
  READ_SENSORS: 0x42,     //
  READ_VERSION: 0x43,     //
  TELEMETRY_CFG: 0x50,    // [使能 0/1][周期 ms 2B LE]
  ENTER_AP_OTA: 0x60,     // 进入热点升级模式（重启）
  OTA_START: 0x11,        // [total 4B BE][chunk 2B BE]（沿用固件）
  OTA_END: 0x12,          //
  OTA_ABORT: 0x13,        //
});

// ---------------------------------------------------------------------------
// 下行（上位机 → 设备）构造
// ---------------------------------------------------------------------------

export function buildCommand(cmd, args = []) {
  const argBytes = args instanceof Uint8Array ? args : Uint8Array.from(args);
  const out = new Uint8Array(COMMAND_KEY.length + 1 + argBytes.length);
  out.set(COMMAND_KEY, 0);
  out[COMMAND_KEY.length] = cmd & 0xff;
  out.set(argBytes, COMMAND_KEY.length + 1);
  return out;
}

export function frameSerial(payload, frame = SMOKE_SERIAL.frame) {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const headerLength = frame.magic.length + frame.lengthSize;
  const out = new Uint8Array(headerLength + body.length + frame.crcSize);
  out.set(frame.magic, 0);
  out[frame.magic.length] = body.length & 0xff;
  out[frame.magic.length + 1] = (body.length >> 8) & 0xff;
  out.set(body, headerLength);
  const crc = crc16Modbus(out.slice(frame.magic.length, headerLength + body.length));
  out[headerLength + body.length] = crc & 0xff;
  out[headerLength + body.length + 1] = (crc >> 8) & 0xff;
  return out;
}

// 传输控制包（OTA START/END/ABORT）：蓝牙写 0x2A39；串口作为 payload 套帧
export function buildOtaStart(totalBytes, chunkSize) {
  const out = new Uint8Array(7);
  out[0] = CMD.OTA_START;
  out[1] = (totalBytes >>> 24) & 0xff;
  out[2] = (totalBytes >>> 16) & 0xff;
  out[3] = (totalBytes >>> 8) & 0xff;
  out[4] = totalBytes & 0xff;
  out[5] = (chunkSize >> 8) & 0xff;
  out[6] = chunkSize & 0xff;
  return out;
}

export function buildOtaControl(cmd) {
  return Uint8Array.of(cmd);
}

// 传输数据包：[seq:2B 大端][chunk]（沿用固件，蓝牙写 0x2A40）
export function buildOtaData(seq, chunk) {
  const out = new Uint8Array(2 + chunk.length);
  out[0] = (seq >> 8) & 0xff;
  out[1] = seq & 0xff;
  out.set(chunk, 2);
  return out;
}

// ---------------------------------------------------------------------------
// 上行（设备 → 上位机）解析
// ---------------------------------------------------------------------------

export const DEVICE_STATES = ['待机', '预热中', '运行', 'Boost', '冷却中', '故障'];
export const SWITCHER_STATES = ['未连接', '搜索中', '已连接'];
export const SWITCHER_GEAR_LABELS = ['—', '左开', '双开', '右开'];
export const PURGE_LEVELS = ['—', '轻度净化', '中度净化', '深度净化'];

export const FAULTS = Object.freeze({
  0x01: { zh: '进风温度异常', en: 'Abnormal intake air temperature' },
  0x02: { zh: '出风温度异常', en: 'Abnormal outlet air temperature' },
  0x03: { zh: '发热丝异常', en: 'Heating element malfunction' },
  0x04: { zh: '风扇电机异常', en: 'Fan motor malfunction' },
  0x05: { zh: '进风口 PT100 异常\n请排除异常后重启使用', en: 'Inlet PT100 malfunction detected.\nPlease resolve the issue\nand restart the device.' },
  0x06: { zh: '出风口 PT100 异常\n请排除异常后重启使用', en: 'Outlet PT100 malfunction detected.\nPlease resolve the issue\nand restart the device.' },
  0x07: { zh: '温度传感器自检失败', en: 'Temperature sensor self-test failed' },
  0x08: { zh: 'VOC 传感器自检失败', en: 'VOC sensor self-test failed' },
  0x09: { zh: '湿度传感器自检失败', en: 'Humidity sensor self-test failed' },
  0x10: { zh: '电机异常\n请排除异常后重启使用', en: 'Motor malfunction detected.\nPlease resolve the issue\nand restart the device.' },
});

export function describeFault(code, language = 0) {
  const fault = FAULTS[code];
  if (!fault) return { zh: '未知故障 0x' + code.toString(16), en: 'Unknown fault 0x' + code.toString(16) };
  return fault;
}

const textDecoder = new TextDecoder();

function readI16LE(bytes, offset) {
  const raw = bytes[offset] | (bytes[offset + 1] << 8);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

function readU16LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) & 0xffff;
}

function readU32LE(bytes, offset) {
  return ((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0);
}

function validCrc(bytes, contentLength) {
  if (bytes.length < contentLength + 2) return false;
  const expected = readU16LE(bytes, contentLength);
  return crc16Modbus(bytes.slice(0, contentLength)) === expected;
}

/**
 * 解析设备上行载荷（蓝牙特征原始字节，或串口帧解出的 payload）。
 * 返回 { type, ... }；无法识别时 type='unknown'。
 */
export function parseUplink(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { type: 'unknown', bytes };
  const first = bytes[0];

  // 0xA0 ACK/NACK：[A0][ok][seq_hi][seq_lo]（固件 pic_notify_ack，seq 大端）
  if (first === 0xa0 && bytes.length >= 4) {
    return { type: 'ack', ok: bytes[1] === 0, seq: (bytes[2] << 8) | bytes[3], bytes };
  }

  // 0xA1 遥测帧（内容 17B + CRC16 LE）
  if (first === 0xa1 && bytes.length >= 19) {
    if (!validCrc(bytes, 17)) return { type: 'crc-error', bytes };
    return {
      type: 'telemetry',
      state: bytes[1] & 0x0f,
      gear: bytes[2],
      rpm: readU16LE(bytes, 3),
      inletTemp: readI16LE(bytes, 5) / 10,
      outletTemp: readI16LE(bytes, 7) / 10,
      ssrPwm: bytes[9],
      voc: readU16LE(bytes, 10),
      humidity: bytes[12],
      ambientTemp: (bytes[13] >= 0x80 ? bytes[13] - 0x100 : bytes[13]),
      purgeLevel: (bytes[14] >> 0) & 0x03,
      switcherState: (bytes[14] >> 2) & 0x03,
      boostActive: ((bytes[14] >> 4) & 0x01) === 1,
      faultCode: readU16LE(bytes, 15),
      bytes,
    };
  }

  // 0xA2 故障事件：[A2][fault:2B LE][动作 1发生/0恢复][CRC16 LE]
  if (first === 0xa2 && bytes.length >= 6) {
    if (!validCrc(bytes, 4)) return { type: 'crc-error', bytes };
    return { type: 'fault', code: readU16LE(bytes, 1), active: bytes[3] === 1, bytes };
  }

  // 0xB0 设置读回：[B0][语言][单位][Boost时长][记忆][催化温度 x0.1 2B LE]
  if (first === 0xb0 && bytes.length >= 7) {
    return {
      type: 'settings',
      language: bytes[1],
      tempUnit: bytes[2],
      boostDuration: bytes[3],
      memoryMode: bytes[4],
      catalyticTemp: readU16LE(bytes, 5) / 10,
      bytes,
    };
  }

  // 0xB1 状态：[B1][状态][挡位][净化等级][切换器][Boost 激活][切换器位置]
  if (first === 0xb1 && bytes.length >= 6) {
    return {
      type: 'state',
      state: bytes[1] & 0x0f,
      gear: bytes[2],
      purgeLevel: bytes[3],
      switcherState: bytes[4],
      boostActive: bytes[5] === 1,
      switcherGear: bytes.length >= 7 ? bytes[6] : 0,   // 1 左开 2 双开 3 右开，0=未知
      bytes,
    };
  }

  // 0xB2 传感器：[B2][进风 x0.1 2B][出风 x0.1 2B][湿度][环温 i8][VOC 2B]
  if (first === 0xb2 && bytes.length >= 9) {
    return {
      type: 'sensors',
      inletTemp: readI16LE(bytes, 1) / 10,
      outletTemp: readI16LE(bytes, 3) / 10,
      humidity: bytes[5],
      ambientTemp: (bytes[6] >= 0x80 ? bytes[6] - 0x100 : bytes[6]),
      voc: readU16LE(bytes, 7),
      bytes,
    };
  }

  // 0xB3 版本：[B3][sw主][sw次][sw修订][hw主][hw次][hw修订][model][运行秒 4B LE][rsv]
  if (first === 0xb3 && bytes.length >= 12) {
    return {
      type: 'version',
      sw: 'v' + bytes[1] + '.' + bytes[2] + '.' + bytes[3],
      hw: 'v' + bytes[4] + '.' + bytes[5] + '.' + bytes[6],
      model: bytes[7],
      uptime: readU32LE(bytes, 8),
      bytes,
    };
  }

  // 0xB4 自检进度：[B4][stage 0-3][tempOk][vocOk][humOk]（stage 3=完成；各 ok：0 进行中 1 通过 2 失败）
  if (first === 0xb4 && bytes.length >= 5) {
    return {
      type: 'selftest',
      stage: bytes[1],
      tempOk: bytes[2],
      vocOk: bytes[3],
      humOk: bytes[4],
      bytes,
    };
  }

  // 纯 ASCII 文本（如 AP:REBOOTING、OTA 进度行）
  if (Array.from(bytes).every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126))) {
    return { type: 'text', text: textDecoder.decode(bytes).trim(), bytes };
  }

  return { type: 'unknown', bytes };
}

// ---------------------------------------------------------------------------
// 遥测帧构造（模拟设备用；与 parseUplink 互逆）
// ---------------------------------------------------------------------------

export function buildTelemetry(sample) {
  const body = new Uint8Array(17);
  body[0] = 0xa1;
  body[1] = sample.state & 0x0f;
  body[2] = clampByte(sample.gear, 0, 255); // 挡位 0-120（120 为 Boost 挡）
  writeU16LE(body, 3, Math.max(0, Math.min(0xffff, Math.round(sample.rpm))));
  writeI16LE(body, 5, Math.round(sample.inletTemp * 10));
  writeI16LE(body, 7, Math.round(sample.outletTemp * 10));
  body[9] = clampByte(sample.ssrPwm);
  writeU16LE(body, 10, sample.voc ?? 0);
  body[12] = clampByte(sample.humidity ?? 40);
  body[13] = clampByte(sample.ambientTemp ?? 25, -40, 85);
  let flags = (sample.purgeLevel ?? 0) & 0x03;
  flags |= ((sample.switcherState ?? 0) & 0x03) << 2;
  if (sample.boostActive) flags |= 0x10;
  body[14] = flags;
  writeU16LE(body, 15, sample.faultCode ?? 0);
  const out = new Uint8Array(19);
  out.set(body, 0);
  const crc = crc16Modbus(body);
  out[17] = crc & 0xff;
  out[18] = (crc >> 8) & 0xff;
  return out;
}

export function buildFaultEvent(code, active) {
  const body = new Uint8Array(4);
  body[0] = 0xa2;
  writeU16LE(body, 1, code);
  body[3] = active ? 1 : 0;
  const out = new Uint8Array(6);
  out.set(body, 0);
  const crc = crc16Modbus(body);
  out[4] = crc & 0xff;
  out[5] = (crc >> 8) & 0xff;
  return out;
}

function clampByte(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value))) & 0xff;
}

function writeU16LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
}

function writeI16LE(target, offset, value) {
  const raw = value < 0 ? value + 0x10000 : value;
  writeU16LE(target, offset, raw);
}

// ---------------------------------------------------------------------------
// 固件挡位-转速对照（user_rs485.c，显示参考用）
// ---------------------------------------------------------------------------

export const GEAR_RPM_TABLE = Object.freeze([
  [0, 0], [10, 2000], [20, 2300], [30, 2600], [40, 2900], [50, 3200],
  [60, 3500], [70, 3800], [80, 4100], [90, 4400], [100, 4700], [120, 5640],
].map(([gear, rpm]) => Object.freeze({ gear, rpm })));

export function gearToRpm(gear) {
  if (gear <= 0) return 0;
  const table = GEAR_RPM_TABLE;
  for (let i = table.length - 1; i >= 0; i -= 1) {
    if (gear >= table[i].gear) {
      const next = table[i + 1];
      if (!next) return table[i].rpm;
      const ratio = (gear - table[i].gear) / (next.gear - table[i].gear);
      return Math.round(table[i].rpm + ratio * (next.rpm - table[i].rpm));
    }
  }
  return 0;
}

// OTA 传输通用参数
export const OTA_MAX_CHUNK = 244;         // 蓝牙：固件 ble_pkt_t.data 上限
export const SERIAL_CHUNK = 244;          // 串口：实测 1000 字节长帧在本机硬件上会丢字节，244 稳定
export const ACK_WINDOW = 10;             // 固件每 10 包窗口 ACK
// 串口 OTA 固定 115200：高波特率/大包在本机硬件实测误码；要快请走 WiFi 热点通道
