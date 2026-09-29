// comm_link.js — 上位机通用「蓝牙(BLE) + 串口(UART)」通信核心
// 与具体项目无关：设备过滤、UUID、帧格式全部由调用方传入。
// 零依赖 ES Module，浏览器与 Node 均可加载。

export const TransportState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
});

export const DEFAULT_LINE_EOL = '\r\n';

const MAX_FRAME_PAYLOAD = 1 << 20;
const textEncoder = new TextEncoder();

export function transportError(code, message, cause) {
  const error = new Error(message || code);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function concatBytes(left, right) {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

export function trimTrailingZeros(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.slice(0, end);
}

export function isLikelyAsciiLine(bytes) {
  if (bytes.length === 0) return false;
  return Array.from(bytes).every(
    (byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126),
  );
}

export function ensureLineEnding(command, eol = DEFAULT_LINE_EOL) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return '';
  return trimmed.endsWith('\n') ? trimmed : trimmed + eol;
}

export function crc16Modbus(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x0001 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

export function findPattern(bytes, pattern, from = 0) {
  if (!pattern || pattern.length === 0) return -1;
  outer: for (let i = from; i <= bytes.length - pattern.length; i += 1) {
    for (let j = 0; j < pattern.length; j += 1) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function matchesAt(bytes, offset, pattern) {
  if (!pattern || pattern.length === 0) return true;
  if (offset < 0 || offset + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

export function readUintLE(bytes, offset, size) {
  if (size === 1) return bytes[offset];
  if (size === 2) return bytes[offset] | (bytes[offset + 1] << 8);
  if (size === 4) {
    return (
      (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>>
      0
    );
  }
  throw new Error('unsupported integer size: ' + size);
}

export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const handlers = this._handlers.get(type);
    if (handlers) handlers.delete(handler);
  }

  emit(type, detail) {
    const handlers = this._handlers.get(type);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(detail);
      } catch (error) {
        if (type !== 'error') this.emit('error', { error, source: type });
      }
    }
  }
}

export class Transport extends Emitter {
  constructor(name) {
    super();
    this.name = name;
    this.state = TransportState.DISCONNECTED;
  }

  get isConnected() {
    return this.state === TransportState.CONNECTED;
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', { transport: this, state });
  }

  async connect() {
    throw transportError('NOT_IMPLEMENTED', this.name + ': connect() is not implemented');
  }

  async disconnect() {
    throw transportError('NOT_IMPLEMENTED', this.name + ': disconnect() is not implemented');
  }

  async write() {
    throw transportError('NOT_IMPLEMENTED', this.name + ': write() is not implemented');
  }
}

export class SerialTransport extends Transport {
  constructor(options = {}) {
    super(options.name ?? 'UART0');
    this.baudRate = options.baudRate ?? 115200;
    this.bufferSize = options.bufferSize ?? 0;
    this.openOptions = options.openOptions ?? {};
    this.serial = options.serial ?? globalThis.navigator?.serial ?? null;
    this._port = null;
    this._reader = null;
    this._writer = null;
    this._readActive = false;
  }

  get port() {
    return this._port;
  }

  get reader() {
    return this._reader;
  }

  get writer() {
    return this._writer;
  }

  async connect() {
    if (!this.serial?.requestPort) {
      throw transportError('SERIAL_UNSUPPORTED', 'Web Serial is not available in this browser');
    }
    if (this._port) return this;

    this._setState(TransportState.CONNECTING);

    let port;
    try {
      port = await this.serial.requestPort();
    } catch (error) {
      this._setState(TransportState.DISCONNECTED);
      throw transportError('DEVICE_NOT_SELECTED', 'serial port was not selected', error);
    }

    const openOptions = {
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      ...this.openOptions,
    };
    if (this.bufferSize) openOptions.bufferSize = this.bufferSize;

    try {
      await port.open(openOptions);
    } catch (error) {
      this._readActive = false;
      this._port = null;
      this._writer = null;
      try {
        await port.close();
      } catch (_) {
        // 打开失败后的关闭失败不改变结论，忽略。
      }
      this._setState(TransportState.DISCONNECTED);
      throw transportError('OPEN_FAILED', 'serial open failed: ' + (error?.message || error), error);
    }

    this._port = port;
    this._writer = port.writable.getWriter();
    this._readActive = true;
    this._setState(TransportState.CONNECTED);
    this._readLoop();
    return this;
  }

  async _readLoop() {
    while (this._readActive && this._port?.readable) {
      this._reader = this._port.readable.getReader();
      try {
        while (this._readActive) {
          const { value, done } = await this._reader.read();
          if (done) break;
          if (!value) continue;
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          this.emit('data', { transport: this, bytes });
        }
      } catch (error) {
        if (this._readActive) {
          this.emit('error', transportError('READ_FAILED', 'serial read failed: ' + (error?.message || error), error));
        }
      } finally {
        this._reader.releaseLock();
        this._reader = null;
      }
    }
  }

  async disconnect() {
    this._readActive = false;

    if (this._reader) {
      try {
        await this._reader.cancel();
      } catch (error) {
        this.emit('error', transportError('CANCEL_FAILED', 'reader cancel failed: ' + (error?.message || error), error));
      }
    }

    if (this._writer) {
      try {
        this._writer.releaseLock();
      } catch (error) {
        this.emit('error', transportError('RELEASE_FAILED', 'writer release failed: ' + (error?.message || error), error));
      }
      this._writer = null;
    }

    if (this._port) {
      try {
        await this._port.close();
      } catch (error) {
        this.emit('error', transportError('CLOSE_FAILED', 'serial close failed: ' + (error?.message || error), error));
      }
    }

    this._port = null;
    this._reader = null;
    this._setState(TransportState.DISCONNECTED);
    return this;
  }

  async write(bytes) {
    if (!this._writer) {
      throw transportError('NOT_CONNECTED', this.name + ' is not connected');
    }
    await this._writer.write(bytes);
  }
}

export class BleTransport extends Transport {
  constructor(options = {}) {
    super(options.name ?? 'BLE');
    this.filters = options.filters ?? null;
    this.acceptAllDevices = options.acceptAllDevices ?? false;
    this.serviceUuid = options.serviceUuid ?? null;
    this.characteristicUuid = options.characteristicUuid ?? null;
    this.optionalServices =
      options.optionalServices ?? (this.serviceUuid ? [this.serviceUuid] : []);
    this.autoNotify = options.autoNotify !== false;
    this.bluetooth = options.bluetooth ?? globalThis.navigator?.bluetooth ?? null;
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.notifyOpen = false;
    this._onNotification = (event) => {
      const value = event.target.value;
      const bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      this.emit('data', { transport: this, bytes });
    };
    this._onGattDisconnected = () => {
      this.server = null;
      this.characteristic = null;
      this.notifyOpen = false;
      this._setState(TransportState.DISCONNECTED);
      this.emit('disconnected', { transport: this, device: this.device });
    };
  }

  requestOptions() {
    if (this.filters?.length) {
      return { filters: this.filters, optionalServices: this.optionalServices };
    }
    if (this.acceptAllDevices) {
      return { acceptAllDevices: true, optionalServices: this.optionalServices };
    }
    throw transportError('BLE_FILTER_REQUIRED', 'BleTransport needs filters or acceptAllDevices');
  }

  async connect() {
    if (!this.bluetooth?.requestDevice) {
      throw transportError('BLE_UNSUPPORTED', 'Web Bluetooth is not available in this browser');
    }

    const requestOptions = this.requestOptions();
    this.notifyOpen = false;
    this._setState(TransportState.CONNECTING);

    let device;
    try {
      device = await this.bluetooth.requestDevice(requestOptions);
    } catch (error) {
      this._setState(TransportState.DISCONNECTED);
      throw transportError('DEVICE_NOT_SELECTED', 'BLE device was not selected', error);
    }

    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onGattDisconnected);

    try {
      await this._connectGattAndNotify();
    } catch (error) {
      this._setState(TransportState.DISCONNECTED);
      throw error?.code
        ? error
        : transportError('BLE_CONNECT_FAILED', 'BLE connect failed: ' + (error?.message || error), error);
    }
    return this;
  }

  async _connectGattAndNotify() {
    if (!this.device) {
      throw transportError('DEVICE_NOT_SELECTED', 'no BLE device selected');
    }
    this.server = await this.device.gatt.connect();
    const service = await this._resolveService(this.server);
    this.characteristic = await this._resolveCharacteristic(service);
    await this.openNotify();
    this._setState(TransportState.CONNECTED);
  }

  async _resolveService(server) {
    if (this.serviceUuid) return server.getPrimaryService(this.serviceUuid);
    const services = await server.getPrimaryServices();
    if (!services?.length) throw transportError('SERVICE_MISSING', 'no primary service found');
    return services[0];
  }

  async _resolveCharacteristic(service) {
    if (this.characteristicUuid) return service.getCharacteristic(this.characteristicUuid);
    const characteristics = await service.getCharacteristics();
    if (!characteristics?.length) throw transportError('CHARACTERISTIC_MISSING', 'no characteristic found');
    return characteristics[0];
  }

  canNotify() {
    const properties = this.characteristic?.properties;
    if (!properties) return true;
    return Boolean(properties.notify || properties.indicate);
  }

  async openNotify() {
    if (!this.characteristic) {
      if (!this.device?.gatt?.connected) {
        await this._connectGattAndNotify();
        return;
      }
      throw transportError('CHARACTERISTIC_MISSING', 'BLE characteristic is not ready');
    }

    if (!this.autoNotify || !this.canNotify()) {
      this.notifyOpen = false;
      this._setState(TransportState.CONNECTED);
      return;
    }

    this.characteristic.removeEventListener('characteristicvaluechanged', this._onNotification);
    this.characteristic.addEventListener('characteristicvaluechanged', this._onNotification);
    await this.characteristic.startNotifications();
    this.notifyOpen = true;
    this._setState(TransportState.CONNECTED);
  }

  async write(bytes) {
    if (!this.characteristic || !this.device?.gatt?.connected) {
      throw transportError('NOT_CONNECTED', this.name + ' is not connected');
    }
    if (!this.notifyOpen && this.autoNotify && this.canNotify()) {
      await this.openNotify();
    }
    if (typeof this.characteristic.writeValueWithResponse === 'function') {
      await this.characteristic.writeValueWithResponse(bytes);
    } else {
      await this.characteristic.writeValue(bytes);
    }
  }

  async disconnect() {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.server = null;
    this.characteristic = null;
    this.notifyOpen = false;
    this._setState(TransportState.DISCONNECTED);
    return this;
  }
}

export class Framer {
  constructor() {
    this._state = new Map();
  }

  stateOf(context) {
    return this._state.get(context);
  }

  setState(context, value) {
    this._state.set(context, value);
  }

  reset(context) {
    if (context === undefined) this._state.clear();
    else this._state.delete(context);
  }

  push() {
    throw new Error('push() is not implemented');
  }
}

export class LineFramer extends Framer {
  constructor(options = {}) {
    super();
    this.delimiter = options.delimiter ?? '\n';
    this.encoding = options.encoding ?? 'utf-8';
    this.accept = options.accept ?? isLikelyAsciiLine;
    this._decoders = new Map();
  }

  decoderOf(context) {
    if (!this._decoders.has(context)) this._decoders.set(context, new TextDecoder(this.encoding));
    return this._decoders.get(context);
  }

  push(bytes, context = 'default') {
    if (!this.accept(bytes)) return { claimed: false, messages: [] };

    const text = this.decoderOf(context).decode(bytes, { stream: true });
    let buffer = (this.stateOf(context) ?? '') + text;
    const messages = [];
    let cursor = 0;
    let index = buffer.indexOf(this.delimiter, cursor);

    while (index >= 0) {
      const line = buffer.slice(cursor, index).replace(/\r$/, '');
      cursor = index + this.delimiter.length;
      if (line.length > 0) messages.push({ kind: 'line', text: line });
      index = buffer.indexOf(this.delimiter, cursor);
    }

    buffer = buffer.slice(cursor);
    this.setState(context, buffer);
    return { claimed: true, messages, pending: buffer };
  }

  reset(context) {
    super.reset(context);
    if (context === undefined) this._decoders.clear();
    else this._decoders.delete(context);
  }
}

const CRC_RANGES = ['payload', 'lengthAndPayload', 'headerAndPayload'];

export class MagicLengthFramer extends Framer {
  constructor(options = {}) {
    super();
    const magic = options.magic ? Uint8Array.from(options.magic) : null;
    if (!magic || magic.length === 0) {
      throw new Error('MagicLengthFramer needs a non-empty magic');
    }
    if (options.crcRange !== undefined && !CRC_RANGES.includes(options.crcRange)) {
      throw new Error('unsupported crcRange: ' + options.crcRange);
    }

    this.magic = magic;
    this.lengthSize = options.lengthSize ?? 2;
    this.payloadLength = options.payloadLength ?? null;
    this.trailer = Uint8Array.from(options.trailer ?? []);
    this.crc = options.crc ?? null;
    this.crcSize = this.crc ? options.crcSize ?? 2 : 0;
    this.crcRange = options.crcRange ?? 'payload';
    this.maxPayloadLength = options.maxPayloadLength ?? MAX_FRAME_PAYLOAD;
    this.headerLength = this.magic.length + this.lengthSize;
    this.minLength = this.headerLength + this.crcSize + this.trailer.length;
  }

  frameLength(payloadLength) {
    return this.headerLength + payloadLength + this.crcSize + this.trailer.length;
  }

  crcStartIndex() {
    if (this.crcRange === 'lengthAndPayload') return this.magic.length;
    if (this.crcRange === 'headerAndPayload') return 0;
    return this.headerLength;
  }

  push(bytes, context = 'default') {
    let buffer = concatBytes(this.stateOf(context) ?? new Uint8Array(0), bytes);
    const messages = [];
    let claimed = false;

    while (buffer.length >= this.minLength) {
      const start = findPattern(buffer, this.magic);
      if (start < 0) {
        buffer =
          buffer[buffer.length - 1] === this.magic[this.magic.length - 1]
            ? buffer.slice(buffer.length - 1)
            : new Uint8Array(0);
        break;
      }
      if (start > 0) buffer = buffer.slice(start);
      if (buffer.length < this.headerLength) break;

      const payloadLength = readUintLE(buffer, this.magic.length, this.lengthSize);
      if (
        (this.payloadLength !== null && payloadLength !== this.payloadLength) ||
        payloadLength > this.maxPayloadLength
      ) {
        buffer = buffer.slice(1);
        continue;
      }

      const frameLength = this.frameLength(payloadLength);
      if (buffer.length < frameLength) break;
      if (!matchesAt(buffer, frameLength - this.trailer.length, this.trailer)) {
        buffer = buffer.slice(1);
        continue;
      }

      const frame = buffer.slice(0, frameLength);
      const payload = frame.slice(this.headerLength, this.headerLength + payloadLength);
      buffer = buffer.slice(frameLength);
      claimed = true;

      if (!this.crc) {
        messages.push({ kind: 'frame', frame, payload, expected: null, actual: null });
        continue;
      }

      const expected = readUintLE(frame, this.headerLength + payloadLength, this.crcSize);
      const actual = this.crc(frame.slice(this.crcStartIndex(), this.headerLength + payloadLength));
      messages.push({
        kind: actual === expected ? 'frame' : 'crc-error',
        frame,
        payload,
        expected,
        actual,
      });
    }

    this.setState(context, buffer);
    return { claimed: claimed || buffer.length > 0, messages, pending: buffer };
  }
}

export class Link extends Emitter {
  constructor(options = {}) {
    super();
    this._transports = [];
    this._framers = [];
    this.options = options;
  }

  get transports() {
    return [...this._transports];
  }

  names() {
    return this._transports.map((transport) => transport.name);
  }

  get(name) {
    return this._transports.find((transport) => transport.name === name) ?? null;
  }

  add(transport) {
    this._transports.push(transport);
    transport.on('data', ({ bytes }) => this._handleIncoming(transport, bytes));
    transport.on('state', (detail) => this.emit('state', detail));
    transport.on('disconnected', (detail) => this.emit('disconnected', detail));
    transport.on('error', (error) => this.emit('error', error));
    transport.on('log', (entry) => this.emit('log', entry));
    this.emit('transport', { transport });
    return transport;
  }

  use(framer, options = {}) {
    this._framers.push({ framer, target: options.target ?? null });
    return this;
  }

  reset(context) {
    for (const { framer } of this._framers) framer.reset(context);
  }

  _select(targets) {
    if (targets === undefined || targets === null) return this.transports;
    const wanted = Array.isArray(targets) ? targets : [targets];
    return this._transports.filter((transport) => wanted.includes(transport.name));
  }

  _handleIncoming(transport, bytes) {
    const hex = bytesToHex(bytes);
    this.emit('rx', { transport, bytes, hex, text: new TextDecoder().decode(trimTrailingZeros(bytes)) });

    for (const { framer, target } of this._framers) {
      if (target && target !== transport.name) continue;
      const result = framer.push(bytes, transport.name);
      if (!result.claimed) continue;
      for (const message of result.messages) {
        this.emit('message', { ...message, transport, bytes, hex });
      }
      return;
    }

    this.emit('unhandled', { transport, bytes, hex });
  }

  async send(text, options = {}) {
    const payload = ensureLineEnding(text, options.eol ?? DEFAULT_LINE_EOL);
    if (!payload) return [];
    return this.sendBytes(textEncoder.encode(payload), options);
  }

  async sendBytes(bytes, options = {}) {
    const targets = this._select(options.targets);
    const sent = [];
    let firstError = null;

    for (const transport of targets) {
      try {
        await transport.write(bytes);
        sent.push(transport.name);
        this.emit('tx', { transport, bytes, hex: bytesToHex(bytes) });
      } catch (error) {
        const wrapped = error?.code
          ? error
          : transportError('SEND_FAILED', transport.name + ' write failed: ' + (error?.message || error), error);
        if (!firstError) firstError = wrapped;
        this.emit('error', wrapped);
      }
    }

    if (sent.length === 0 && firstError) throw firstError;
    return sent;
  }

  async disconnectAll() {
    for (const transport of this._transports) {
      try {
        await transport.disconnect();
      } catch (error) {
        this.emit('error', error);
      }
    }
  }
}
