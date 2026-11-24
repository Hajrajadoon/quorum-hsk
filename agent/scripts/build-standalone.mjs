// Builds dist/quorum-demo.html: one self-contained file with the dashboard AND the full
// engine running in the browser (simulation). Perfect offline backup for the pitch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.error('esbuild is missing. Run `npm install` first.');
  process.exit(1);
}

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'public', 'standalone-entry.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  write: false,
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const tag = '<script type="module" src="./app.mjs"></script>';
if (!html.includes(tag)) throw new Error('script tag not found in index.html');
const out = html.replace(tag, () => `<script>${js}</script>`);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const file = path.join(ROOT, 'dist', 'quorum-demo.html');
fs.writeFileSync(file, out);
console.log(`wrote ${path.relative(process.cwd(), file)} (${(out.length / 1024).toFixed(0)} KB)`);
// keep the website's demo page in sync
const site = path.join(ROOT, '..', 'docs', 'demo.html');
if (fs.existsSync(path.dirname(site))) {
  fs.writeFileSync(site, out);
  console.log('updated docs/demo.html');
}
