import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 所有落盘位置集中在这里。
 * 桥接自己的状态（账号、配置）与 WorkBuddy 自己的配置目录严格分开，
 * 这样升级/卸载 WorkBuddy 不会连带弄丢桥接数据。
 */
export const HOME = os.homedir();

export const BRIDGE_HOME = process.env.WB_BRIDGE_HOME
  ? path.resolve(process.env.WB_BRIDGE_HOME)
  : path.join(HOME, '.workbuddy-bridge');

export const BRIDGE_CONFIG = path.join(BRIDGE_HOME, 'config.json');
export const ACCOUNTS_FILE = path.join(BRIDGE_HOME, 'accounts.json');
export const POOL_FILE = path.join(BRIDGE_HOME, 'pool.json');
export const PROFILES_DIR = path.join(BRIDGE_HOME, 'profiles');
export const LOG_DIR = path.join(BRIDGE_HOME, 'logs');
export const LOGIN_LOG = path.join(LOG_DIR, 'login.log');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ensureBridgeDirs() {
  ensureDir(BRIDGE_HOME);
  ensureDir(PROFILES_DIR);
  ensureDir(LOG_DIR);
}

/** 每个账号一个独立的 CODEBUDDY_CONFIG_DIR，天然隔离凭证。 */
export function profileDir(name) {
  return path.join(PROFILES_DIR, sanitizeName(name));
}

export function sanitizeName(name) {
  return String(name || 'default')
    .trim()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'default';
}

export function defaultConfig() {
  return {
    version: 1,
    // 默认账号名；任务未指定 account 时使用
    defaultAccount: 'default',
    // 传给 codebuddy 的默认参数
    defaults: {
      model: '',
      fallbackModel: '',
      timeoutMs: 900000,
      skipPermissions: true,
      cwd: '',
    },
    // 桥接自己启动的登录页端口（0 = 随机空闲端口）
    loginPagePort: 7666,
    apiCompat: {
      version: 1,
      enabled: true,
      openai: false,
      anthropic: true,
      anthropicEnabled: true,
      streaming: true,
      tools: true,
      responsesPersistence: true,
      responsesNudge: false,
      channelSanitize: true,
      requireApiKey: false,
      remoteRequireKey: true,
      trustProxy: false,
      dsmlMaxBufferBytes: 2 * 1024 * 1024,
      firstByteTimeoutMs: 60000,
      idleTimeoutMs: 120000,
      finishGraceMs: 2000,
      totalTimeoutMs: 600000,
      upstreamBaseUrl: 'https://copilot.tencent.com',
      defaultModel: 'deepseek-v4.1-flash',
      timeoutMs: 900000,
      keys: [],
    },
    // 是否允许任务写入账号目录之外的路径，仅用于 doctor 提示
    createdAt: new Date().toISOString(),
  };
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* 某些文件系统不支持，忽略 */
  }
}

export function loadConfig() {
  const base = defaultConfig();
  const saved = readJson(BRIDGE_CONFIG, null);
  if (!saved) return base;
  const savedApi = saved.apiCompat || {};
  const apiCompat = {
    ...base.apiCompat,
    ...savedApi,
    keys: Array.isArray(savedApi.keys) ? savedApi.keys : base.apiCompat.keys,
  };
  if (Object.hasOwn(savedApi, 'anthropic') && !Object.hasOwn(savedApi, 'anthropicEnabled')) {
    apiCompat.anthropicEnabled = savedApi.anthropic;
  }
  // The old built-in default is known to be unavailable. Migrate only that
  // exact value; a user-selected model must never be overwritten.
  if (apiCompat.defaultModel === 'deepseek-v4-flash') {
    apiCompat.defaultModel = 'deepseek-v4.1-flash';
  }
  return {
    ...base,
    ...saved,
    defaults: { ...base.defaults, ...(saved.defaults || {}) },
    apiCompat,
  };
}

export function saveConfig(cfg) {
  ensureBridgeDirs();
  writeJson(BRIDGE_CONFIG, cfg);
  return cfg;
}
