// Assembles the static site into dist/: the app sources plus the two runtime
// libraries, copied straight from node_modules. No bundler, no transpiling.
// Splats and LUTs are not part of the site; nginx serves them from /splats
// and /luts (see nginx.conf).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const lib = join(dist, 'lib');

rmSync(dist, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });

cpSync(join(root, 'src'), dist, { recursive: true });

const copies = [
    ['node_modules/playcanvas/build/playcanvas.min.mjs', 'playcanvas.mjs'],
    ['node_modules/lil-gui/dist/lil-gui.esm.min.js', 'lil-gui.esm.min.js']
];
for (const [from, to] of copies) {
    cpSync(join(root, from), join(lib, to));
}

console.log('built dist/');
