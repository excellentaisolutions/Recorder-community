import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(root, { recursive: true }).filter(name => !name.startsWith('node_modules') && /\.(cjs|js|mjs)$/.test(name));
for (const name of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, name)], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Sintaxis verificada: ${files.length} módulos de aplicación.`);
