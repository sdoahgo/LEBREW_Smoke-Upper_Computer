// frontend_checks.test.mjs — 前端文件检查（本项目版）
// 1) 各 .js 模块语法正确 2) app.html 引用的脚本存在 3) app.js 的相对 import 都能解析
// 运行：node tests/frontend_checks.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
  } catch (error) {
    failures.push(name);
    console.log('  FAIL  ' + name + '\n        ' + (error?.message || String(error)));
  }
}

function assertParses(source, label) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-check-'));
  const file = join(dir, 'check.mjs');
  writeFileSync(file, source, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(label + ': ' + String(error.stderr || error.message).trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const moduleDir = fileURLToPath(new URL('../', import.meta.url));
const rootFiles = readdirSync(moduleDir).filter((name) => name.endsWith('.js'));

check('模块文件齐全', () => {
  for (const required of ['comm_link.js', 'comm_panel.js', 'comm_mock.js', 'smoke_protocol.js', 'smoke_ble.js', 'smoke_sim.js', 'app.js']) {
    assert.ok(rootFiles.includes(required), '缺少 ' + required);
  }
});

check('全部 .js 模块语法正确', () => {
  for (const name of rootFiles) {
    assertParses(readFileSync(join(moduleDir, name), 'utf8'), name);
  }
  console.log('        模块: ' + rootFiles.join(', '));
});

const html = readFileSync(join(moduleDir, 'app.html'), 'utf8');

check('app.html 引用的外部资源都存在', () => {
  const missing = [];
  for (const match of html.matchAll(/(?:src|href)="(?!https?:)[^"]+"/g)) {
    const target = match[0].slice(match[0].indexOf('"') + 1, -1).split('?')[0]; // 忽略版本查询串
    if (!existsSync(join(moduleDir, target))) missing.push(target);
  }
  assert.deepEqual(missing, [], 'app.html 引用了不存在的文件: ' + missing.join(', '));
});

check('app.js 的相对 import 都能解析到文件', () => {
  const source = readFileSync(join(moduleDir, 'app.js'), 'utf8');
  const missing = [];
  for (const match of source.matchAll(/from\s+'(\.\/[^']+)'/g)) {
    const file = match[1].split('?')[0]; // 忽略版本查询串
    if (!existsSync(join(moduleDir, file))) missing.push(match[1]);
  }
  assert.deepEqual(missing, [], 'app.js 引用了不存在的模块: ' + missing.join(', '));
});

check('style.css 存在且含主样式', () => {
  const css = readFileSync(join(moduleDir, 'style.css'), 'utf8');
  assert.ok(css.includes('.statebadge') && css.includes('.topbar'));
});

console.log('\n========================================');
console.log('前端检查 ' + 5 + '，通过 ' + (5 - failures.length) + '，失败 ' + failures.length);
if (failures.length > 0) process.exitCode = 1;
else console.log('全部通过');
