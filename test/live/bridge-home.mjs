import fs from 'node:fs';
import path from 'node:path';

// 受限文件系统可能禁用 copy_file_range（copyFileSync / cpSync 直接 EPERM）。
// 这类环境里退回 readFile / writeFile，行为一致，只是慢一点。
const RETRYABLE = ['EPERM', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP'];

export function copyFile(source, target) {
  try {
    fs.copyFileSync(source, target);
  } catch (error) {
    if (!RETRYABLE.includes(error?.code)) throw error;
    fs.writeFileSync(target, fs.readFileSync(source));
  }
}

export function copyTree(source, target) {
  try {
    fs.cpSync(source, target, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  } catch (error) {
    if (!RETRYABLE.includes(error?.code)) throw error;
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else if (entry.isDirectory()) copyTree(from, to);
      else copyFile(from, to);
    }
  }
}

/**
 * 把真实 bridge 状态复制成一份可随意改动的副本，并把 accounts.json 里的
 * profileDir 重定向到副本内部。live 测试只碰副本，真实账号状态不受影响。
 */
export function stageBridgeHome({ sourceBridgeHome, bridgeHome }) {
  fs.mkdirSync(path.join(bridgeHome, 'profiles'), { recursive: true, mode: 0o700 });
  for (const file of ['config.json', 'pool.json', 'accounts.json']) {
    const source = path.join(sourceBridgeHome, file);
    if (!fs.existsSync(source)) continue;
    const target = path.join(bridgeHome, file);
    copyFile(source, target);
    fs.chmodSync(target, 0o600);
  }
  const sourceProfiles = path.join(sourceBridgeHome, 'profiles');
  if (!fs.existsSync(sourceProfiles)) {
    throw new Error('bridge profiles directory is missing');
  }
  copyTree(sourceProfiles, path.join(bridgeHome, 'profiles'));

  const accountsFile = path.join(bridgeHome, 'accounts.json');
  if (!fs.existsSync(accountsFile)) {
    throw new Error('bridge accounts.json is missing');
  }
  const store = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  for (const [name, record] of Object.entries(store.accounts || {})) {
    const relative = path.relative(sourceProfiles, String(record.profileDir || ''));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`account profile path is outside the bridge home: ${name}`);
    }
    record.profileDir = path.join(bridgeHome, 'profiles', relative);
  }
  fs.writeFileSync(accountsFile, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** 清理是尽力而为：受管环境可能对单轮大批量删除设了守卫。 */
export function removeTreeQuietly(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[wb-live] 临时目录未清理：${directory}（${error?.code || error?.message}）`,
    );
  }
}

/** 收集上游请求观测，用于区分「模型早停」与「桥接丢请求」。 */
export function createObservedUpstreamClient(createUpstreamClient, observations) {
  const client = createUpstreamClient();
  return {
    ...client,
    async chat(args) {
      const body = args.body || {};
      const observation = {
        model: args.model,
        stream: body.stream,
        messages: Array.isArray(body.messages)
          ? body.messages.map((message) => ({
              role: message?.role || null,
              content_length: typeof message?.content === 'string'
                ? message.content.length
                : JSON.stringify(message?.content || '').length,
              tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
            }))
          : [],
        tools: Array.isArray(body.tools)
          ? body.tools.map((tool) => tool?.function?.name || tool?.name || null)
          : [],
        reasoning_effort: body.reasoning_effort ?? null,
      };
      try {
        const response = await client.chat(args);
        observation.status = response.status;
        if (!response.ok) {
          observation.detail = (await response.clone().text()).slice(0, 500);
        }
        observations.push(observation);
        return response;
      } catch (error) {
        observation.error = String(error?.message || error).slice(0, 500);
        observations.push(observation);
        throw error;
      }
    },
  };
}
