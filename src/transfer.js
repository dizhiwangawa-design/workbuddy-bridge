import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureAccount, getAccount, resolveAccountName } from './accounts.js';
import { ensureBridgeDirs, profileDir } from './paths.js';

const execFileP = promisify(execFile);

/**
 * 凭证搬运。
 *
 * 真实世界里最常见的场景是：本机有浏览器，服务器没有。
 * 与其在无头服务器上折腾扫码回调，不如把本机已登录的配置目录整包搬过去。
 * 包里有 token，属于敏感文件 —— 导出时会提醒，文件权限也收紧到 0600。
 */

export async function exportAccount(name, outFile) {
  ensureBridgeDirs();
  const key = resolveAccountName(name);
  const acc = getAccount(key) || ensureAccount(key);
  const src = acc.profileDir;

  if (!fs.existsSync(src) || fs.readdirSync(src).length === 0) {
    throw new Error(`账号 "${key}" 还没有登录过（目录为空），先执行 wb login`);
  }

  const target = path.resolve(outFile || `workbuddy-${key}.tgz`);
  await execFileP('tar', ['-czf', target, '-C', src, '.']);
  fs.chmodSync(target, 0o600);
  return { file: target, account: key, bytes: fs.statSync(target).size };
}

export async function importAccount(file, name) {
  const src = path.resolve(file);
  if (!fs.existsSync(src)) throw new Error(`文件不存在：${src}`);

  const key = resolveAccountName(name);
  const dest = profileDir(key);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });

  // 先解到临时目录并检查，拒绝路径穿越
  const tmp = path.join(dest, '.import-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });

  try {
    await execFileP('tar', ['-xzf', src, '-C', tmp]);
    for (const entry of fs.readdirSync(tmp)) {
      if (entry.includes('..')) throw new Error('压缩包内容异常，已中止');
    }
    for (const entry of fs.readdirSync(tmp)) {
      fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
      fs.renameSync(path.join(tmp, entry), path.join(dest, entry));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  ensureAccount(key, { importedAt: new Date().toISOString(), status: 'active' });
  return { account: key, dir: dest };
}
