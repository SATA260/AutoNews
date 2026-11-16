#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--help')) {
  process.stdout.write('Usage of agy:\n  --model\n  -p\n');
  process.exit(0);
}

if (args[0] === 'models') {
  process.stdout.write(
    '\r\x1b[2K⠋ Fetching available models...\r\x1b[2K⠙ Fetching available models...\r\n' +
      'gemini-4-carbon-high      Gemini 4 Carbon (High)\n' +
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n' +
      'gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\n',
  );
  process.exit(0);
}

const pIdx = args.indexOf('-p');
const prompt = pIdx !== -1 ? (args[pIdx + 1] ?? '') : '';
const mode = process.env.FAKE_AGY_MODE ?? 'ok';

if (mode === 'auth_error') {
  process.stderr.write('Error: user is not logged in. Please login first.\n');
  process.exit(1);
}

if (mode === 'exit_error') {
  process.stdout.write(
    JSON.stringify({
      conversation_id: 'conv-err-1',
      status: 'ERROR',
      error: 'Upstream model capacity exceeded',
    }),
  );
  process.exit(1);
}

if (mode === 'timeout') {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ status: 'SUCCESS', structured_output: {} }));
    process.exit(0);
  }, 15_000);
} else {
  const isRetryWithHint = prompt.includes('[上次输出格式校验失败');

  if (mode === 'bad_json_once' && !isRetryWithHint) {
    process.stdout.write('NOT A VALID JSON');
    process.exit(0);
  }

  if (mode === 'bad_schema_once' && !isRetryWithHint) {
    process.stdout.write(
      JSON.stringify({
        conversation_id: 'conv-bad-schema',
        status: 'SUCCESS',
        response: 'bad schema',
        structured_output: { wrongKey: 123 },
        usage: { input_tokens: 15000, output_tokens: 20 },
      }),
    );
    process.exit(0);
  }

  const customJson = process.env.FAKE_AGY_RESPONSE_JSON;
  const structuredOutput = customJson
    ? JSON.parse(customJson)
    : { summary: '测试摘要输出', ok: true };

  if (process.env.FAKE_AGY_ECHO_PROMPT_IN_SUMMARY === '1') {
    structuredOutput.seenRetryHint = isRetryWithHint;
  }

  process.stdout.write(
    JSON.stringify({
      conversation_id: 'conv-ok-123',
      status: 'SUCCESS',
      response: JSON.stringify(structuredOutput),
      structured_output: structuredOutput,
      usage: {
        input_tokens: 15322,
        output_tokens: 61,
      },
    }),
  );
  process.exit(0);
}
