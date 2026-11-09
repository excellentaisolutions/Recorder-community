const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const archive = path.resolve(root, '../dist/Recorder-win32-x64/resources/app.asar');
const files = fs.readdirSync(root).filter(name => /\.(cjs|js|html|css)$/.test(name));
function add(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) add(name); else files.push(name);
  }
}
for (const directory of ['agents', 'agent-skill', 'examples', 'assets']) add(directory);
for (const file of files) assert(fs.readFileSync(path.join(root, file)).equals(asar.extractFile(archive, path.normalize(file))), `Packaged file differs: ${file}`);
const report = { status: 'passed', files: files.length, identical: true, checkedAt: new Date().toISOString() };
fs.writeFileSync(path.join(__dirname, 'artifacts/package-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
