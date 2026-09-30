// smoke_sim.js — LEBREW SMOKE 模拟设备（无硬件开发/演示用）
// 提供假的 Web Serial 端口与假的 Web Bluetooth（四特征），并完整模拟：
// 运行状态机、遥测、故障事件、设置读写、传感器自检、OTA 窗口传输、热点升级模式。

import {
  CMD,
  COMMAND_KEY,
  SMOKE_BLE,
  SMOKE_SERIAL,
  buildFaultEvent,
  buildTelemetry,
  frameSerial,
  gearToRpm,
} from './smoke_protocol.js';
import { crc16Modbus } from './comm_link.js';

const textEncoder = new TextEncoder();

// 风机挡位上限（固定，与固件挡位表一致：常规 100，120 为 Boost 挡）
const FAN_LIMIT_NORMAL = 100;
const FAN_LIMIT_BOOST = 120;

function u16be(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u16le(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) & 0xffff;
}

function u32be(bytes, offset) {
  return (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);
}

export class SmokeSimulator {
  constructor(options = {}) {
    this.deviceName = options.deviceName ?? 'LEBREW SMOKE';

    // —— 设备状态（对应固件 app_state_t / control_data / SYS_DATA）——
    this.state = 0; // 0待机 1预热 2运行 3Boost 4冷却 5故障
    this.gear = 0;
    this.rpm = 0;
    this.inletTemp = 25.0;
    this.outletTemp = 25.0;
    this.ambientTemp = 25.0;
    this.humidity = 45;
    this.voc = 120;
    this.purgeLevel = 0;
    this.switcherState = 2; // 0未连接 1搜索中 2已连接
    this.switcherGear = 0;  // 0未知 1左开 2双开 3右开
    this.boostActive = false;
    this.faultCode = 0;
    this.ssrPwm = 0;
    this.uptimeStart = Date.now();

    this.settings = {
      language: 0,
      tempUnit: 0,
      boostDuration: 5,
      memoryMode: 0,
      catalyticTemp: 315.0,
      fanLimit: 100,   // 100 常规 / 120 Boost 模式（与固件 fan_limit_data 一致）
    };
    this.version = { sw: [1, 2, 0], hw: [0, 1, 0], model: 1 };

    this.telemetryEnabled = false;
    this.telemetryPeriod = 500;

    this.serialPort = this._createSerialPort();
    this.bluetooth = this._createBluetooth();
    this._serialOpen = false;
    this._bleSubscribed = { telemetry: false, ctrl: false };
    this._bleListeners = { telemetry: new Set(), ctrl: new Set() };
    this._serialRxBuffer = new Uint8Array(0);
    this._telemetryTimer = null;
    this._stepTimer = null;
    this._transfer = null;
    this._selftestTimer = null;
    this.apMode = false;
    this.logs = [];
  }

  start() {
    this._stepTimer = setInterval(() => this._step(), 250);
    return this;
  }

  stop() {
    clearInterval(this._stepTimer);
    this._setTelemetry(false);
    return this;
  }

  log(text) {
    this.logs.push('[' + new Date().toTimeString().slice(0, 8) + '] ' + text);
    if (this.logs.length > 200) this.logs.shift();
  }

  // -------------------------------------------------------------------------
  // 假 Web Serial 端口
  // -------------------------------------------------------------------------

  _createSerialPort() {
    const sim = this;
    const port = {
      label: 'SIM-SMOKE',
      readable: null,
      writable: null,
      _controller: null,
      async open() {
        sim._serialOpen = true;
        this.readable = new ReadableStream({
          start: (controller) => { this._controller = controller; },
          cancel: () => { this._controller = null; },
        });
        this.writable = new WritableStream({
          write: (chunk) => {
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            sim._onSerialTx(bytes);
          },
        });
      },
      async close() {
        sim._serialOpen = false;
        this._controller = null;
        this.readable = null;
        this.writable = null;
      },
      emit(bytes) {
        if (!this._controller) return false;
        this._controller.enqueue(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
        return true;
      },
    };
    return port;
  }

  get serial() {
    const sim = this;
    return { async requestPort() { return sim.serialPort; } };
  }

  _onSerialTx(bytes) {
    // 拆 5A A5 帧（与固件 user_console.c 相同的解析逻辑）
    this._serialRxBuffer = _concat(this._serialRxBuffer, bytes);
    const frame = SMOKE_SERIAL.frame;
    const magic = frame.magic;
    let buffer = this._serialRxBuffer;

    while (buffer.length >= 8) {
      const start = buffer.findIndex((b, i) => b === magic[0] && buffer[i + 1] === magic[1]);
      if (start < 0) { buffer = new Uint8Array(0); break; }
      if (start > 0) buffer = buffer.slice(start);
      const len = u16le(buffer, 2);
      if (len > 1024) { buffer = buffer.slice(1); continue; }
      const total = 4 + len + 2;
      if (buffer.length < total) break;
      const payload = buffer.slice(4, 4 + len);
      const crc = u16le(buffer, 4 + len);
      const ok = crc === crc16Modbus(buffer.slice(2, 4 + len));
      buffer = buffer.slice(total);
      if (ok) this._handlePayload(payload, 'serial');
    }
    this._serialRxBuffer = buffer;
  }

  // -------------------------------------------------------------------------
  // 假 Web Bluetooth（四特征）
  // -------------------------------------------------------------------------

  _createBluetooth() {
    const sim = this;
    const mkChar = (uuid, props, kind) => ({
      uuid,
      properties: props,
      async startNotifications() {
        if (kind) sim._bleSubscribed[kind] = true;
      },
      async stopNotifications() {
        if (kind) sim._bleSubscribed[kind] = false;
      },
      addEventListener(type, handler) {
        if (type === 'characteristicvaluechanged' && kind) sim._bleListeners[kind].add(handler);
      },
      removeEventListener(type, handler) {
        if (type === 'characteristicvaluechanged' && kind) sim._bleListeners[kind].delete(handler);
      },
      async writeValueWithResponse(value) {
        sim._onBleWrite(kind, value);
      },
      async writeValueWithoutResponse(value) {
        sim._onBleWrite(kind, value);
      },
    });

    const chars = new Map([
      [SMOKE_BLE.telemetryUuid, mkChar(SMOKE_BLE.telemetryUuid, { notify: true }, 'telemetry')],
      [SMOKE_BLE.commandUuid, mkChar(SMOKE_BLE.commandUuid, { write: true }, 'command')],
      [SMOKE_BLE.transferCtrlUuid, mkChar(SMOKE_BLE.transferCtrlUuid, { write: true, notify: true }, 'ctrl')],
      [SMOKE_BLE.transferDataUuid, mkChar(SMOKE_BLE.transferDataUuid, { writeWithoutResponse: true }, 'data')],
    ]);

    const service = {
      async getCharacteristic(uuid) {
        const char = chars.get(uuid);
        if (!char) throw new Error('sim: characteristic not found ' + uuid);
        return char;
      },
    };
    const server = {
      async getPrimaryService() { return service; },
      connected: false,
      disconnect() {
        server.connected = false;
        sim._bleSubscribed.telemetry = false;   // 断链后 CCCD 失效：不再 notify
        sim._bleSubscribed.ctrl = false;
        for (const handler of [...sim._deviceListeners]) handler();
      },
    };
    const device = {
      name: this.deviceName,
      gatt: {
        connected: false,
        async connect() {
          server.connected = true;
          device.gatt.connected = true;
          return server;
        },
        disconnect() { server.disconnect(); },
      },
      addEventListener(type, handler) {
        if (type === 'gattserverdisconnected') sim._deviceListeners.add(handler);
      },
      removeEventListener(type, handler) {
        if (type === 'gattserverdisconnected') sim._deviceListeners.delete(handler);
      },
    };
    this._deviceListeners = new Set();

    return {
      async requestDevice() {
        if (sim.apMode) throw new Error('sim: device is in AP upgrade mode');
        return device;
      },
      _device: device,
    };
  }

  _onBleWrite(kind, value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value.buffer ?? value);
    if (kind === 'command') {
      // 16B 密钥 + 命令
      if (bytes.length < 17) return;
      for (let i = 0; i < 16; i += 1) {
        if (bytes[i] !== COMMAND_KEY[i]) { this.log('密钥不符，忽略命令'); return; }
      }
      this._dispatchCommand(bytes[16], bytes.slice(17));
    } else if (kind === 'ctrl') {
      this._onTransferControl(bytes);
    } else if (kind === 'data') {
      this._onTransferData(bytes);
    }
  }

  // -------------------------------------------------------------------------
  // 设备 → 上位机
  // -------------------------------------------------------------------------

  _bleNotify(kind, payload) {
    if (!this._bleSubscribed[kind]) return 0;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let delivered = 0;
    for (const handler of [...this._bleListeners[kind]]) {
      handler({ target: { value: view } });
      delivered += 1;
    }
    return delivered;
  }

  _emit(payload) {
    if (this._serialOpen) this.serialPort.emit(frameSerial(payload));
    return this._bleNotify(payload[0] === 0xa0 ? 'ctrl' : 'telemetry', payload);
  }

  _emitText(text) {
    this._emit(textEncoder.encode(text + '\n'));
  }

  _ack(ok, seq) {
    const out = new Uint8Array([0xa0, ok ? 0 : 1, (seq >> 8) & 0xff, seq & 0xff]);
    if (this._serialOpen) this.serialPort.emit(frameSerial(out));
    this._bleNotify('ctrl', out);
  }

  // -------------------------------------------------------------------------
  // 命令分发（与固件补丁 smoke_cmd_dispatch 语义一致）
  // -------------------------------------------------------------------------

  _handlePayload(payload, channel) {
    if (payload.length >= 17) {
      let keyOk = true;
      for (let i = 0; i < 16; i += 1) {
        if (payload[i] !== COMMAND_KEY[i]) { keyOk = false; break; }
      }
      if (keyOk) {
        this._dispatchCommand(payload[16], payload.slice(17));
        return;
      }
    }
    // 串口承载的传输类：与固件 user_console 相同的按状态路由
    // （数据包 seq 高字节会撞控制码，不能按首字节区分）
    if (this._transfer) {
      if (payload.length === 1 && (payload[0] === CMD.OTA_END || payload[0] === CMD.OTA_ABORT)) {
        this._onTransferControl(payload);
      } else if (payload.length >= 3) {
        this._onTransferData(payload);
      }
      return;
    }
    if (payload.length === 7 && payload[0] === CMD.OTA_START) {
      this._onTransferControl(payload);
    }
  }

  _dispatchCommand(cmd, args) {
    const s = this.settings;
    switch (cmd) {
      case CMD.START_SMOKE:
        if (this.state === 5 || this.state === 4) break;   // 故障/冷却中忽略，与固件守卫一致
        if (args.length >= 1) {
          const cap = args[0] > FAN_LIMIT_NORMAL ? FAN_LIMIT_BOOST : FAN_LIMIT_NORMAL;
          this.gear = Math.min(cap, args[0]);
        }
        this.state = 1;
        this.log('开始除烟 gear=' + this.gear);
        break;
      case CMD.STOP_SMOKE:
        if (this.state === 0 || this.state === 4) break;   // 待机/冷却忽略，与固件守卫一致
        this.state = 4;
        this.boostActive = false;
        this.log('停止除烟，进入冷却');
        break;
      case CMD.BOOST_ON:
        if (this.state !== 2 && this.state !== 3) break;
        this.boostActive = true;
        this.state = 3;
        this.log('Boost 开');
        break;
      case CMD.BOOST_OFF:
        if (!this.boostActive) break;
        this.boostActive = false;
        this.state = 2;
        this.log('Boost 关');
        break;
      case CMD.SET_GEAR:
        if (args.length >= 1) {
          // 与固件 SET_GEAR 一致：受风机上限约束（100 时最多 100，120 时最多 120）
          this.gear = Math.min(s.fanLimit, args[0]);
          this.log('挡位=' + this.gear);
        }
        break;
      case CMD.SET_LANGUAGE: s.language = args[0] ? 1 : 0; this._emitSettings(); break;
      case CMD.SET_TEMP_UNIT: s.tempUnit = args[0] ? 1 : 0; this._emitSettings(); break;
      case CMD.SET_BOOST_DURATION: s.boostDuration = [5, 10, 15].includes(args[0]) ? args[0] : 5; this._emitSettings(); break;
      case CMD.SET_MEMORY_MODE: s.memoryMode = args[0] ? 1 : 0; this._emitSettings(); break;
      case CMD.SET_FAN_LIMIT: {
        const limit = args[0] | 0;
        if (limit !== 100 && limit !== 120) break;
        s.fanLimit = limit;
        if (this.gear > limit) {   // 与固件一致：超限的当前挡位被钳到上限
          this.gear = limit;
          this.log('风机上限 ' + limit + '%，挡位已钳位');
          this._emitState();
        } else {
          this.log('风机上限已设置: ' + limit + '%');
        }
        this._emitSettings();
        break;
      }
      case CMD.SET_CATALYTIC_TEMP:
        if (args.length >= 2) {
          const value = u16le(args, 0) / 10;
          if (value >= 300 && value <= 330) { s.catalyticTemp = value; this._emitSettings(); }
        }
        break;
      case CMD.SELF_TEST: this._runSelfTest(); break;
      case CMD.READ_ALL: this._emitSettings(); break;
      case CMD.READ_STATE: this._emitState(); if (this.faultCode) this._emit(buildFaultEvent(this.faultCode, true)); break;
      case CMD.READ_SENSORS: this._emitSensors(); break;
      case CMD.READ_VERSION: this._emitVersion(); break;
      case CMD.TELEMETRY_CFG: {
        const enable = args[0] === 1;
        const period = args.length >= 3 ? Math.max(100, u16le(args, 1)) : 500;
        this._setTelemetry(enable, period);
        break;
      }
      case CMD.ENTER_AP_OTA: this._enterApMode(); break;
      case CMD.SET_SWITCHER_GEAR: {
        const gear = args[0] | 0;
        if (this.switcherState !== 2) {
          this.log('切换器未连接，位置设置被忽略: ' + gear);
        } else if (gear >= 1 && gear <= 3) {
          this.switcherGear = gear;
          this.log('切换器位置已设置: ' + ['左开', '双开', '右开'][gear - 1]);
          this._emitState();   // 与固件一致：执行后推送 0xB1 让上位机跟随
        }
        break;
      }
      default:
        break;
    }
  }

  _emitSettings() {
    const s = this.settings;
    const out = new Uint8Array(8);
    out[0] = 0xb0;
    out[1] = s.language;
    out[2] = s.tempUnit;
    out[3] = s.boostDuration;
    out[4] = s.memoryMode;
    const catalytic = Math.round(s.catalyticTemp * 10);
    out[5] = catalytic & 0xff;
    out[6] = (catalytic >> 8) & 0xff;
    out[7] = s.fanLimit;
    this._emit(out);
  }

  _emitState() {
    const out = new Uint8Array(7);
    out[0] = 0xb1;
    out[1] = this.state;
    out[2] = this.gear;
    out[3] = this.purgeLevel;
    out[4] = this.switcherState;
    out[5] = this.boostActive ? 1 : 0;
    out[6] = this.switcherGear;
    this._emit(out);
  }

  _emitSensors() {
    const out = new Uint8Array(9);
    out[0] = 0xb2;
    const put = (offset, value) => {
      const raw = Math.round(value * 10) & 0xffff;
      out[offset] = raw & 0xff;
      out[offset + 1] = (raw >> 8) & 0xff;
    };
    put(1, this.inletTemp);
    put(3, this.outletTemp);
    out[5] = this.humidity;
    out[6] = this.ambientTemp & 0xff;
    out[7] = this.voc & 0xff;
    out[8] = (this.voc >> 8) & 0xff;
    this._emit(out);
  }

  _emitVersion() {
    const out = new Uint8Array(12);
    out[0] = 0xb3;
    out[1] = this.version.sw[0];
    out[2] = this.version.sw[1];
    out[3] = this.version.sw[2] ?? 1;
    out[4] = this.version.hw[0];
    out[5] = this.version.hw[1];
    out[6] = this.version.hw[2] ?? 1;
    out[7] = this.version.model;
    const uptime = Math.floor((Date.now() - this.uptimeStart) / 1000);
    out[8] = uptime & 0xff;
    out[9] = (uptime >> 8) & 0xff;
    out[10] = (uptime >> 16) & 0xff;
    out[11] = (uptime >>> 24) & 0xff;
    this._emit(out);
  }

  _setTelemetry(enable, period = this.telemetryPeriod) {
    this.telemetryPeriod = period;
    this.telemetryEnabled = enable;
    clearInterval(this._telemetryTimer);
    this._telemetryTimer = null;
    if (enable) {
      this._telemetryTimer = setInterval(() => {
        this._emit(buildTelemetry(this._sample()));
      }, period);
    }
    this.log('遥测=' + (enable ? '开 ' + period + 'ms' : '关'));
  }

  _runSelfTest() {
    clearInterval(this._selftestTimer);
    let stage = 0;
    const report = () => {
      const out = new Uint8Array(5);
      out[0] = 0xb4;
      out[1] = stage;
      out[2] = stage >= 1 ? 1 : 0;
      out[3] = stage >= 2 ? 1 : 0;
      out[4] = stage >= 3 ? 1 : 0;
      this._emit(out);
    };
    report();
    this._selftestTimer = setInterval(() => {
      stage += 1;
      report();
      if (stage >= 3) {
        clearInterval(this._selftestTimer);
        this._selftestTimer = null;
      }
    }, 900);
  }

  // -------------------------------------------------------------------------
  // OTA 传输（窗口 ACK，与固件 pic_on_control_write / ota_on_data_write 一致）
  // -------------------------------------------------------------------------

  _onTransferControl(bytes) {
    const cmd = bytes[0];
    if (cmd === CMD.OTA_START) {
      if (bytes.length < 7) return;
      const total = u32be(bytes, 1);
      const chunk = u16be(bytes, 5);
      if (chunk === 0 || chunk > 1000) { this._ack(false, 0); return; }   // 串口通道允许到 1000
      this._transfer = { total, chunk, expected: 0, received: 0, chunks: [] };
      this.log('OTA START total=' + total + ' chunk=' + chunk);
      this._ack(true, 0);
      return;
    }
    if (cmd === CMD.OTA_END) {
      const t = this._transfer;
      if (!t) { this._ack(false, 0); return; }
      if (t.received !== t.total) { this._ack(false, t.expected); return; }
      const lastSeq = t.expected === 0 ? 0 : t.expected - 1;
      this._ack(true, lastSeq);
      this._transfer = null;
      this.log('OTA 接收完成，准备重启');
      setTimeout(() => this._rebootAfterOta(), 600);
      return;
    }
    if (cmd === CMD.OTA_ABORT) {
      this._transfer = null;
      this._ack(true, 0);
      this.log('OTA ABORT');
    }
  }

  _onTransferData(bytes) {
    const t = this._transfer;
    if (!t || bytes.length < 2) return;
    const seq = u16be(bytes, 0);
    const payload = bytes.slice(2);
    if (seq !== t.expected) {
      this._ack(false, t.expected);
      return;
    }
    t.chunks.push(payload);
    t.received += payload.length;
    t.expected += 1;
    const totalPackets = Math.ceil(t.total / t.chunk);
    if (seq % 10 === 9 || seq === totalPackets - 1 || t.received >= t.total) {
      this._ack(true, seq);
    }
  }

  _rebootAfterOta() {
    this.version.sw = [this.version.sw[0], this.version.sw[1], (this.version.sw[2] ?? 0) + 1];
    this._emitText('OTA:OK-rebooting');
    // 模拟重启：蓝牙断开再可连，状态回待机
    if (this.bluetooth._device.gatt.connected) this.bluetooth._device.gatt.disconnect();
    this.state = 0;
    this.gear = 0;
    this._setTelemetry(false);
  }

  // -------------------------------------------------------------------------
  // 热点升级模式（SoftAP）
  // -------------------------------------------------------------------------

  _enterApMode() {
    this._emitText('AP:REBOOTING');
    this.apMode = true;
    this.log('进入热点升级模式（SoftAP: LEBREW-SMOKE / 192.168.4.1）');
    setTimeout(() => {
      if (this.bluetooth._device.gatt.connected) this.bluetooth._device.gatt.disconnect();
      this._setTelemetry(false);
    }, 300);
  }

  exitApMode() {
    this.apMode = false;
    this.version.sw = [this.version.sw[0], this.version.sw[1], (this.version.sw[2] ?? 0) + 1];
    this.state = 0;
    this.log('退出热点模式，重启回蓝牙');
  }

  // -------------------------------------------------------------------------
  // 运行状态机
  // -------------------------------------------------------------------------

  _sample() {
    return {
      state: this.state,
      gear: this.gear,
      rpm: this.rpm,
      inletTemp: this.inletTemp,
      outletTemp: this.outletTemp,
      ssrPwm: this.ssrPwm,
      voc: this.voc,
      humidity: this.humidity,
      ambientTemp: this.ambientTemp,
      purgeLevel: this.purgeLevel,
      switcherState: this.switcherState,
      switcherGear: this.switcherGear,
      boostActive: this.boostActive,
      faultCode: this.faultCode,
    };
  }

  _step() {
    const s = this.settings; // 催化温度
    const targetGear = Math.min(FAN_LIMIT_BOOST, this.gear + (this.boostActive ? 20 : 0));
    const targetRpm = this.state === 0 || this.state === 5 ? 0 : gearToRpm(targetGear);
    this.rpm += Math.round((targetRpm - this.rpm) * 0.12);

    const catalytic = s.catalyticTemp;
    const preheatEnd = 150;
    const noise = () => (Math.random() - 0.5) * 1.2;

    if (this.state === 1) { // 预热：快速升温到预热结束温度
      this.ssrPwm = 32;
      this.outletTemp += 3.2 + noise();
      if (this.outletTemp >= preheatEnd) this.state = 2;
    } else if (this.state === 2 || this.state === 3) { // 恒温/Boost：PI 维持催化温度
      const error = catalytic - this.outletTemp;
      this.ssrPwm = Math.max(0, Math.min(100, Math.round(45 + error * 1.8 + noise())));
      this.outletTemp += (error > 0 ? 0.8 : -0.6) + noise() * 0.4;
      if (this.boostActive) this.outletTemp += 0.6;
    } else if (this.state === 4) { // 冷却
      this.ssrPwm = 0;
      this.outletTemp -= 2.4;
      if (this.outletTemp <= 40) this.state = 0;
    } else {
      this.ssrPwm = 0;
    }

    // 进风口跟随出风口与环境
    const inletTarget = this.ambientTemp + (this.outletTemp - this.ambientTemp) * 0.42;
    this.inletTemp += (inletTarget - this.inletTemp) * 0.08;

    // VOC 随净化缓慢下降，待机回升
    if (this.state === 2 || this.state === 3) this.voc = Math.max(30, this.voc - 1.5);
    else this.voc = Math.min(350, this.voc + 0.8);
    this.purgeLevel = this.voc > 220 ? 3 : this.voc > 120 ? 2 : this.voc > 60 ? 1 : 0;

    if (this.outletTemp < this.ambientTemp) this.outletTemp = this.ambientTemp;
    if (this.inletTemp < this.ambientTemp) this.inletTemp = this.ambientTemp;
    this.humidity = Math.max(20, Math.min(80, 45 + Math.sin(Date.now() / 20000) * 6));
  }

  // —— 演示/联调辅助：人为制造与清除故障 ——
  triggerFault(code) {
    this.faultCode = code;
    this.state = 5;
    this._emit(buildFaultEvent(code, true));
    this.log('故障 0x' + code.toString(16));
  }

  clearFault() {
    const code = this.faultCode;
    this.faultCode = 0;
    this.state = 0;
    if (code) this._emit(buildFaultEvent(code, false));
    this.log('故障清除');
  }
}

function _concat(left, right) {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
