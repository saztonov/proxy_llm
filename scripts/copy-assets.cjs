// Копирует не-TypeScript ассеты (eta-шаблоны и т.п.) из src/ в dist/
// после tsc-сборки. Cross-platform (Windows/Linux/macOS) — использует Node fs.cpSync.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const assets = [
  { from: 'src/views', to: 'dist/views' },
];

for (const { from, to } of assets) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  if (!fs.existsSync(src)) {
    console.error(`skip: ${from} does not exist`);
    continue;
  }
  fs.cpSync(src, dst, { recursive: true });
  console.log(`copied: ${from} → ${to}`);
}
