// build-dist.mjs — bundles + minifies client and server into dist/, a
// standalone runnable copy: `node dist/server.js` needs no node_modules and
// no environment variables. Usage: npm run build:dist
//
// Layout produced:
//   dist/server.js            relay server with ws bundled in (platform node)
//   dist/public/index.html    entry tag rewritten js/main.js -> app.js
//   dist/public/app.js        client bundle (three vendored via relative import)
//   dist/public/style.css     minified
//   dist/public/app-config.js copied verbatim (app builds overwrite their copy)

import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DIST_PUBLIC = path.join(DIST, 'public');

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST_PUBLIC, { recursive: true });

// ---- client: public/js/main.js (pulls in three via ../lib/) -> dist/public/app.js
await build({
  entryPoints: [path.join(ROOT, 'public', 'js', 'main.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  outfile: path.join(DIST_PUBLIC, 'app.js'),
  logLevel: 'warning',
});

// ---- style.css minified
await build({
  entryPoints: [path.join(ROOT, 'public', 'style.css')],
  minify: true,
  outfile: path.join(DIST_PUBLIC, 'style.css'),
  logLevel: 'warning',
});

// ---- index.html: swap the module entry for the bundle; the plain
// app-config.js tag stays untouched.
const html = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
const NEEDLE = '<script type="module" src="js/main.js"></script>';
if (!html.includes(NEEDLE)) {
  throw new Error(`index.html: entry tag not found, expected exactly: ${NEEDLE}`);
}
await writeFile(
  path.join(DIST_PUBLIC, 'index.html'),
  html.replace(NEEDLE, '<script type="module" src="app.js"></script>'),
);

// ---- per-build overrides file, copied verbatim
await copyFile(
  path.join(ROOT, 'public', 'app-config.js'),
  path.join(DIST_PUBLIC, 'app-config.js'),
);

// ---- server: server/index.js (+ ws) -> dist/server.js, zero runtime deps
await build({
  entryPoints: [path.join(ROOT, 'server', 'index.js')],
  bundle: true,
  minify: true,
  platform: 'node', // node builtins (http, child_process, ...) stay external
  format: 'esm',
  target: 'node20',
  outfile: path.join(DIST, 'server.js'),
  // ws optionally require()s these native accelerators inside try/catch; they
  // are not installed, so leave them external — the require fails at runtime
  // and ws falls back to its pure-JS paths, exactly as under `npm start`.
  external: ['bufferutil', 'utf-8-validate'],
  // dist/server.js sits next to dist/public/: serve that instead of ../public
  // (see the VC_PUBLIC_REL typeof-guard in server/index.js).
  define: { VC_PUBLIC_REL: '"public"' },
  // ws is CommonJS; in ESM output its require() calls need a real require.
  banner: {
    js: "import{createRequire as __vcCreateRequire}from'node:module';const require=__vcCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

// ---- size report
const out = ['server.js', 'public/index.html', 'public/app.js', 'public/style.css', 'public/app-config.js'];
console.log('dist/ build complete:');
for (const rel of out) {
  const { size } = await stat(path.join(DIST, rel));
  console.log(`  ${String(size).padStart(8)} B (${(size / 1024).toFixed(1).padStart(7)} KB)  dist/${rel}`);
}
