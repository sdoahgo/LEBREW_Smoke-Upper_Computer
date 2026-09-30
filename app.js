// app.js — LEBREW SMOKE 除烟机上位机主逻辑
// 依赖基座 comm_link.js（不改核心）+ smoke_protocol / smoke_ble / smoke_sim

import { Link, MagicLengthFramer, SerialTransport, bytesToHex } from './comm_link.js?v=20260930n';
import { SmokeBleTransport } from './smoke_ble.js?v=20260930n';
import { SmokeSimulator } from './smoke_sim.js?v=20260930n';
import {
  ACK_WINDOW,
  CMD,
  HOST_VERSION,
  SERIAL_CHUNK,
  DEVICE_STATES,
  OTA_MAX_CHUNK,
  PURGE_LEVELS,
  SMOKE_BLE,
  SMOKE_SERIAL,
  SWITCHER_STATES,
  buildCommand,
  buildOtaControl,
  buildOtaData,
  buildOtaStart,
  describeFault,
  frameSerial,
  parseUplink,
} from './smoke_protocol.js?v=20260930s';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date();

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

/** 串口 OTA 高速模式：不换端口对象、直接关开切换波特率（无需重新选口） */
function makeReopenable(serialTransport) {
  serialTransport.reopen = async function reopen(baudRate) {
    this._readActive = false;
    try { await this._reader?.cancel(); } catch (_) {}
    // 等旧读循环完全退出（其 finally 会把 _reader 置空），避免两个循环抢串口
    for (let i = 0; i < 100 && this._reader !== null; i += 1) await sleep(10);
    this._reader = null;
    try { this._writer?.releaseLock(); } catch (_) {}
    this._writer = null;
    try { await this._port.close(); } catch (_) {}
    this.baudRate = baudRate;
    await this._port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this._writer = this._port.writable.getWriter();
    this._readActive = true;
    this._setState('connected');
    this._readLoop();
  };
  return serialTransport;
}

const state = {
  useMock: false,   // 首次打开默认真机模式，勾选「模拟设备」进入无硬件演示
  link: null,
  ble: null,
  serial: null,
  sim: null,
  telemetry: { state: -1, gear: 0, rpm: 0, inlet: null, outlet: null, ssr: 0, voc: 0, hum: 0 },
  settings: null,
  version: null,
  versionAt: 0,          // 0xB3 到达时刻，运行时间本地走秒用
  tempUnitF: false,                          // 温度单位跟随设备设置（false=℃ true=℉）
  temps: { inlet: null, outlet: null, ambient: null },   // 最近一次原始摄氏值
  activeFaults: new Map(),
  history: [],            // {t, inlet, outlet, rpm, ssr}
  chartPaused: false,
  otaBusy: false,
  booting: false,
};

// ---------------------------------------------------------------------------
// 通道管理
// ---------------------------------------------------------------------------

async function teardown() {
  if (state.link) {
    state.link.on && null;
    await state.link.disconnectAll().catch(() => {});
  }
  state.sim?.stop();
  state.link = state.ble = state.serial = state.sim = null;
  resetDeviceUi();
}

/* 断开/重建共用的界面复位：运行时间、温度单位、挡位网格、切换器全部回默认，
 * 重连后由设备 0xB0/0xB1/遥测重新同步 */
function resetDeviceUi() {
  state.version = null;
  $('aboutUptime').textContent = '--';
  state.tempUnitF = false;
  state.temps = { inlet: null, outlet: null, ambient: null };
  refreshMainTemps();
  applyFanLimit(120);
  swGearSel = 0;
  state.telemetry.switcherState = -1;
  refreshSwitcherUi();
  state.activeFaults.clear();   // 断开清空故障，重连后由 READ_STATE 的 0xA2 重新同步
  renderFaultBanner();
}

async function build() {
  await teardown();   // 必须等旧通道销毁完成再重建，否则重建结果会被异步置空
  state.useMock = $('useMock').checked;
  if (state.useMock) state.sim = new SmokeSimulator().start();
  $('simPanel').classList.toggle('hidden', !state.useMock);

  const link = new Link();
  state.link = link;

  state.serial = makeReopenable(link.add(new SerialTransport({
    name: 'UART0',
    serial: state.useMock ? state.sim.serial : (globalThis.navigator?.serial ?? null),
    baudRate: SMOKE_SERIAL.baudRate,
  })));

  state.ble = link.add(new SmokeBleTransport({
    bluetooth: state.useMock ? state.sim.bluetooth : (globalThis.navigator?.bluetooth ?? null),
  }));

  link.use(new MagicLengthFramer(SMOKE_SERIAL.frame), { target: 'UART0' });

  link.on('message', ({ payload, transport }) => {
    handleUplink(parseUplink(payload), transport);
  });
  state.ble.on('data', ({ bytes }) => {
    handleUplink(parseUplink(bytes), state.ble);
  });
  link.on('rx', ({ transport, bytes }) => logPane(transport === state.ble ? 'ble' : 'serial', 'RX', bytes));
  link.on('tx', ({ transport, bytes }) => logPane(transport === state.ble ? 'ble' : 'serial', 'TX', bytes));

  for (const transport of [state.ble, state.serial]) {
    transport.on('state', () => refreshChips(transport));
    transport.on('disconnected', () => {
      refreshChips(transport);
      if (transport === state.ble) setBadge('未连接', '');
      if (!anyChannel()) {
        setBadge('未连接', '');
        resetDeviceUi();   // 全部通道断开：主控界面完整复位，不再残留设备状态
      }
    });
    transport.on('error', (error) => {
      logPane(transport === state.ble ? 'ble' : 'serial', 'ER', new TextEncoder().encode(error?.message || String(error)));
    });
  }

  refreshChips(state.ble);
  refreshChips(state.serial);
  refreshRunButtons();
  setDeviceText('未连接');
  checkBrowserSupport();
}

/** 浏览器能力自检：结果显示在顶栏，用于区分「浏览器不支持」和「设备问题」 */
function checkBrowserSupport() {
  const bt = typeof globalThis.navigator?.bluetooth?.requestDevice === 'function';
  const ser = typeof globalThis.navigator?.serial?.requestPort === 'function';
  if (bt && ser) {
    setDeviceText('未连接 · 浏览器能力正常');
    return;
  }
  const parts = [];
  if (!bt) parts.push('蓝牙不支持');
  if (!ser) parts.push('串口不支持');
  setDeviceText('浏览器能力异常：' + parts.join('、') + '——请用 Edge 或 Chrome 打开本页');
  console.warn('browser support:', { bluetooth: bt, serial: ser });
}

function refreshChips(transport) {
  const isBle = transport === state.ble;
  const chip = $(isBle ? 'chipBle' : 'chipSerial');
  const button = $(isBle ? 'btnBle' : 'btnSerial');
  chip.classList.toggle('on', transport.isConnected);
  button.textContent = transport.isConnected ? (isBle ? '断开蓝牙' : '断开串口') : (isBle ? '连接蓝牙' : '连接串口');
  if (anyChannel()) $('otaFileInfo').dataset.ready = '1';
}

function anyChannel() {
  return Boolean(state.ble?.isConnected || state.serial?.isConnected);
}

async function bootSequence(source) {
  if (state.booting) return;
  state.booting = true;
  try {
    await sendCommand(CMD.READ_VERSION);
    await sleep(80);
    await sendCommand(CMD.READ_ALL);
    await sleep(80);
    if ($('telemetryOn').checked) {
      await sendCommand(CMD.TELEMETRY_CFG, [1, 0xf4, 0x01]); // 500ms 小端
    }
  } finally {
    state.booting = false;
  }
  void source;
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

async function sendCommand(cmd, args = [], targets = 'connected') {
  const payload = buildCommand(cmd, args);
  const jobs = [];
  if (state.ble?.isConnected && (targets === 'connected' || targets.includes('ble'))) {
    jobs.push(state.ble.writeCommand(payload).then(() => logPane('ble', 'TX', payload)));
  }
  if (state.serial?.isConnected && (targets === 'connected' || targets.includes('serial'))) {
    jobs.push(state.link.sendBytes(frameSerial(payload), { targets: ['UART0'] }));
  }
  if (!jobs.length) {
    setDeviceText('未连接任何通道');
    throw new Error('未连接任何通道');
  }
  await Promise.allSettled(jobs);
}

async function sendControl(bytes, target) {
  if (target === 'ble') {
    if (!state.ble?.isConnected) throw new Error('蓝牙未连接');
    await state.ble.writeControl(bytes);
    logPane('ble', 'TX', bytes);
    return;
  }
  if (!state.serial?.isConnected) throw new Error('串口未连接');
  await state.link.sendBytes(frameSerial(bytes), { targets: ['UART0'] });
}

async function sendDataPacket(bytes, target) {
  if (target === 'ble') {
    await state.ble.writeData(bytes);
    return;
  }
  await state.link.sendBytes(frameSerial(bytes), { targets: ['UART0'] });
}

// ---------------------------------------------------------------------------
// 上行处理
// ---------------------------------------------------------------------------

let pendingAck = null;

function waitAck(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    pendingAck = { resolve };
    pendingAck.timer = setTimeout(() => {
      pendingAck = null;
      reject(new Error('等待 ACK 超时'));
    }, timeoutMs);
  });
}

/** 先注册 ACK 等待器再发送（设备可能同步回包，后注册会丢 ACK） */
async function sendAndWaitAck(bytes, target, timeoutMs = 4000) {
  const waiter = waitAck(timeoutMs);
  await sendControl(bytes, target);
  return waiter;
}

function feedAck(ack) {
  if (!pendingAck) return;
  const waiter = pendingAck;
  pendingAck = null;
  clearTimeout(waiter.timer);
  waiter.resolve(ack);
}

function handleUplink(message, transport) {
  switch (message.type) {
    case 'telemetry':
      applyTelemetry(message);
      break;
    case 'fault':
      applyFault(message.code, message.active);
      break;
    case 'ack':
      feedAck(message);
      break;
    case 'settings':
      applySettings(message);
      break;
    case 'state':
      state.telemetry.state = message.state;
      state.telemetry.gear = message.gear;
      setBadge(DEVICE_STATES[message.state] ?? '未知', 's' + message.state);
      $('purgeLevel').textContent = PURGE_LEVELS[message.purgeLevel] ?? '—';
      state.telemetry.switcherState = message.switcherState;
      swGearSel = message.switcherGear || swGearSel;   // 0=未知时保留上次显示
      refreshSwitcherUi();
      $('boostBadge').classList.toggle('hidden', !message.boostActive);
      refreshRunButtons();
      break;
    case 'sensors':
      state.temps = { inlet: message.inletTemp, outlet: message.outletTemp, ambient: message.ambientTemp };
      refreshMainTemps();
      updateValue('vocValue', message.voc);
      updateValue('humValue', message.humidity);
      break;
    case 'version':
      state.version = message;
      state.versionAt = Date.now();
      setDeviceText('LEBREW SMOKE · 固件 ' + message.sw + ' · 硬件 ' + message.hw);
      $('aboutSw').textContent = message.sw;
      $('aboutHw').textContent = message.hw;
      $('aboutUptime').textContent = formatUptime(message.uptime);
      break;
    case 'selftest':
      applySelftest(message);
      break;
    case 'text':
      otaLogLine('[设备] ' + message.text);
      if (message.text.includes('AP:REBOOTING')) showWifiSteps();
      break;
    case 'crc-error':
      logPane(transport === state.ble ? 'ble' : 'serial', 'ER', new TextEncoder().encode('CRC 校验失败'));
      break;
    default:
      break;
  }
}

function applyTelemetry(t) {
  state.telemetry = t;
  setBadge(DEVICE_STATES[t.state] ?? '未知', 's' + t.state);
  $('purgeLevel').textContent = PURGE_LEVELS[t.purgeLevel] ?? '—';
  const purgeEl = $('purgeLevel');
  purgeEl.className = 'pill p' + t.purgeLevel;
  refreshSwitcherUi();
  $('boostBadge').classList.toggle('hidden', !t.boostActive);
  refreshRunButtons();

  gearSel = t.gear;   // 挡位始终跟随设备（设备是唯一事实源）
  refreshGearButtons();
  $('rpmValue').textContent = t.rpm;
  state.temps = { inlet: t.inletTemp, outlet: t.outletTemp, ambient: t.ambientTemp };
  refreshMainTemps();   // 出风口 PT100 实测 = 催化温度
  updateValue('ssrValue', t.ssrPwm);
  updateValue('vocValue', t.voc);
  updateValue('humValue', t.humidity);

  if (t.faultCode) applyFault(t.faultCode, true);

  if (!state.chartPaused) {
    state.history.push({ t: Date.now(), inlet: t.inletTemp, outlet: t.outletTemp, rpm: t.rpm, ssr: t.ssrPwm });
    if (state.history.length > 24000) state.history.shift();
    for (const chart of charts) chart.push(Date.now());
  }
}

function applyFault(code, active) {
  if (active) {
    if (!state.activeFaults.has(code)) {
      state.activeFaults.set(code, true);
      const lang = state.settings?.language ?? 0;
      const text = describeFault(code)[lang ? 'en' : 'zh'];
      showFaultPopup(text);
    }
  } else {
    state.activeFaults.delete(code);
  }
  renderFaultBanner();
}

function renderFaultBanner() {
  const banner = $('faultBanner');
  const list = $('faultList');
  list.textContent = '';
  if (!state.activeFaults.size) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  const lang = state.settings?.language ?? 0;
  for (const code of state.activeFaults.keys()) {
    const li = document.createElement('li');
    li.textContent = describeFault(code)[lang ? 'en' : 'zh'];
    list.appendChild(li);
  }
}

function showFaultPopup(text) {
  $('faultOverlayText').textContent = text;
  $('faultOverlay').classList.remove('hidden');
}

function applySettings(s) {
  state.settings = s;
  const unitF = s.tempUnit === 1;
  if (unitF !== state.tempUnitF) {
    state.tempUnitF = unitF;
    refreshMainTemps();   // 设备端（或上位机）切换单位，主控界面数值与单位立即跟随
  }
  settingGroups.language.set(s.language);
  settingGroups.tempUnit.set(s.tempUnit);
  settingGroups.boostDuration.set(s.boostDuration);
  settingGroups.memory.set(s.memoryMode);
  settingGroups.fanLimit.set(s.fanLimit ?? 100);
  applyFanLimit(s.fanLimit ?? 100);   // 主控挡位网格跟随上限：100 隐藏 110/120，120 全显
  catalyticStepper.show(s.catalyticTemp);
}

function applySelftest(m) {
  const map = [
    ['stTemp', m.tempOk],
    ['stVoc', m.vocOk],
    ['stHum', m.humOk],
  ];
  for (const [id, ok] of map) {
    const el = $(id);
    el.classList.remove('ok', 'bad');
    if (ok === 1) el.classList.add('ok');
    if (ok === 2) el.classList.add('bad');
    el.querySelector('em').textContent = m.stage >= 3 ? (ok === 2 ? '失败' : '通过') : '自检中';
  }
}

// ---------------------------------------------------------------------------
// UI 小工具
// ---------------------------------------------------------------------------

function setBadge(text, cls) {
  const badge = $('stateBadge');
  badge.textContent = text;
  badge.className = 'statebadge' + (cls ? ' ' + cls : '');
}

function setDeviceText(text) {
  $('deviceInfo').textContent = text;
}

function updateValue(id, value, digits = 0) {
  const el = $(id);
  el.textContent = value == null ? '--' : Number(value).toFixed(digits);
}

// —— 主控界面温度显示：单位与数值跟随设备设置（0xB0）实时同步 ——
function fmtTempC(celsius) {
  if (celsius == null || Number.isNaN(celsius)) return '--';
  return (state.tempUnitF ? celsius * 1.8 + 32 : celsius).toFixed(1);
}

function refreshMainTemps() {
  const unit = state.tempUnitF ? '℉' : '℃';
  $('inletUnit').textContent = unit;
  $('outletUnit').textContent = unit;
  $('ambientUnit').textContent = unit;
  $('inletValue').textContent = fmtTempC(state.temps.inlet);
  $('outletValue').textContent = fmtTempC(state.temps.outlet);
  $('ambientValue').textContent = fmtTempC(state.temps.ambient);
}

function setSelect(id, value) {
  $(id).value = String(value);
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (h ? h + ' 时 ' : '') + m + ' 分 ' + s + ' 秒';
}

// 运行时间走秒：0xB3 只在连接握手时读一次，这里基于快照每秒本地累加，
// 断开重连（或设备 OTA 重启后重连）会用新的 0xB3 重新校准
setInterval(() => {
  if (!state.version) return;
  const uptime = state.version.uptime + (Date.now() - state.versionAt) / 1000;
  $('aboutUptime').textContent = formatUptime(uptime);
}, 1000);

// ---------------------------------------------------------------------------
// 曲线（自绘 canvas，零依赖）
// ---------------------------------------------------------------------------

class TinyChart {
  constructor(canvas, pick, color, unit, minSpan = 10, fixedRange = null, floorZero = false) {
    this.canvas = canvas;
    this.pick = pick;
    this.color = color;
    this.unit = unit;
    this.minSpan = minSpan; // 纵轴最小跨度：数据平稳时保持这个宽度，不压缩
    this.fixedRange = fixedRange; // 固定纵轴范围（如 [0, 100]）：完全不做自适应
    this.floorZero = floorZero; // 纵轴最低值锁定 0（最高值仍自适应）
    this.windowMs = 300000;
    this.raf = null;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(100, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(60, Math.round(rect.height * ratio));
    this.draw();
  }

  push() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.draw();
    });
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const ratio = window.devicePixelRatio || 1;
    ctx.font = Math.round(10 * ratio) + 'px Consolas, monospace';

    const nowT = Date.now();
    const from = nowT - this.windowMs;
    const points = state.history.filter((p) => p.t >= from).map((p) => ({ t: p.t, v: this.pick(p) }));
    if (points.length === 0) {
      ctx.fillStyle = '#9aa0ab';
      ctx.fillText('等待遥测数据…', 12 * ratio, 20 * ratio);
      return;
    }

    let min;
    let max;
    let gridCount;
    if (this.fixedRange) {
      // 固定纵轴（发热丝 PWM 0–100%）：刻度 0/25/50/75/100，永不缩放
      min = this.fixedRange[0];
      max = this.fixedRange[1];
      gridCount = 4;
    } else {
      let dataMin = Infinity;
      let dataMax = -Infinity;
      for (const p of points) {
        if (p.v < dataMin) dataMin = p.v;
        if (p.v > dataMax) dataMax = p.v;
      }
      if (dataMax - dataMin < 1e-6) { dataMax += 1; dataMin -= 1; }
      min = dataMin;
      max = dataMax;
      if (max - min < this.minSpan) {
        // 数据平稳时不再贴着波动范围压缩：以数据中心向上下各留 minSpan/2，
        // 避免 ±0.5℃ 的抖动被放大成大起大落
        const center = (max + min) / 2;
        min = center - this.minSpan / 2;
        max = center + this.minSpan / 2;
      } else {
        const pad = (max - min) * 0.12;
        min -= pad; max += pad;
      }

      if (this.floorZero) min = 0;   // 转速等曲线纵轴从 0 起，最高值自适应

      // 纵轴范围吸附到 1/2/5×10^k 的整刻度，网格 3~5 根
      const step = niceStep((max - min) / 3);
      min = Math.floor(min / step) * step;
      max = Math.ceil(max / step) * step;
      gridCount = Math.max(1, Math.min(5, Math.round((max - min) / step)));
    }

    const left = 44 * ratio;
    const bottom = h - 16 * ratio;
    const top = 6 * ratio;
    const plotW = w - left - 8 * ratio;
    const plotH = bottom - top;

    // 网格与纵轴
    ctx.strokeStyle = '#e5e8ee';
    ctx.fillStyle = '#8a919d';
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridCount; i += 1) {
      const y = top + (plotH * i) / gridCount;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(w - 8 * ratio, y);
      ctx.stroke();
      const value = max - ((max - min) * i) / gridCount;
      ctx.fillText(formatTick(value), 4 * ratio, y + 4 * ratio);
    }

    // 曲线
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.6 * ratio;
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      const x = left + ((p.t - from) / this.windowMs) * plotW;
      const y = top + plotH - ((p.v - min) / (max - min)) * plotH;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 当前值
    const last = points[points.length - 1];
    ctx.fillStyle = this.color;
    ctx.fillText(String(Math.round(last.v * 10) / 10) + ' ' + this.unit, left + 6 * ratio, top + 12 * ratio);

    // 横轴时间
    ctx.fillStyle = '#8a919d';
    const span = this.windowMs;
    const steps = 4;
    for (let i = 0; i <= steps; i += 1) {
      const t = new Date(from + (span * i) / steps);
      const label = String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
      const x = left + (plotW * i) / steps;
      ctx.fillText(label, Math.min(x, w - 34 * ratio), h - 4 * ratio);
    }
  }
}

function formatTick(value) {
  if (Math.abs(value) >= 1000) return String(Math.round(value / 100) / 10) + 'k';
  return String(Math.round(value * 10) / 10);
}

/** 把原始刻度间隔吸附到 1/2/5×10^k 的「好刻度」 */
function niceStep(raw) {
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const base = raw / power;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return nice * power;
}

const charts = [
  new TinyChart($('chartInlet'), (p) => p.inlet, '#e0512f', '℃', 30),
  new TinyChart($('chartOutlet'), (p) => p.outlet, '#d97706', '℃', 30),
  new TinyChart($('chartRpm'), (p) => p.rpm, '#2563eb', 'rpm', 600, null, true),
  new TinyChart($('chartSsr'), (p) => p.ssr, '#16a34a', '%', 25, [0, 100]),
];

// ---------------------------------------------------------------------------
// OTA 传输引擎（蓝牙/串口共用，窗口 ACK）
// ---------------------------------------------------------------------------

function otaLogLine(text) {
  const el = $('otaLog');
  const time = now().toTimeString().slice(0, 8);
  el.textContent += '[' + time + '] ' + text + '\n';
  el.scrollTop = el.scrollHeight;
}

function setOtaProgress(sent, total, t0) {
  const pct = total ? Math.floor((sent * 100) / total) : 0;
  $('otaBar').style.width = pct + '%';
  $('otaPercent').textContent = pct + '%';
  const sec = (Date.now() - t0) / 1000;
  const speed = sec > 0 ? sent / sec / 1024 : 0;
  const remain = speed > 0 ? (total - sent) / 1024 / speed : 0;
  $('otaDetail').textContent = (sent / 1024).toFixed(1) + ' / ' + (total / 1024).toFixed(1) + ' KB · '
    + speed.toFixed(1) + ' KB/s · 剩余 ' + (remain > 90 ? Math.ceil(remain / 60) + ' 分' : Math.ceil(remain) + ' 秒');
}

let otaFileBytes = null;

async function runOta(target) {
  if (state.otaBusy) return;
  if (!otaFileBytes) { otaLogLine('请先选择 .bin 固件文件'); return; }
  const connected = target === 'ble' ? state.ble?.isConnected : state.serial?.isConnected;
  if (!connected) { otaLogLine((target === 'ble' ? '蓝牙' : '串口') + '未连接'); return; }

  const bytes = otaFileBytes;
  const total = bytes.length;
  const chunk = target === 'ble' ? OTA_MAX_CHUNK : SERIAL_CHUNK;
  const totalPackets = Math.ceil(total / chunk);
  state.otaBusy = true;
  const t0 = Date.now();
  otaLogLine('开始' + (target === 'ble' ? '蓝牙' : '串口') + '升级：' + total + ' 字节，' + totalPackets + ' 包，chunk=' + chunk);

  try {
    // 串口 OTA 固定 115200（高波特率在本硬件误码），固件无波特率切换命令

    const start = await sendAndWaitAck(buildOtaStart(total, chunk), target, 3000);
    if (!start.ok) throw new Error('设备拒绝开始（NACK seq=' + start.seq + '）');
    otaLogLine('START 已确认，开始发送数据');

    let seq = 0;
    let windowRetry = 0;
    while (seq < totalPackets) {
      const windowStart = seq;
      const batchEnd = Math.min(seq + ACK_WINDOW, totalPackets);
      const waiter = waitAck(5000); // 先等再发：窗口内任一包都可能触发 ACK/NACK
      if (target === 'ble') {
        // 蓝牙：逐包顺序写 + 6ms 间隔（并发写触发 GATT 冲突；连发会塞满设备接收队列）
        for (; seq < batchEnd; seq += 1) {
          const piece = bytes.subarray(seq * chunk, Math.min((seq + 1) * chunk, total));
          await sendDataPacket(buildOtaData(seq, piece), target);
          await sleep(6);
          setOtaProgress(Math.min((seq + 1) * chunk, total), total, t0);
        }
      } else {
        // 串口：逐帧发送 + 帧间 8ms 间隔。
        // 实测本机串口路径连续突发会丢字节，带 8ms 间隔 2MB 传输零重传。
        for (; seq < batchEnd; seq += 1) {
          const piece = bytes.subarray(seq * chunk, Math.min((seq + 1) * chunk, total));
          await sendDataPacket(buildOtaData(seq, piece), target);
          await sleep(8);
          setOtaProgress(Math.min((seq + 1) * chunk, total), total, t0);
        }
      }
      let ack;
      try {
        ack = await waiter;
      } catch (_) {
        // 窗口 ACK 超时：重发当前窗口（最多 8 次）
        windowRetry += 1;
        if (windowRetry > 8) throw new Error('连续窗口超时');
        otaLogLine('窗口 ACK 超时，重发第 ' + (seq + 1) + ' 包起');
        seq = windowStart;
        continue;
      }
      windowRetry = 0;
      if (!ack.ok) {
        otaLogLine('NACK：设备要求从 seq=' + ack.seq + ' 重发');
        await sleep(150);   // 给设备写盘任务消化时间，避免重发风暴
        seq = ack.seq;
        continue;
      }
      if (ack.seq !== batchEnd - 1) {
        // 窗口内丢包，从 ACK 之后重发
        seq = ack.seq + 1;
      }
    }

    const done = await sendAndWaitAck(buildOtaControl(CMD.OTA_END), target, 6000);
    if (!done.ok) throw new Error('END 被拒绝（可能字节数不符）');
    otaLogLine('传输完成，设备校验并切换启动分区，即将重启…');
    setOtaProgress(total, total, t0);
    setTimeout(() => otaLogLine('设备已重启，请重新连接后用「关于」核对版本'), 3500);
  } catch (error) {
    otaLogLine('升级失败：' + error.message + '，已发送 ABORT');
    await sendControl(buildOtaControl(CMD.OTA_ABORT), target).catch(() => {});
  } finally {
    state.otaBusy = false;
  }
}

// ---------------------------------------------------------------------------
// WiFi 热点升级（SoftAP 直连）
// ---------------------------------------------------------------------------

let apProbeTimer = null;

function stopApProbe() {
  if (apProbeTimer) {
    clearInterval(apProbeTimer);
    apProbeTimer = null;
  }
}

/** 发出「进入热点模式」后持续探测设备（192.168.4.1），状态实时更新；连上后自动上传 */
function startApProbe() {
  stopApProbe();
  const statusEl = $('wifiProbeStatus');
  statusEl.classList.remove('ok');
  statusEl.textContent = '设备正在重启进入热点模式…（此间蓝牙断开、设备屏幕定格均属正常，请勿给设备断电）';
  const t0 = Date.now();
  let phase = 0;
  apProbeTimer = setInterval(async () => {
    if (state.otaBusy) return;
    if (Date.now() - t0 > 5 * 60 * 1000) {
      stopApProbe();
      statusEl.textContent = '等待超时：未检测到设备热点。请确认电脑 WiFi 已连接 LEBREW-SMOKE 后点「开始上传」重试';
      return;
    }
    if (phase === 0 && Date.now() - t0 > 8000) {
      phase = 1;
      statusEl.textContent = '等待电脑连接热点 LEBREW-SMOKE（密码 12345678）…连上后会自动开始上传';
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      await fetch('http://192.168.4.1/', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      stopApProbe();
      statusEl.classList.add('ok');
      statusEl.textContent = '已连上设备热点，自动开始上传…';
      otaLogLine('检测到设备热点（192.168.4.1 可达），自动开始上传');
      runWifiUpload();
    } catch (_) {
      /* 电脑还没连上热点，继续等 */
    }
  }, 2000);
}

function showWifiSteps() {
  $('wifiSteps').classList.remove('hidden');
  otaLogLine('设备正在重启进入热点模式（LEBREW-SMOKE / 192.168.4.1）');
  startApProbe();
}

async function runWifiUpload() {
  if (state.otaBusy || !otaFileBytes) return;
  state.otaBusy = true;
  const bytes = otaFileBytes;
  const t0 = Date.now();
  try {
    if (state.useMock) {
      otaLogLine('（模拟）直传设备热点 ' + bytes.length + ' 字节');
      for (let pct = 0; pct <= 100; pct += 4) {
        await sleep(90);
        setOtaProgress((bytes.length * pct) / 100, bytes.length, t0);
      }
      await sleep(400);
      state.sim?.exitApMode();
      otaLogLine('（模拟）设备刷机完成，重启回蓝牙模式');
      return;
    }
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'http://192.168.4.1/ota');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setOtaProgress(event.loaded, event.total, t0);
      };
      xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error('HTTP ' + xhr.status)));
      xhr.onerror = () => reject(new Error('上传失败：确认电脑已连上 LEBREW-SMOKE 热点'));
      xhr.send(bytes);
    });
    otaLogLine('上传完成，设备刷机后自动重启回蓝牙模式');
  } catch (error) {
    otaLogLine('WiFi 升级失败：' + error.message);
  } finally {
    state.otaBusy = false;
  }
}

async function startWifiUpgrade() {
  if (!otaFileBytes) { otaLogLine('请先选择 .bin 固件文件'); return; }
  if (!anyChannel()) { otaLogLine('需要先通过蓝牙或串口下发「进入热点模式」'); return; }
  showWifiSteps();
  await sendCommand(CMD.ENTER_AP_OTA);
}

// ---------------------------------------------------------------------------
// 日志面板
// ---------------------------------------------------------------------------

const logPanes = {
  ble: { el: $('logBle'), entries: [], hex: true, paused: false },
  serial: { el: $('logSerial'), entries: [], hex: true, paused: false },
};

function logPane(channel, dir, bytes) {
  const pane = logPanes[channel];
  if (!pane) return;
  pane.entries.push({ t: now(), dir, bytes: bytes.slice() });
  if (pane.entries.length > 600) pane.entries.shift();
  if (pane.paused) return;
  renderLog(pane);
}

function renderLog(pane) {
  const lines = pane.entries.map((entry) => {
    const time = entry.t.toTimeString().slice(0, 8) + '.' + String(entry.t.getMilliseconds()).padStart(3, '0');
    const body = pane.hex
      ? bytesToHex(entry.bytes)
      : new TextDecoder().decode(entry.bytes).replace(/[^\x20-\x7e\n\r\t]/g, '·');
    return time + ' ' + entry.dir.padEnd(2) + ' ' + body;
  });
  pane.el.textContent = lines.join('\n') || '（暂无数据）';
  pane.el.scrollTop = pane.el.scrollHeight;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

$('useMock').addEventListener('change', async () => { await build(); });

$('btnBle').addEventListener('click', async () => {
  if (!state.ble) return;
  if (state.ble.isConnected) { await state.ble.disconnect(); return; }
  try {
    await state.ble.connect();
    await bootSequence('ble');
  } catch (error) {
    setDeviceText('蓝牙连接失败：' + (error?.message || error.code));
  }
});

$('btnSerial').addEventListener('click', async () => {
  if (!state.serial) return;
  if (state.serial.isConnected) { await state.serial.disconnect(); return; }
  try {
    await state.serial.connect();
    await bootSequence('serial');
  } catch (error) {
    setDeviceText('串口连接失败：' + (error?.message || error.code));
  }
});

$('telemetryOn').addEventListener('change', async (event) => {
  if (!anyChannel()) return;
  await sendCommand(CMD.TELEMETRY_CFG, [event.target.checked ? 1 : 0, 0xf4, 0x01]);
});

// —— 主控：12 个固定挡位（10%–120%，120 为 Boost 挡）——
const gearButtons = [...document.querySelectorAll('#gearGrid button')];
let gearSel = 50;

function refreshGearButtons() {
  $('gearValue').textContent = gearSel;
  for (const button of gearButtons) {
    button.classList.toggle('active', Number(button.dataset.gear) === gearSel);
  }
}

// —— 风机上限跟随设备设置（0xB0）：100 时主控挡位最多显示到 100，120（Boost 模式）才显示 110/120 ——
function applyFanLimit(limit) {
  const max = Number(limit) === 120 ? 120 : 100;
  for (const button of gearButtons) {
    button.classList.toggle('hidden', Number(button.dataset.gear) > max);
  }
  if (gearSel > max) {
    gearSel = max;   // 与设备一致：超限的选中挡位被钳到上限
    refreshGearButtons();
  }
}

for (const button of gearButtons) {
  button.addEventListener('click', async () => {
    gearSel = Number(button.dataset.gear);
    refreshGearButtons();
    if (anyChannel()) await withChannel(() => sendCommand(CMD.SET_GEAR, [gearSel]));
  });
}

// —— 气流切换器：三个位置（1 左开 / 2 双开 / 3 右开），未连接时禁用 ——
// 点哪个立即高亮哪个；设备执行后推 0xB1，舵机到位/失败都会纠正高亮，
// 机器上实体按键切换时也推 0xB1 让这里跟着变（设备是唯一事实源）。
const switcherGearButtons = [...document.querySelectorAll('#switcherGearGroup button')];
let swGearSel = 0;

function refreshSwitcherUi() {
  const sw = state.telemetry.switcherState ?? 0;
  $('switcherState').textContent = '切换器 ' + (SWITCHER_STATES[sw] ?? '—');
  $('switcherState').className = 'pill sw' + sw;
  const connected = sw === 2;
  for (const button of switcherGearButtons) {
    button.disabled = !connected;
    button.classList.toggle('active', connected && Number(button.dataset.swGear) === swGearSel);
  }
}

for (const button of switcherGearButtons) {
  button.addEventListener('click', async () => {
    const gear = Number(button.dataset.swGear);
    swGearSel = gear;
    refreshSwitcherUi();   // 立即高亮所点位置
    if (anyChannel()) await withChannel(() => sendCommand(CMD.SET_SWITCHER_GEAR, [gear]));
  });
}

// —— 运行按钮的状态联动：由设备遥测驱动，机器上实体操作也会同步切换 ——
// 运行中（预热/运行/Boost）「开始除烟」常亮；待机/冷却/故障「停止除烟」常亮
// Boost 开/关：对应设备当前状态的一枚亮橙填充，另一枚白底；未连接默认「关」
function setBoostButtons(boosting) {
  $('btnBoostOn').classList.toggle('boost-sel', boosting);
  $('btnBoostOn').classList.toggle('boost-unsel', !boosting);
  $('btnBoostOff').classList.toggle('boost-sel', !boosting);
  $('btnBoostOff').classList.toggle('boost-unsel', boosting);
}

function refreshRunButtons() {
  const t = state.telemetry;
  if (!anyChannel()) {
    for (const id of ['btnStart', 'btnStop']) {
      $(id).classList.remove('ghosted');
    }
    setBoostButtons(false);
    return;
  }
  const running = [1, 2, 3].includes(t.state);
  const boosting = t.boostActive || t.state === 3;
  $('btnStart').classList.toggle('ghosted', !running);
  $('btnStop').classList.toggle('ghosted', running);
  setBoostButtons(boosting);
}

$('btnStart').addEventListener('click', () => withChannel(() => sendCommand(CMD.START_SMOKE, [gearSel])));
$('btnStop').addEventListener('click', () => withChannel(() => sendCommand(CMD.STOP_SMOKE)));
$('btnBoostOn').addEventListener('click', () => withChannel(() => sendCommand(CMD.BOOST_ON, [0])));
$('btnBoostOff').addEventListener('click', () => withChannel(() => sendCommand(CMD.BOOST_OFF)));

async function withChannel(fn) {
  try {
    await fn();
  } catch (error) {
    setDeviceText(error.message);
  }
}

// —— 曲线 ——
// —— 曲线放大：四张图各自的 ⛶ 切换全屏浮层，同时只放大一张（ESC 关闭）——
// 卡片尺寸变化由 TinyChart 的 ResizeObserver 自动触发重绘，无需手动处理
for (const button of document.querySelectorAll('.zoombtn')) {
  button.addEventListener('click', () => {
    const card = button.closest('.chart');
    const wasZoomed = card.classList.contains('zoomed');
    for (const zoomed of document.querySelectorAll('.chart.zoomed')) {
      zoomed.classList.remove('zoomed');
      zoomed.querySelector('.zoombtn').textContent = '⛶';
    }
    if (!wasZoomed) {
      card.classList.add('zoomed');
      button.textContent = '✕';
    }
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const zoomed = document.querySelector('.chart.zoomed');
  if (!zoomed) return;
  zoomed.classList.remove('zoomed');
  zoomed.querySelector('.zoombtn').textContent = '⛶';
});

$('chartWindow').addEventListener('change', (event) => {
  const windowMs = Number(event.target.value);
  for (const chart of charts) chart.windowMs = windowMs;
  for (const chart of charts) chart.draw();
});
$('chartPause').addEventListener('click', (event) => {
  state.chartPaused = !state.chartPaused;
  event.target.textContent = state.chartPaused ? '继续' : '暂停';
});
$('chartExport').addEventListener('click', () => {
  const header = 'time,inlet_c,outlet_c,rpm,ssr_percent';
  const lines = state.history.map((p) =>
    new Date(p.t).toISOString() + ',' + p.inlet + ',' + p.outlet + ',' + p.rpm + ',' + p.ssr);
  downloadText('smoke_telemetry.csv', header + '\n' + lines.join('\n'));
});

// —— 设置 ——
$('btnReadSettings').addEventListener('click', () => withChannel(() => sendCommand(CMD.READ_ALL)));
// —— 设置项按钮组（语言/温度单位/Boost 时长/记忆功能，选中的高亮）——
function wireSegGroup(groupId, cmd) {
  const buttons = [...document.querySelectorAll('#' + groupId + ' button')];
  const group = {
    set(value) {
      for (const button of buttons) {
        button.classList.toggle('active', Number(button.dataset.v) === Number(value));
      }
    },
  };
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const value = Number(button.dataset.v);
      group.set(value);
      await withChannel(() => sendCommand(cmd, [value]));
    });
  }
  return group;
}

// —— 四个设置项按钮组 ——

// —— 催化温度大步进器：[<] 值 [>]，5℃ 步进（设备推送 0xB0 时经 applySettings 刷新）——
const catalyticStepper = {
  value: null,
  show(value) {
    if (value == null || Number.isNaN(value)) return;
    this.value = Math.max(300, Math.min(330, value));
    $('catalyticValue').textContent = this.value;
  },
  async nudge(delta) {
    const base = (this.value == null ? 315 : this.value);
    const next = Math.max(300, Math.min(330, base + delta));
    if (next === this.value) return;
    this.show(next);
    const raw = Math.round(next * 10);
    await withChannel(() => sendCommand(CMD.SET_CATALYTIC_TEMP, [raw & 0xff, (raw >> 8) & 0xff]));
  },
};
$('catalyticDown').addEventListener('click', () => catalyticStepper.nudge(-5));
$('catalyticUp').addEventListener('click', () => catalyticStepper.nudge(5));

const settingGroups = {
  language: wireSegGroup('setLanguageGroup', CMD.SET_LANGUAGE),
  tempUnit: wireSegGroup('setTempUnitGroup', CMD.SET_TEMP_UNIT),
  boostDuration: wireSegGroup('boostDurationGroup', CMD.SET_BOOST_DURATION),
  memory: wireSegGroup('setMemoryGroup', CMD.SET_MEMORY_MODE),
  fanLimit: wireSegGroup('setFanLimitGroup', CMD.SET_FAN_LIMIT),
};

$('btnSelfTest').addEventListener('click', () => withChannel(() => sendCommand(CMD.SELF_TEST)));

// —— 升级 ——
$('otaFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const magicOk = bytes[0] === 0xe9;
  const sizeOk = bytes.length > 0 && bytes.length <= 0x280000;
  otaFileBytes = sizeOk && magicOk ? bytes : null;
  $('otaFileInfo').textContent = file.name + ' · ' + bytes.length + ' 字节 · '
    + (magicOk ? '魔数 OK' : '魔数异常(非 ESP 镜像)') + ' · ' + (sizeOk ? '大小 OK' : '超出 OTA 分区 2.5MB');
  $('otaFileInfo').style.color = otaFileBytes ? '' : 'var(--danger)';
  otaLogLine('已选择固件：' + file.name + '（' + bytes.length + ' 字节）'
    + (otaFileBytes ? '' : ' —— 校验未通过，不可升级'));
});
$('otaSerial').addEventListener('click', () => runOta('serial'));
$('otaBle').addEventListener('click', () => runOta('ble'));
$('otaWifi').addEventListener('click', () => startWifiUpgrade());
$('wifiUpload').addEventListener('click', () => runWifiUpload());

// —— 日志 ——
for (const button of document.querySelectorAll('.logfmt')) {
  button.addEventListener('click', () => {
    const pane = logPanes[button.dataset.ch];
    pane.hex = !pane.hex;
    button.textContent = pane.hex ? 'HEX' : '文本';
    renderLog(pane);
  });
}
for (const button of document.querySelectorAll('.logpause')) {
  button.addEventListener('click', () => {
    const pane = logPanes[button.dataset.ch];
    pane.paused = !pane.paused;
    button.textContent = pane.paused ? '继续' : '暂停';
  });
}
for (const button of document.querySelectorAll('.logclear')) {
  button.addEventListener('click', () => {
    const pane = logPanes[button.dataset.ch];
    pane.entries = [];
    renderLog(pane);
  });
}
for (const button of document.querySelectorAll('.logexport')) {
  button.addEventListener('click', () => {
    const pane = logPanes[button.dataset.ch];
    const text = pane.entries.map((entry) => {
      const time = entry.t.toTimeString().slice(0, 8) + '.' + String(entry.t.getMilliseconds()).padStart(3, '0');
      return time + ' ' + entry.dir + ' ' + bytesToHex(entry.bytes);
    }).join('\n');
    downloadText('smoke_' + button.dataset.ch + '_log.txt', text || '（空）');
  });
}

// —— 模拟器面板 ——
$('simTrigger').addEventListener('click', () => {
  state.sim?.triggerFault(Number($('simFault').value));
});
$('simClear').addEventListener('click', () => state.sim?.clearFault());
$('simSwitcher').addEventListener('click', () => {
  if (!state.sim) return;
  state.sim.switcherState = (state.sim.switcherState + 1) % 3;
});

// —— 故障弹窗 ——
$('faultAck').addEventListener('click', () => $('faultOverlay').classList.add('hidden'));


function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

build();
window.__smokeState = state; // 调试入口

// 标签栏右侧显示上位机版本（唯一事实源 HOST_VERSION）
$('hostVersion').textContent = '上位机 v' + HOST_VERSION;
