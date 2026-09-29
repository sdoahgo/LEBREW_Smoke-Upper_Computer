// comm_panel.js — 通道面板组件
// 给每个通道（串口 / 蓝牙）一份自己的「输出框 + 输入框」，样式自带，直接挂到页面上即可。

import { bytesToHex, trimTrailingZeros } from './comm_link.js';

// 这块字节解出来到底是不是真文本。
// 二进制块用 TextDecoder 解出来也是「能显示」的乱码，直接塞进输出框就是噪音。
// 只有重新编码回去和原始字节一模一样，才认为它本来就是文本。
function isLosslessText(entry) {
  const text = entry.text ?? '';
  if (!text) return false;
  const raw = trimTrailingZeros(entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes ?? []));
  const encoded = new TextEncoder().encode(text);
  if (encoded.length !== raw.length) return false;
  for (let i = 0; i < raw.length; i += 1) if (encoded[i] !== raw[i]) return false;
  return true;
}

const STYLE_ID = 'next-link-panel-style';

const STYLE = [
  '.comm-grid { display: grid; gap: 14px; align-items: start; }',
  '.comm-panel {',
  '  display: flex; flex-direction: column;',
  '  border: 1px solid #d9e0ea; border-radius: 10px; background: #fff;',
  '  min-width: 0; overflow: hidden;',
  '}',
  '.comm-head {',
  '  display: flex; align-items: center; gap: 8px;',
  '  padding: 10px 12px; border-bottom: 1px solid #d9e0ea; background: #f8fafc;',
  '}',
  '.comm-title { font-weight: 600; font-size: 14px; color: #1d2433; }',
  '.comm-sub { font-size: 12px; color: #697386; }',
  '.comm-spacer { flex: 1; }',
  '.comm-dot { width: 8px; height: 8px; border-radius: 50%; background: #b42318; }',
  '.comm-dot.on { background: #067647; }',
  '.comm-btn {',
  '  font: inherit; font-size: 12px; padding: 5px 10px;',
  '  border: 1px solid #d9e0ea; border-radius: 7px; background: #fff; cursor: pointer;',
  '}',
  '.comm-btn:hover { border-color: #6b45dd; color: #6b45dd; }',
  '.comm-btn:disabled { opacity: .5; cursor: not-allowed; }',
  '.comm-out {',
  '  font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px;',
  '  background: #16121f; color: #d7d2e6;',
  '  padding: 8px 10px; white-space: pre-wrap; word-break: break-all;',
  '  height: 260px; flex: 0 0 auto; overflow-y: auto; overflow-x: hidden;',
  '  overscroll-behavior: contain; scrollbar-gutter: stable;',
  '}',
  '.comm-out::-webkit-scrollbar { width: 10px; }',
  '.comm-out::-webkit-scrollbar-track { background: transparent; }',
  '.comm-out::-webkit-scrollbar-thumb { background: #3b3450; border-radius: 5px; }',
  '.comm-out::-webkit-scrollbar-thumb:hover { background: #4c4468; }',
  '.comm-line { display: block; }',
  '.comm-line.rx { color: #b6f2c6; }',
  '.comm-line.tx { color: #8fd3ff; }',
  '.comm-line.msg { color: #ffd98a; }',
  '.comm-line.err { color: #ff9c9c; }',
  '.comm-line.info { color: #9aa3b5; }',
  '.comm-foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #d9e0ea; }',
  '.comm-in {',
  '  flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 7px 10px;',
  '  border: 1px solid #d9e0ea; border-radius: 7px;',
  '}',
  '.comm-in:focus { outline: none; border-color: #6b45dd; }',
].join('\n');

export function injectChannelPanelStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  doc.head.appendChild(style);
}

function defaultFormatMessage(message) {
  if (message.kind === 'frame') return '二进制帧 ' + message.payload.length + ' 字节';
  if (message.kind === 'line') return '文本行 ' + message.text;
  if (message.kind === 'crc-error') {
    return 'CRC 校验失败 expected=' + message.expected.toString(16) + ' actual=' + message.actual.toString(16);
  }
  return null;
}

export class ChannelPanel {
  constructor(options) {
    if (!options?.link) throw new Error('ChannelPanel 需要 link');
    if (!options?.transport) throw new Error('ChannelPanel 需要 transport');

    this.link = options.link;
    this.transport = options.transport;
    this.name = options.transport.name;
    this.title = options.title ?? options.transport.name;
    this.subtitle = options.subtitle ?? '';
    this.connectLabel = options.connectLabel ?? '连接';
    this.disconnectLabel = options.disconnectLabel ?? '断开';
    this.placeholder = options.placeholder ?? '输入要发送的内容，回车发送';
    this.sendLabel = options.sendLabel ?? '发送';
    this.emptyText = options.emptyText ?? '暂无数据';
    this.maxLines = options.maxLines ?? 500;
    this.outHeight = options.outHeight ?? 260;
    this.formatMessage = options.formatMessage ?? defaultFormatMessage;
    this.showHex = options.showHex !== false;
    this.mountTarget = options.mount ?? null;
    this.onError = options.onError ?? null;

    this.dom = null;
    this._unbind = [];
    this._empty = null;
  }

  mount(target = this.mountTarget) {
    const doc = (target ?? globalThis.document).ownerDocument ?? globalThis.document;
    injectChannelPanelStyles(doc);

    const root = doc.createElement('div');
    root.className = 'comm-panel';

    const head = doc.createElement('div');
    head.className = 'comm-head';
    this.dot = doc.createElement('span');
    this.dot.className = 'comm-dot';
    this.titleEl = doc.createElement('span');
    this.titleEl.className = 'comm-title';
    this.titleEl.textContent = this.title;
    this.subEl = doc.createElement('span');
    this.subEl.className = 'comm-sub';
    this.subEl.textContent = this.subtitle;
    this.connectBtn = doc.createElement('button');
    this.connectBtn.type = 'button';
    this.connectBtn.className = 'comm-btn';
    this.connectBtn.textContent = this.connectLabel;
    this.clearBtn = doc.createElement('button');
    this.clearBtn.type = 'button';
    this.clearBtn.className = 'comm-btn';
    this.clearBtn.textContent = '清空';
    head.append(
      this.dot,
      this.titleEl,
      this.subEl,
      Object.assign(doc.createElement('span'), { className: 'comm-spacer' }),
      this.connectBtn,
      this.clearBtn,
    );

    this.out = doc.createElement('div');
    this.out.className = 'comm-out';
    this.out.style.height = typeof this.outHeight === 'number' ? this.outHeight + 'px' : this.outHeight;

    const foot = doc.createElement('div');
    foot.className = 'comm-foot';
    this.input = doc.createElement('input');
    this.input.type = 'text';
    this.input.className = 'comm-in';
    this.input.placeholder = this.placeholder;
    this.input.autocomplete = 'off';
    this.sendBtn = doc.createElement('button');
    this.sendBtn.type = 'button';
    this.sendBtn.className = 'comm-btn';
    this.sendBtn.textContent = this.sendLabel;
    foot.append(this.input, this.sendBtn);

    root.append(head, this.out, foot);
    this.dom = root;

    this.connectBtn.addEventListener('click', () => this.toggleConnect());
    this.clearBtn.addEventListener('click', () => this.clear());
    this.sendBtn.addEventListener('click', () => this.send());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.send();
      }
    });

    this._unbind.push(this.link.on('rx', (entry) => {
      if (entry.transport.name !== this.name) return;
      this.log('rx', 'RX  ' + this.hexOf(entry) + this.textOf(entry));
    }));
    this._unbind.push(this.link.on('tx', (entry) => {
      if (entry.transport.name !== this.name) return;
      this.log('tx', 'TX  ' + this.hexOf(entry) + this.textOf(entry));
    }));
    this._unbind.push(this.link.on('message', (message) => {
      if (message.transport.name !== this.name) return;
      const text = this.formatMessage(message);
      if (!text) return;
      const kind = message.kind === 'crc-error' ? 'err' : 'msg';
      this.log(kind, text);
    }));
    this._unbind.push(this.transport.on('state', () => this.refresh()));
    this._unbind.push(this.transport.on('disconnected', () => {
      this.log('err', this.name + ' 掉线，重连后需要重新打开 Notify');
      this.refresh();
    }));

    this.clear();
    this.refresh();

    if (target ?? this.mountTarget) (target ?? this.mountTarget).appendChild(root);
    return root;
  }

  // 贴在底部时才自动跟随；用户往上翻看历史时不要把他拽回最下面
  isAtBottom() {
    if (!this.out) return true;
    return this.out.scrollHeight - this.out.scrollTop - this.out.clientHeight <= 8;
  }

  hexOf(entry) {
    return this.showHex ? entry.hex : '';
  }

  textOf(entry) {
    const text = entry.text ?? '';
    if (!text || !isLosslessText(entry)) return '';
    return this.showHex ? '    ' + JSON.stringify(text) : text;
  }

  log(kind, text) {
    if (!this.out) return;
    if (this._empty) {
      this._empty.remove();
      this._empty = null;
    }
    const stick = this.isAtBottom();
    const doc = this.out.ownerDocument;
    const line = doc.createElement('span');
    line.className = 'comm-line ' + kind;
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
    this.out.appendChild(line);
    while (this.out.childElementCount > this.maxLines) {
      this.out.firstElementChild.remove();
    }
    if (stick) this.out.scrollTop = this.out.scrollHeight;
  }

  clear() {
    if (!this.out) return;
    this.out.textContent = '';
    const doc = this.out.ownerDocument;
    this._empty = doc.createElement('span');
    this._empty.className = 'comm-line info';
    this._empty.textContent = this.emptyText;
    this.out.appendChild(this._empty);
    this.out.scrollTop = 0;
    return this;
  }

  refresh() {
    if (!this.dot) return;
    this.dot.classList.toggle('on', this.transport.isConnected);
    this.connectBtn.textContent = this.transport.isConnected ? this.disconnectLabel : this.connectLabel;
    this.sendBtn.disabled = !this.transport.isConnected;
    this.input.disabled = !this.transport.isConnected;
  }

  async toggleConnect() {
    try {
      if (this.transport.isConnected) await this.transport.disconnect();
      else await this.transport.connect();
    } catch (error) {
      this.log('err', '连接失败 ' + (error.code ?? '') + ' ' + (error.message ?? ''));
      if (this.onError) this.onError(error);
    }
    this.refresh();
  }

  async send() {
    const text = this.input.value;
    if (!text.trim()) return;
    try {
      await this.link.send(text, { targets: [this.name] });
      this.input.value = '';
    } catch (error) {
      this.log('err', '发送失败 ' + (error.code ?? '') + ' ' + (error.message ?? ''));
    }
  }

  destroy() {
    for (const off of this._unbind) off();
    this._unbind = [];
    this.dom?.remove();
    this.dom = null;
  }
}

export function mountChannelPanels(options) {
  const mount = options.mount;
  const panels = options.panels.map((config) => new ChannelPanel({
    link: options.link,
    mount,
    ...config,
  }));
  if (mount) mount.classList.add('comm-grid');
  for (const panel of panels) panel.mount(mount);
  return panels;
}
