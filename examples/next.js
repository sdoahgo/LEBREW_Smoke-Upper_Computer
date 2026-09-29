// examples/next.js — 项目配置示例（RoastSee NEXT）
// 核心框架 comm_link.js 不知道任何具体项目的事；项目专属的过滤器、UUID、帧格式都写在这里。
// 新项目照着这份文件建一份自己的配置即可。

import { BleTransport, MagicLengthFramer, SerialTransport, crc16Modbus } from '../comm_link.js';

export const NEXT_BLE_NAME_PREFIX = 'RoastSeeNEXT';
export const NEXT_BLE_SERVICE_UUID = '000000bb-0000-1000-8000-00805f9b34fb';
export const NEXT_BLE_CHARACTERISTIC_UUID = '0000bb01-0000-1000-8000-00805f9b34fb';
export const NEXT_DEFAULT_BAUD_RATE = 115200;

// NEXT 实时二进制帧：AA 55 | 长度(1B)=20 | 载荷(20B) | CRC16-Modbus(2B) | 53 42
// CRC 覆盖「长度字节 + 载荷」。
export const NEXT_LIVE_FRAME = Object.freeze({
  magic: [0xaa, 0x55],
  lengthSize: 1,
  payloadLength: 20,
  trailer: [0x53, 0x42],
  crc: crc16Modbus,
  crcRange: 'lengthAndPayload',
  crcSize: 2,
});

export function createNextLiveFramer() {
  return new MagicLengthFramer(NEXT_LIVE_FRAME);
}

export function createNextSerialTransport(options = {}) {
  return new SerialTransport({
    name: 'UART0',
    baudRate: NEXT_DEFAULT_BAUD_RATE,
    ...options,
  });
}

export function createNextBleTransport(options = {}) {
  return new BleTransport({
    name: 'BLE',
    filters: [{ namePrefix: NEXT_BLE_NAME_PREFIX }],
    serviceUuid: NEXT_BLE_SERVICE_UUID,
    characteristicUuid: NEXT_BLE_CHARACTERISTIC_UUID,
    ...options,
  });
}

export function parseNextLiveFrame(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    curveAgtron: view.getFloat32(0, true),
    voice: view.getUint8(4),
    agtronRate: view.getFloat32(5, true),
    stableAgtron: view.getFloat32(9, true),
    distance: view.getUint16(13, true),
    yellowTime: view.getUint16(15, true),
    yellowFlag: view.getUint8(17),
    recordNo: view.getUint16(18, true),
  };
}
