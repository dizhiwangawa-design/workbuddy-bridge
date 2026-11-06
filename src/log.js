import fs from 'node:fs';
import { LOGIN_LOG, LOG_DIR, ensureDir } from './paths.js';

/**
 * MCP 的 stdio 传输把 stdout 当成协议通道，
 * 任何 console.log 都会让客户端解析失败。
 * 所以桥接内部所有日志一律走 stderr / 日志文件。
 */
const DEBUG = /^(1|true|yes)$/i.test(process.env.WB_DEBUG || '');

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

export function debug(...args) {
  if (!DEBUG) return;
  process.stderr.write(`[wb ${stamp()}] ${args.join(' ')}\n`);
}

export function info(...args) {
  process.stderr.write(`[workbuddy-bridge] ${args.join(' ')}\n`);
}

export function warn(...args) {
  process.stderr.write(`[workbuddy-bridge] WARN ${args.join(' ')}\n`);
}

export function error(...args) {
  process.stderr.write(`[workbuddy-bridge] ERROR ${args.join(' ')}\n`);
}

/** 登录过程单独落一份日志，出问题可以直接把文件发给别人看。 */
export function loginLog(line) {
  try {
    ensureDir(LOG_DIR);
    fs.appendFileSync(LOGIN_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志失败不能影响主流程 */
  }
}
