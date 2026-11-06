import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * codebuddy 的登录界面是 Ink 画的 TUI，没有 TTY 就不会渲染。
 * 所以桥接必须给它一个伪终端。
 *
 * 优先用 node-pty（可选依赖，体验最好）；
 * 没装的话在 Linux/macOS 上用系统自带的 `script` 命令兜底。
 */

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

let nodePty = null;
let nodePtyTried = false;

async function loadNodePty() {
  if (nodePtyTried) return nodePty;
  nodePtyTried = true;
  try {
    const mod = await import('node-pty');
    nodePty = mod.default?.spawn ? mod.default : mod;
  } catch {
    nodePty = null;
  }
  return nodePty;
}

/**
 * @returns {Promise<{child: import('node:child_process').ChildProcess, write: Function, kill: Function, resize: Function, mode: string}|null>}
 */
export async function spawnPty(command, args = [], opts = {}) {
  const {
    cols = 120,
    rows = 40,
    env = process.env,
    cwd = process.cwd(),
  } = opts;

  const fullEnv = {
    ...env,
    TERM: 'xterm-256color',
    COLUMNS: String(cols),
    LINES: String(rows),
    FORCE_COLOR: '1',
    CI: '',
  };

  const pty = await loadNodePty();
  if (pty?.spawn) {
    const child = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: fullEnv,
    });
    return {
      child,
      mode: 'node-pty',
      write: (data) => child.write(data),
      resize: (c, r) => child.resize(c, r),
      kill: () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      },
    };
  }

  if (process.platform === 'win32') {
    // Windows 没有 script 等价物，且 node-pty 未安装
    return null;
  }

  const cmdline = [command, ...args].map(shQuote).join(' ');
  // macOS: script -q <file> <command...>；Linux(util-linux): script -qec <command> <file>
  const isMac = process.platform === 'darwin';
  const argv = isMac
    ? ['-q', '/dev/null', 'sh', '-c', cmdline]
    : ['-qec', cmdline, '/dev/null'];

  const child = spawn('script', argv, {
    cwd,
    env: fullEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    child,
    mode: 'script',
    write: (data) => {
      try {
        child.stdin.write(data);
      } catch {
        /* ignore */
      }
    },
    resize: () => {},
    kill: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 1500).unref?.();
    },
  };
}
