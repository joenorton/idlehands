import { readdirSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src', 'ui');
const dstDir = join(rootDir, 'dist', 'ui');

if (!existsSync(dstDir)) {
  mkdirSync(dstDir, { recursive: true });
}

const files = readdirSync(srcDir);
for (const file of files) {
  if (file.endsWith('.html')) {
    copyFileSync(join(srcDir, file), join(dstDir, file));
    console.log(`Copied ${file} to dist/ui/`);
  }
}
