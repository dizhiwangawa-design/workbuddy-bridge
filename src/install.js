import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_PATH = path.resolve(__dirname, 'server.js');

export const HOME = os.homedir();
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function appData() {
  return process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.wb.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function entry(env = {}) {
  return {
    command: process.execPath, // 用当前 node 的绝对路径，避免客户端 PATH 里找不到
    args: [SERVER_PATH],
    env,
  };
}

/** JSON 型客户端：mcpServers 结构 */
function jsonServersAdapter({ id, label, file, keyPath = ['mcpServers'] }) {
  return {
    id,
    label,
    file,
    detect: () => fs.existsSync(file),
    apply(env) {
      const cfg = readJson(file, {});
      let node = cfg;
      for (const k of keyPath.slice(0, -1)) {
        node[k] = node[k] || {};
        node = node[k];
      }
      const last = keyPath[keyPath.length - 1];
      node[last] = node[last] || {};
      node[last].workbuddy = entry(env);
      writeJson(file, cfg);
      return file;
    },
    remove() {
      if (!fs.existsSync(file)) return null;
      const cfg = readJson(file, {});
      let node = cfg;
      for (const k of keyPath.slice(0, -1)) node = node?.[k];
      const last = keyPath[keyPath.length - 1];
      if (node?.[last]?.workbuddy) {
        delete node[last].workbuddy;
        writeJson(file, cfg);
      }
      return file;
    },
  };
}

/** OpenCode：mcp.{name} = { type:'local', command:[...] } */
const opencodeAdapter = {
  id: 'opencode',
  label: 'OpenCode',
  file: isWin
    ? path.join(process.env.XDG_CONFIG_HOME || appData(), 'opencode', 'opencode.json')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'opencode', 'opencode.json'),
  detect() {
    return fs.existsSync(this.file) || fs.existsSync(path.join(HOME, '.opencode'));
  },
  apply(env) {
    const cfg = readJson(this.file, { $schema: 'https://opencode.ai/config.json' });
    cfg.mcp = cfg.mcp || {};
    cfg.mcp.workbuddy = {
      type: 'local',
      command: [process.execPath, SERVER_PATH],
      enabled: true,
      ...(Object.keys(env).length ? { environment: env } : {}),
    };
    writeJson(this.file, cfg);
    return this.file;
  },
  remove() {
    if (!fs.existsSync(this.file)) return null;
    const cfg = readJson(this.file, {});
    if (cfg.mcp?.workbuddy) {
      delete cfg.mcp.workbuddy;
      writeJson(this.file, cfg);
    }
    return this.file;
  },
};

/** Codex：TOML，[mcp_servers.workbuddy] */
const codexAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  file: path.join(HOME, '.codex', 'config.toml'),
  detect() {
    return fs.existsSync(this.file) || fs.existsSync(path.join(HOME, '.codex'));
  },
  apply(env) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const block = [
      '[mcp_servers.workbuddy]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(SERVER_PATH)}]`,
      ...(Object.keys(env).length
        ? ['', '[mcp_servers.workbuddy.env]', ...Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)]
        : []),
    ].join('\n');

    const prev = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '';
    const cleaned = stripTomlBlock(prev, 'mcp_servers.workbuddy');
    fs.writeFileSync(this.file, `${cleaned.trimEnd()}\n\n${block}\n`);
    return this.file;
  },
  remove() {
    if (!fs.existsSync(this.file)) return null;
    const prev = fs.readFileSync(this.file, 'utf8');
    fs.writeFileSync(this.file, stripTomlBlock(prev, 'mcp_servers.workbuddy'));
    return this.file;
  },
};

function stripTomlBlock(text, table) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (m) {
      const name = m[1].trim();
      skipping = name === table || name.startsWith(table + '.');
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ------------------------------------------------------------------ DeepSeek Harness
 *
 * dsh 的配置不是 JSON，而是 profile 下的一份 YAML patch 层：
 *   ~/.dsh/profiles/<profile>/cordis.patch.yml
 * 顶层是一个数组，每项是 loader patch 条目；插入插件要用 `- insert: [...]`。
 *
 * 另外 dsh 采用「插件即依赖」的模型，@deepseek-ai/dsh-mcp-client 必须装进
 * 该 profile 的 node_modules，且版本要和 dsh 本体对齐 —— npm 上 latest 标签
 * 还停在 0.0.1-rc.1，与 0.2.x 的 dsh 不兼容，dsh 会直接把整行禁用。
 */
const DSH_HOME = process.env.DSH_HOME
  ? path.resolve(process.env.DSH_HOME)
  : path.join(HOME, '.dsh');

const DSH_MARK_START = '# >>> workbuddy-bridge >>>';
const DSH_MARK_END = '# <<< workbuddy-bridge <<<';
const DSH_PLUGIN = '@deepseek-ai/dsh-mcp-client';

function yamlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function dshProfiles() {
  const dir = path.join(DSH_HOME, 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'cordis.patch.yml')))
    .map((d) => d.name);
}

function dshVersion() {
  const r = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 60000, shell: isWin });
  const out = r.status === 0 ? String(r.stdout || '').trim().split('\n').pop().trim() : '';
  if (/^\d+\.\d+\.\d+/.test(out)) return out;
  return dshVersionFromPackage();
}

/** dsh --version 拿不到时（例如 PATH 里的 node 版本太老），直接读包的 package.json。 */
function dshVersionFromPackage() {
  const which = spawnSync(isWin ? 'where' : 'which', ['dsh'], { encoding: 'utf8', timeout: 10000 });
  const bin = String(which.stdout || '')
    .trim()
    .split('\n')[0]
    .trim();
  if (!bin) return null;
  try {
    let dir = path.dirname(fs.realpathSync(bin));
    for (let i = 0; i < 6; i++) {
      const pkgFile = path.join(dir, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg.name === '@deepseek-ai/dsh' && pkg.version) return pkg.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readInstalledPluginVersion(dir) {
  try {
    const pkg = path.join(dir, 'node_modules', DSH_PLUGIN, 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  } catch {
    return null;
  }
}

function installDshPlugin(dir, version) {
  if (version && readInstalledPluginVersion(dir) === version) return true;
  const spec = version ? `${DSH_PLUGIN}@${version}` : DSH_PLUGIN;
  const r = spawnSync('pnpm', ['add', spec], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 240000,
    shell: isWin,
  });
  return r.status === 0 && (!version || readInstalledPluginVersion(dir) === version);
}

function dshBlock(env) {
  const lines = [
    '- insert:',
    '    - id: mcp-workbuddy',
    `      name: '${DSH_PLUGIN}'`,
    '      config:',
    '        serverName: workbuddy',
    '        transport: stdio',
    `        command: ${yamlStr(process.execPath)}`,
    '        args:',
    `          - ${yamlStr(SERVER_PATH)}`,
  ];
  if (Object.keys(env).length) {
    lines.push('        env:');
    for (const [k, v] of Object.entries(env)) lines.push(`          ${k}: ${yamlStr(v)}`);
  }
  return lines.join('\n');
}

function stripDshBlock(text) {
  const start = text.indexOf(DSH_MARK_START);
  const end = text.indexOf(DSH_MARK_END);
  if (start < 0 || end < start) return text;
  return text.slice(0, start) + text.slice(end + DSH_MARK_END.length);
}

function writeDshPatch(file, env) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const stripped = stripDshBlock(existing);

  const meaningful = stripped
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  // 模板文件就长这样：几行注释 + 一个 []
  const onlyPlaceholder = meaningful.every((l) => l === '[]');

  let base;
  if (onlyPlaceholder) {
    base = stripped
      .split('\n')
      .filter((l) => l.trim().startsWith('#'))
      .join('\n');
  } else {
    base = stripped.trimEnd();
  }

  const out = `${base ? base.trimEnd() + '\n\n' : ''}${DSH_MARK_START}\n${dshBlock(env)}\n${DSH_MARK_END}\n`;
  fs.writeFileSync(file, out);
}

const dshAdapter = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  file: path.join(DSH_HOME, 'profiles'),
  detect() {
    return fs.existsSync(DSH_HOME);
  },
  apply(env) {
    const profiles = dshProfiles();
    if (!profiles.length) {
      throw new Error(
        `没找到 dsh profile（${path.join(DSH_HOME, 'profiles')} 为空）。先运行一次 dsh web 初始化，再回来执行 wb install。`,
      );
    }

    const version = dshVersion();
    const written = [];
    const notes = [];

    for (const p of profiles) {
      const dir = path.join(DSH_HOME, 'profiles', p);
      if (process.env.WB_DSH_SKIP_PLUGIN_INSTALL !== '1') {
        if (!installDshPlugin(dir, version)) {
          notes.push(
            `profile "${p}" 的 MCP 插件没装上，手动执行：cd ${dir} && pnpm add ${DSH_PLUGIN}@${version || 'latest'}`,
          );
        }
      }
      const file = path.join(dir, 'cordis.patch.yml');
      writeDshPatch(file, env);
      written.push(file);
    }

    if (!version) {
      notes.push('没能读到 dsh 版本号，插件版本可能对不上；必要时手动指定 @deepseek-ai/dsh-mcp-client@<你的 dsh 版本>');
    }

    return { file: written.join(', '), note: notes.join('\n') };
  },
  remove() {
    const files = [];
    for (const p of dshProfiles()) {
      const file = path.join(DSH_HOME, 'profiles', p, 'cordis.patch.yml');
      const text = fs.readFileSync(file, 'utf8');
      const stripped = stripDshBlock(text).trim();
      const meaningful = stripped
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      fs.writeFileSync(file, meaningful.length ? `${stripped}\n` : `${stripped}\n[]\n`);
      files.push(file);
    }
    return files.join(', ');
  },
};

export const ADAPTERS = [
  jsonServersAdapter({
    id: 'claude',
    label: 'Claude Code',
    file: path.join(HOME, '.claude.json'),
  }),
  dshAdapter,
  codexAdapter,
  jsonServersAdapter({
    id: 'cursor',
    label: 'Cursor',
    file: path.join(HOME, '.cursor', 'mcp.json'),
  }),
  opencodeAdapter,
  jsonServersAdapter({
    id: 'windsurf',
    label: 'Windsurf',
    file: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
  }),
  jsonServersAdapter({
    id: 'gemini',
    label: 'Gemini CLI',
    file: path.join(HOME, '.gemini', 'settings.json'),
  }),
  jsonServersAdapter({
    id: 'cline',
    label: 'Cline (VS Code)',
    file: isMac
      ? path.join(
          HOME,
          'Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
        )
      : isWin
        ? path.join(appData(), 'Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json')
        : path.join(
            HOME,
            '.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
          ),
  }),
];

export function detectClients() {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label, file: a.file, detected: a.detect() }));
}

export function installTo(clients, env = {}) {
  const wanted = clients?.length ? clients : ADAPTERS.filter((a) => a.detect()).map((a) => a.id);
  const results = [];
  for (const a of ADAPTERS) {
    if (!wanted.includes(a.id)) continue;
    try {
      const out = a.apply(env);
      const isObj = out && typeof out === 'object';
      results.push({
        id: a.id,
        label: a.label,
        ok: true,
        file: isObj ? out.file : out,
        note: isObj ? out.note : '',
      });
    } catch (err) {
      results.push({ id: a.id, label: a.label, ok: false, error: err.message });
    }
  }
  return results;
}

export function uninstallFrom(clients) {
  const wanted = clients?.length ? clients : ADAPTERS.map((a) => a.id);
  return ADAPTERS.filter((a) => wanted.includes(a.id)).map((a) => ({
    id: a.id,
    ok: true,
    file: a.remove(),
  }));
}

export function genericSnippet(env = {}) {
  return JSON.stringify(
    {
      mcpServers: {
        workbuddy: entry(env),
      },
    },
    null,
    2,
  );
}
