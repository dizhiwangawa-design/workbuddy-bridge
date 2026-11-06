import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNTS_FILE,
  PROFILES_DIR,
  ensureBridgeDirs,
  loadConfig,
  profileDir,
  readJson,
  sanitizeName,
  writeJson,
} from './paths.js';

/**
 * 一个「账号」= 独立的 CODEBUDDY_CONFIG_DIR + HOME。
 * CodeBuddy 的认证文件固定在 HOME 下，只隔离配置目录仍会串号；
 * 两者一起隔离后，扫码结果互不覆盖，也不会污染用户的默认目录。
 */

function emptyStore() {
  return { version: 1, default: 'default', accounts: {} };
}

export function loadAccounts() {
  const store = readJson(ACCOUNTS_FILE, null);
  if (!store || typeof store !== 'object' || !store.accounts) return emptyStore();
  return { ...emptyStore(), ...store };
}

export function saveAccounts(store) {
  ensureBridgeDirs();
  writeJson(ACCOUNTS_FILE, store);
  return store;
}

export function listAccounts() {
  const store = loadAccounts();
  return Object.values(store.accounts);
}

export function resolveAccountName(name) {
  if (name) return sanitizeName(name);
  const store = loadAccounts();
  const cfg = loadConfig();
  return store.default || cfg.defaultAccount || 'default';
}

export function getAccount(name) {
  const key = resolveAccountName(name);
  const store = loadAccounts();
  return store.accounts[key] || null;
}

export function ensureAccount(name, patch = {}) {
  ensureBridgeDirs();
  const key = resolveAccountName(name);
  const store = loadAccounts();
  const dir = profileDir(key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true, mode: 0o700 });

  const prev = store.accounts[key] || {
    name: key,
    createdAt: new Date().toISOString(),
  };

  const next = {
    ...prev,
    ...patch,
    name: key,
    profileDir: dir,
    updatedAt: new Date().toISOString(),
  };
  store.accounts[key] = next;
  if (!store.default) store.default = key;
  saveAccounts(store);
  migrateLegacyDefaultAuth(key, dir);
  return next;
}

export function setDefaultAccount(name) {
  const key = resolveAccountName(name);
  const store = loadAccounts();
  if (!store.accounts[key]) {
    throw new Error(`账号 "${key}" 不存在，请先执行 wb login --account ${key}`);
  }
  store.default = key;
  saveAccounts(store);
  return key;
}

export function removeAccount(name) {
  const key = resolveAccountName(name);
  const store = loadAccounts();
  if (!store.accounts[key]) return false;
  delete store.accounts[key];
  if (store.default === key) {
    store.default = Object.keys(store.accounts)[0] || 'default';
  }
  saveAccounts(store);
  try {
    fs.rmSync(profileDir(key), { recursive: true, force: true });
  } catch {
    /* 目录被占用时忽略 */
  }
  return true;
}

function extensionDataRoot(home) {
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension');
    case 'win32':
      return path.join(home, 'AppData', 'Local', 'CodeBuddyExtension');
    default:
      return path.join(home, '.local', 'share', 'CodeBuddyExtension');
  }
}

export function accountHome(name) {
  const key = resolveAccountName(name);
  const acc = getAccount(key);
  const profile = acc?.profileDir || profileDir(key);
  const home = path.join(profile, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** codebuddy 的登录文件固定放在 HOME 下的 CodeBuddyExtension，不跟随配置目录。 */
export function accountAuthDir(name) {
  return path.join(extensionDataRoot(accountHome(name)), 'Data', 'Public', 'auth');
}

/**
 * v0.2 之前只隔离 CODEBUDDY_CONFIG_DIR，但 CLI 把登录文件写在共享 HOME。
 * 升级时把现有凭迁移给 default 账号一次；新账号必须自己扫码，不能复用。
 */
function migrateLegacyDefaultAuth(name, profile) {
  if (name !== 'default') return;
  const home = path.join(profile, 'home');
  const target = path.join(extensionDataRoot(home), 'Data', 'Public', 'auth');
  if (fs.existsSync(target) && fs.readdirSync(target).some((f) => f.endsWith('.info'))) return;

  const legacy = path.join(extensionDataRoot(os.homedir()), 'Data', 'Public', 'auth');
  if (!fs.existsSync(legacy)) return;
  const infos = fs.readdirSync(legacy).filter((f) => f.endsWith('.info'));
  if (!infos.length) return;

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of infos) {
    const destination = path.join(target, file);
    fs.copyFileSync(path.join(legacy, file), destination);
    fs.chmodSync(destination, 0o600);
  }
}

/** 注入给 codebuddy 子进程的环境变量。 */
export function accountEnv(name, baseEnv = process.env) {
  const key = resolveAccountName(name);
  const acc = getAccount(key);
  const dir = acc?.profileDir || profileDir(key);
  migrateLegacyDefaultAuth(key, dir);
  const home = accountHome(key);
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    CODEBUDDY_CONFIG_DIR: dir,
  };
}
