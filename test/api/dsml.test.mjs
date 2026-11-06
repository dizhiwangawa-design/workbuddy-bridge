import test from 'node:test';
import assert from 'node:assert/strict';
import { createDsmlScanner } from '../../src/tool-calls.js';

const BAR = '\u{FF5C}\u{FF5C}';

function callBlock(invokes) {
  return [
    `<${BAR}DSML${BAR} calls>`,
    ...invokes,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
}

function invoke(name, params = []) {
  return [
    `<${BAR}DSML${BAR} invoke name="${name}">`,
    ...params.map(({ name: key, string = true, body }) => (
      `<${BAR}DSML${BAR} parameter name="${key}" string="${string}">${body}</${BAR}DSML${BAR} parameter>`
    )),
    `</${BAR}DSML${BAR} invoke>`,
  ].join('\n');
}

function scanParts(parts, options) {
  const scanner = createDsmlScanner(options);
  const calls = [];
  let visible = '';
  let error = null;
  for (const part of parts) {
    const result = scanner.push(part);
    visible += result.visibleText;
    calls.push(...result.calls);
    error ||= result.error;
    if (result.error) return { visible, calls, error, finish: null };
  }
  const finish = scanner.finish();
  visible += finish.visibleText;
  calls.push(...finish.calls);
  error ||= finish.error;
  return { visible, calls, error, finish };
}

test('扫描单个字符串参数并从正文中剥离 DSML', () => {
  const raw = `before\n${callBlock([
    invoke('get_weather', [
      { name: 'city', body: '北京' },
    ]),
  ])}\nafter`;
  const got = scanParts([raw]);

  assert.equal(got.error, null);
  assert.equal(got.visible, 'before\n\nafter');
  assert.deepEqual(got.calls, [{
    name: 'get_weather',
    input: { city: '北京' },
  }]);
});

test('string=false 参数保留 JSON 类型，空 invoke 生成空对象', () => {
  const raw = callBlock([
    invoke('search', [
      { name: 'limit', string: false, body: '5' },
      { name: 'filters', string: false, body: '{"open":true}' },
    ]),
    invoke('ping'),
  ]);
  const got = scanParts([raw]);

  assert.equal(got.error, null);
  assert.deepEqual(got.calls.map((call) => call.input), [
    { limit: 5, filters: { open: true } },
    {},
  ]);
});

test('完整 invoke 早于外层 calls 关闭即可返回', () => {
  const scanner = createDsmlScanner();
  const got = scanner.push(
    `<${BAR}DSML${BAR} calls>\n${invoke('read_file', [
      { name: 'path', body: '/etc/hostname' },
    ])}`,
  );

  assert.equal(got.error, null);
  assert.deepEqual(got.calls, [{
    name: 'read_file',
    input: { path: '/etc/hostname' },
  }]);
});

test('任意字符边界切分不改变可见文本和工具参数', () => {
  const raw = `甲😀\n${callBlock([
    invoke('write_file', [
      { name: 'text', body: 'quote=" backslash=\\ newline=\n 世界<tag>' },
    ]),
  ])}\n乙`;

  for (let i = 0; i <= raw.length; i += 1) {
    const got = scanParts([raw.slice(0, i), raw.slice(i)]);
    assert.equal(got.error, null, `cut=${i}`);
    assert.equal(got.visible, '甲😀\n\n乙', `cut=${i}`);
    assert.deepEqual(got.calls, [{
      name: 'write_file',
      input: { text: 'quote=" backslash=\\ newline=\n 世界<tag>' },
    }], `cut=${i}`);
  }
});

test('未闭合缓冲超过上限后失败关闭并释放待处理内容', () => {
  const limit = 160;
  const scanner = createDsmlScanner({ maxBufferBytes: limit });
  const prefix = `<${BAR}DSML${BAR} calls>\n<${BAR}DSML${BAR} invoke name="large">`;
  const first = scanner.push(prefix);
  assert.equal(first.error, null);

  let result = null;
  for (let i = 0; i < 20 && !result?.error; i += 1) {
    result = scanner.push('x'.repeat(20));
  }
  assert.equal(result.error.code, 'DSML_BUFFER_LIMIT');
  assert.equal(result.visibleText, '');

  const after = scanner.push('must not be retained');
  assert.equal(after.visibleText, '');
  assert.equal(after.error.code, 'DSML_BUFFER_LIMIT');
});

test('大块普通文本不占用 DSML 缓冲上限', () => {
  const scanner = createDsmlScanner({ maxBufferBytes: 128 });
  const text = '普通文本'.repeat(200);
  const result = scanner.push(text);

  assert.equal(result.error, null);
  assert.equal(result.visibleText, text);
  assert.equal(scanner.finish().error, null);
});

test('同一次 push 内的畸形 DSML 会立即返回错误', () => {
  const scanner = createDsmlScanner();
  const result = scanner.push(`<${BAR}DSML${BAR} calls>unexpected</${BAR}DSML${BAR} calls>`);

  assert.equal(result.error.code, 'DSML_INVALID_INVOKE');
  assert.equal(result.visibleText, '');
});

test('string=false 的畸形 JSON 和缺失工具名都按协议错误处理', () => {
  const badJson = scanParts([
    callBlock([
      invoke('search', [{ name: 'limit', string: false, body: '{not-json' }]),
    ]),
  ]);
  assert.equal(badJson.error.code, 'DSML_INVALID_JSON');
  assert.equal(badJson.visible, '');
  assert.equal(String(badJson.error.message).includes('<'), false);

  const missingName = scanParts([
    callBlock([
      `<${BAR}DSML${BAR} invoke>\n</${BAR}DSML${BAR} invoke>`,
    ]),
  ]);
  assert.equal(missingName.error.code, 'DSML_INVALID_INVOKE');
});

test('已识别 envelope 在流结束时仍未闭合则报截断错误', () => {
  const got = scanParts([
    `<${BAR}DSML${BAR} calls>\n${invoke('read_file', [
      { name: 'path', body: '/tmp/a' },
    ])}`,
  ]);
  assert.equal(got.calls.length, 1);
  assert.equal(got.error.code, 'DSML_TRUNCATED');
});

test('普通尖括号和未识别标签按可见文本保留', () => {
  const got = scanParts(['a < b, c > d; <|tool_call|> is not DSML']);
  assert.equal(got.error, null);
  assert.equal(got.visible, 'a < b, c > d; <|tool_call|> is not DSML');
  assert.deepEqual(got.calls, []);
});

test('未闭合缓冲恰好等于字节上限可完成，超过 1 字节立即失败', () => {
  const BAR = '\u{FF5C}\u{FF5C}';
  const callsOpen = `<${BAR}DSML${BAR} calls>`;
  const prefix = `${callsOpen}\n<${BAR}DSML${BAR} invoke name="write_file">\n` +
    `<${BAR}DSML${BAR} parameter name="text" string="true">`;
  const suffix = `</${BAR}DSML${BAR} parameter>\n</${BAR}DSML${BAR} invoke>\n` +
    `</${BAR}DSML${BAR} calls>`;
  const baseBytes = Buffer.byteLength(prefix.slice(callsOpen.length) + suffix, 'utf8');
  const payload = 'x'.repeat(baseBytes <= 200 ? 200 - baseBytes : 1);
  const exact = prefix + payload + suffix;
  const exactLimit = Buffer.byteLength(exact.slice(callsOpen.length), 'utf8');

  const exactScanner = createDsmlScanner({ maxBufferBytes: exactLimit });
  const exactResult = exactScanner.push(exact);
  assert.equal(exactResult.error, null);
  assert.deepEqual(exactResult.calls, [{ name: 'write_file', input: { text: payload } }]);
  assert.equal(exactScanner.finish().error, null);

  const overflow = prefix + payload + 'x' + suffix;
  const overflowScanner = createDsmlScanner({ maxBufferBytes: exactLimit });
  const overflowResult = overflowScanner.push(overflow);
  assert.equal(overflowResult.error.code, 'DSML_BUFFER_LIMIT');
  assert.equal(overflowResult.visibleText, '');
});

test('按原始 UTF-8 字节任意切分仍保持 Unicode、可见文本和参数一致', () => {
  const raw = `前😀\n${callBlock([
    invoke('write_file', [
      { name: 'text', body: '引号"\n反斜杠\\🙂' },
    ]),
  ])}\n后`;
  const bytes = Buffer.from(raw, 'utf8');
  const expectedVisible = '前😀\n\n后';
  const expectedCall = {
    name: 'write_file',
    input: { text: '引号"\n反斜杠\\🙂' },
  };

  for (let cut = 0; cut <= bytes.length; cut += 1) {
    const decoder = new TextDecoder('utf-8');
    const first = decoder.decode(bytes.subarray(0, cut), { stream: true });
    const second = decoder.decode(bytes.subarray(cut), { stream: true }) + decoder.decode();
    const got = scanParts([first, second]);
    assert.equal(got.error, null, `byte-cut=${cut}`);
    assert.equal(got.visible, expectedVisible, `byte-cut=${cut}`);
    assert.deepEqual(got.calls, [expectedCall], `byte-cut=${cut}`);
  }
});
