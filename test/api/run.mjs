import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(here, file)], {
    stdio: 'inherit',
    env: { ...process.env, WB_DEBUG: '' },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
