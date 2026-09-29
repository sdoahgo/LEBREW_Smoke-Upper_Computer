// smoke_ble.js — LEBREW SMOKE 专用的四特征 BLE 传输层
// 基座 BleTransport 只支持「一个特征既写又收」；本机协议是
// 遥测(0x2A37 Notify) / 命令(0x2A38 Write) / 传输控制(0x2A39 Write+Notify) / 传输数据(0x2A40 WriteNoResponse)
// 四特征结构，因此在基座 Transport 之上扩展（不改基座源码）。

import { Transport, TransportState, transportError } from './comm_link.js';
import { SMOKE_BLE } from './smoke_protocol.js';

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export class SmokeBleTransport extends Transport {
  constructor(options = {}) {
    super(options.name ?? 'BLE');
    this.bluetooth = options.bluetooth ?? globalThis.navigator?.bluetooth ?? null;
    this.filters = options.filters ?? [{ namePrefix: SMOKE_BLE.namePrefix }];
    this.serviceUuid = options.serviceUuid ?? SMOKE_BLE.serviceUuid;
    this.uuids = options.uuids ?? SMOKE_BLE;
    this.device = null;
    this.server = null;
    this.service = null;
    this.chars = null;
    this._notifyHandlers = new Map();
    this._onGattDisconnected = () => {
      this.server = null;
      this.service = null;
      this.chars = null;
      this._setState(TransportState.DISCONNECTED);
      this.emit('disconnected', { transport: this, device: this.device });
    };
  }

  async connect() {
    if (!this.bluetooth?.requestDevice) {
      throw transportError('BLE_UNSUPPORTED', 'Web Bluetooth is not available in this browser（请用 Chrome / Edge）');
    }

    this._setState(TransportState.CONNECTING);

    let device;
    try {
      device = await this.bluetooth.requestDevice({
        filters: this.filters,
        optionalServices: [this.serviceUuid],
      });
    } catch (error) {
      this._setState(TransportState.DISCONNECTED);
      throw transportError('DEVICE_NOT_SELECTED', 'BLE device was not selected', error);
    }

    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onGattDisconnected);

    try {
      if (!device.gatt) {
        // 浏览器记住了之前选择的失效设备并跳过了选择框：清掉记忆，下次点击会重新弹选择框
        let forgot = false;
        try {
          if (typeof device.forget === 'function') {
            await device.forget();
            forgot = true;
          }
        } catch (_) {
          // forget 失败不影响提示
        }
        throw transportError(
          'BLE_CONNECT_FAILED',
          '浏览器记住了之前失效的设备（未弹选择框直接失败）'
          + (forgot ? '，已自动清除记忆——请再点一次「连接蓝牙」重新选择设备' : '——请在地址栏左侧的站点设置里清除该网站数据后重试'),
        );
      }
      this.server = await device.gatt.connect();
      this.service = await this.server.getPrimaryService(this.serviceUuid);
      const { telemetryUuid, commandUuid, transferCtrlUuid, transferDataUuid } = this.uuids;
      const [telemetry, command, ctrl, data] = await Promise.all([
        this.service.getCharacteristic(telemetryUuid),
        this.service.getCharacteristic(commandUuid),
        this.service.getCharacteristic(transferCtrlUuid),
        this.service.getCharacteristic(transferDataUuid),
      ]);
      this.chars = { telemetry, command, ctrl, data };
      await this._subscribe(telemetry, 'telemetry');
      await this._subscribe(ctrl, 'ctrl');
      this._setState(TransportState.CONNECTED);
      this.emit('log', { transport: this, text: '特征就绪：0x2A37/0x2A38/0x2A39/0x2A40' });
      return this;
    } catch (error) {
      this._setState(TransportState.DISCONNECTED);
      throw error?.code ? error : transportError('BLE_CONNECT_FAILED', 'BLE connect failed: ' + (error?.message || error), error);
    }
  }

  async _subscribe(characteristic, kind) {
    const handler = (event) => {
      this.emit('data', { transport: this, bytes: toBytes(event.target.value), kind });
    };
    const key = kind;
    const previous = this._notifyHandlers.get(key);
    if (previous) characteristic.removeEventListener('characteristicvaluechanged', previous);
    characteristic.addEventListener('characteristicvaluechanged', handler);
    this._notifyHandlers.set(key, handler);
    await characteristic.startNotifications();
  }

  _requireChar(name) {
    const characteristic = this.chars?.[name];
    if (!characteristic || !this.device?.gatt?.connected) {
      throw transportError('NOT_CONNECTED', this.name + ' is not connected');
    }
    return characteristic;
  }

  async _write(characteristic, bytes, withoutResponse) {
    if (withoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
      await characteristic.writeValueWithoutResponse(bytes);
    } else if (typeof characteristic.writeValueWithResponse === 'function') {
      await characteristic.writeValueWithResponse(bytes);
    } else {
      await characteristic.writeValue(bytes);
    }
  }

  /** 参数命令（16B 密钥 + 命令 + 参数）→ 0x2A38 */
  async writeCommand(bytes) {
    await this._write(this._requireChar('command'), bytes, false);
  }

  /** 传输控制（OTA START/END/ABORT）→ 0x2A39 */
  async writeControl(bytes) {
    await this._write(this._requireChar('ctrl'), bytes, false);
  }

  /** 传输数据包（seq + chunk，≤244B）→ 0x2A40，无响应写 */
  async writeData(bytes) {
    await this._write(this._requireChar('data'), bytes, true);
  }

  /** 基座 Link.sendBytes 的通用出口：默认写到命令特征 */
  async write(bytes) {
    await this.writeCommand(bytes);
  }

  async disconnect() {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.server = null;
    this.service = null;
    this.chars = null;
    this._setState(TransportState.DISCONNECTED);
    return this;
  }
}
