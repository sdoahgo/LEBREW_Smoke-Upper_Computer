// comm_mock.js — 通用离线模拟传输层
// 提供与 Web Serial / Web Bluetooth 同形的假实现，用于无硬件的上位机开发、演示与自测。

export class MockSerialPort {
  constructor(options = {}) {
    this.label = options.label ?? 'MOCK-PORT';
    this.readable = null;
    this.writable = null;
    this.written = [];
    this.openedOptions = [];
    this.openCount = 0;
    this.closeCount = 0;
    this.cancelCount = 0;
    this.openFails = options.openFails ?? false;
    this._controller = null;
  }

  async open(options = {}) {
    if (this.openFails) {
      this.openCount += 1;
      throw new Error('mock port open failed');
    }
    this.openCount += 1;
    this.openedOptions.push(options);
    this.readable = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
      cancel: () => {
        this.cancelCount += 1;
        this._controller = null;
      },
    });
    this.writable = new WritableStream({
      write: (chunk) => {
        this.written.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      },
    });
  }

  async close() {
    this.closeCount += 1;
    this._controller = null;
    this.readable = null;
    this.writable = null;
  }

  emit(bytes) {
    if (!this._controller) return false;
    this._controller.enqueue(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    return true;
  }

  get writtenBytes() {
    return this.written.reduce((total, chunk) => total + chunk.length, 0);
  }

  get writtenFlat() {
    const merged = new Uint8Array(this.writtenBytes);
    let offset = 0;
    for (const chunk of this.written) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  get writtenText() {
    return new TextDecoder().decode(this.writtenFlat);
  }
}

export function createMockSerial(options = {}) {
  const portCount = options.portCount ?? 1;
  const ports = [];
  for (let i = 0; i < portCount; i += 1) {
    ports.push(new MockSerialPort({ label: 'MOCK-PORT-' + (i + 1), openFails: options.openFails ?? false }));
  }
  const requestCalls = [];
  let cursor = 0;

  const serial = {
    async requestPort() {
      requestCalls.push({});
      if (options.requestFails) throw new Error('mock requestPort rejected');
      const port = ports[Math.min(cursor, ports.length - 1)];
      cursor += 1;
      return port;
    },
  };

  return { serial, ports, port: ports[0], requestCalls };
}

export function createMockBluetooth(options = {}) {
  const withResponse = options.withResponse ?? true;
  const listeners = new Set();
  const deviceListeners = new Set();
  const requestCalls = [];
  const state = { notifyCount: 0, notifyListenerCount: 0 };
  const properties = options.properties ?? { notify: true, write: true };

  const characteristic = {
    properties,
    written: [],
    addEventListener(type, handler) {
      if (type !== 'characteristicvaluechanged') return;
      listeners.add(handler);
      state.notifyListenerCount = listeners.size;
    },
    removeEventListener(type, handler) {
      if (type !== 'characteristicvaluechanged') return;
      listeners.delete(handler);
      state.notifyListenerCount = listeners.size;
    },
    async startNotifications() {
      state.notifyCount += 1;
    },
    async writeValue(bytes) {
      characteristic.written.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },
  };
  if (withResponse) {
    characteristic.writeValueWithResponse = async (bytes) => {
      characteristic.written.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    };
  }

  const service = {
    async getCharacteristic(uuid) {
      if (options.characteristicMissing) throw new Error('mock characteristic missing: ' + uuid);
      return characteristic;
    },
    async getCharacteristics() {
      if (options.characteristicMissing) throw new Error('mock characteristic missing');
      return [characteristic];
    },
  };

  const server = {
    async getPrimaryService(uuid) {
      if (options.serviceMissing) throw new Error('mock service missing: ' + uuid);
      return service;
    },
    async getPrimaryServices() {
      if (options.serviceMissing) throw new Error('mock service missing');
      return [service];
    },
  };

  const device = {
    name: options.name ?? 'MOCK-DEVICE',
    connectCount: 0,
    disconnectCount: 0,
    gatt: {
      connected: false,
      async connect() {
        if (options.connectFails) throw new Error('mock gatt connect failed');
        device.gatt.connected = true;
        device.connectCount += 1;
        return server;
      },
      disconnect() {
        if (!device.gatt.connected) return;
        device.gatt.connected = false;
        device.disconnectCount += 1;
        for (const handler of [...deviceListeners]) handler({ type: 'gattserverdisconnected' });
      },
    },
  };
  device.addEventListener = (type, handler) => {
    if (type === 'gattserverdisconnected') deviceListeners.add(handler);
  };
  device.removeEventListener = (type, handler) => {
    if (type === 'gattserverdisconnected') deviceListeners.delete(handler);
  };

  const bluetooth = {
    async requestDevice(call) {
      requestCalls.push(call);
      if (options.requestFails) throw new Error('mock requestDevice rejected');
      return device;
    },
  };

  return {
    bluetooth,
    device,
    server,
    service,
    characteristic,
    requestCalls,
    state,
    feed(bytes) {
      const payload = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      const value = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      let delivered = 0;
      for (const handler of [...listeners]) {
        handler({ target: { value } });
        delivered += 1;
      }
      return delivered;
    },
    simulateDisconnect() {
      device.gatt.disconnect();
    },
  };
}

function writeUintLE(target, offset, value, size) {
  if (size === 1) {
    target[offset] = value & 0xff;
  } else if (size === 2) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >> 8) & 0xff;
  } else if (size === 4) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >> 8) & 0xff;
    target[offset + 2] = (value >> 16) & 0xff;
    target[offset + 3] = (value >> 24) & 0xff;
  } else {
    throw new Error('unsupported integer size: ' + size);
  }
}

export function buildFrame(options) {
  const magic = Uint8Array.from(options?.magic ?? []);
  if (!magic.length) throw new Error('buildFrame needs a non-empty magic');
  const payload = options.payload instanceof Uint8Array
    ? options.payload
    : Uint8Array.from(options.payload ?? []);
  const lengthSize = options.lengthSize ?? 2;
  const trailer = Uint8Array.from(options.trailer ?? []);
  const crc = options.crc ?? null;
  const crcSize = crc ? options.crcSize ?? 2 : 0;
  const crcRange = options.crcRange ?? 'payload';
  const headerLength = magic.length + lengthSize;

  const frame = new Uint8Array(headerLength + payload.length + crcSize + trailer.length);
  frame.set(magic, 0);
  writeUintLE(frame, magic.length, payload.length, lengthSize);
  frame.set(payload, headerLength);

  if (crc) {
    let start = headerLength;
    if (crcRange === 'lengthAndPayload') start = magic.length;
    else if (crcRange === 'headerAndPayload') start = 0;
    const value = crc(frame.slice(start, headerLength + payload.length));
    writeUintLE(frame, headerLength + payload.length, value, crcSize);
  }

  frame.set(trailer, headerLength + payload.length + crcSize);
  return frame;
}
