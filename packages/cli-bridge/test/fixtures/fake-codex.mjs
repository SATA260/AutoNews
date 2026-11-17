#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const args = process.argv.slice(2);

if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
} else if (args[0] === 'debug' && args[1] === 'models') {
  if (process.env.FAKE_CODEX_MODE === 'bad_catalog') {
    console.log('模型目录不可用');
    process.exit(0);
  }
  console.log(
    JSON.stringify({
      models: [
        { slug: 'fixture-codex', visibility: 'list' },
        { slug: 'hidden', visibility: 'hide' },
      ],
    }),
  );
} else if (args[0] === 'exec' && args.includes('--help')) {
  if (args.includes('--ephemeral') && process.env.FAKE_CODEX_MODE === 'old_version') {
    console.error('unexpected argument --ephemeral');
    process.exit(2);
  }
  console.log('--output-schema --ignore-user-config');
} else {
  assert.equal(args[0], 'exec');
  assert.equal(args[args.indexOf('--model') + 1], 'fixture-codex');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args.at(-1), '-');
  const prompt = fs.readFileSync(0, 'utf8');
  assert.match(prompt, /^验证来自标准输入的提示词$/);
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
  assert.deepEqual(schema.required, ['title', 'note']);
  assert.equal(schema.additionalProperties, false);
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { text: '中间输出' } }));
  if (process.env.FAKE_CODEX_MODE === 'auth') {
    console.log(JSON.stringify({ type: 'error', message: `${'x'.repeat(500)} Please log in` }));
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }));
    process.exitCode = 1;
  } else if (process.env.FAKE_CODEX_MODE === 'auth_no_output') {
    console.error('unexpected status 401 Unauthorized');
  } else if (process.env.FAKE_CODEX_MODE === 'unrelated_401') {
    console.error('read failed at byte 401');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(
      args[args.indexOf('--output-last-message') + 1],
      JSON.stringify({ title: '最终输出', note: null }),
    );
    console.log(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 80, output_tokens: 20 } }),
    );
  }
}
