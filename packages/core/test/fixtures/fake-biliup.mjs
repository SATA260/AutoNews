#!/usr/bin/env node
import fs from 'node:fs';

const stateFile = process.env.FAKE_BILIUP_STATE_FILE;
const argv = process.argv.slice(2);

let state = { mode: 'ok', bvid: 'BV1XY4y1a7bC', calls: [] };
if (stateFile && fs.existsSync(stateFile)) {
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    // 忽略损坏的测试状态文件
  }
}

state.calls = Array.isArray(state.calls) ? state.calls : [];
state.calls.push(argv);
if (stateFile) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

const callNumber = state.calls.length;

if (state.mode === 'fail') {
  console.error('上传失败：Cookie 认证过期，请重新执行 biliup login');
  process.exit(1);
}

if (state.mode === 'fail_once_then_ok' && callNumber === 1) {
  console.error('网络波动：上传接口返回临时错误 503');
  process.exit(1);
}

if (state.mode === 'missing_bvid') {
  console.log('upload finished without id');
  process.exit(0);
}

console.log(`投稿提交成功，视频稿件号: ${state.bvid ?? 'BV1XY4y1a7bC'}`);
process.exit(0);
