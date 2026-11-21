import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const outDir = path.join(root, 'dist-worker');
fs.mkdirSync(outDir, { recursive: true });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function collectFiles(dir, basePrefix = '') {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const route = `${basePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, route));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      results.push({
        route,
        contentType: MIME_TYPES[ext] || 'application/octet-stream',
        content: fs.readFileSync(full, 'utf8'),
      });
    }
  }
  return results;
}

const files = collectFiles(distDir);
const assetMapLines = files.map(
  (f) =>
    `  ${JSON.stringify(f.route)}: { contentType: ${JSON.stringify(
      f.contentType
    )}, body: ${JSON.stringify(f.content)} },`
);

const generatedEntry = `
import { handleApiRequest } from '../worker/index.ts';

const STATIC_ASSETS: Record<string, { contentType: string; body: string }> = {
${assetMapLines.join('\n')}
};

export default {
  async fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
    try {
      const apiRes = await handleApiRequest(request, env);
      if (apiRes) return apiRes;

      const url = new URL(request.url);
      let asset = STATIC_ASSETS[url.pathname];
      if (!asset && (url.pathname === '/' || !url.pathname.includes('.'))) {
        asset = STATIC_ASSETS['/index.html'];
      }
      if (!asset) {
        return new Response('Not Found', { status: 404 });
      }

      const isImmutable = url.pathname.startsWith('/assets/');
      return new Response(asset.body, {
        status: 200,
        headers: {
          'Content-Type': asset.contentType,
          'Cache-Control': isImmutable
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=300',
          'Permissions-Policy': 'xr-spatial-tracking=(self)',
        },
      });
    } catch (err) {
      console.error(JSON.stringify({ event: 'worker_error', message: String(err) }));
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
`;

const tmpEntryPath = path.join(outDir, 'entry.ts');
fs.writeFileSync(tmpEntryPath, generatedEntry, 'utf8');

await esbuild.build({
  entryPoints: [tmpEntryPath],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  outfile: path.join(outDir, 'worker.js'),
});

fs.unlinkSync(tmpEntryPath);
const stat = fs.statSync(path.join(outDir, 'worker.js'));
console.log(
  `Built dist-worker/worker.js (${(stat.size / 1024).toFixed(1)} KB, ${files.length} static files)`
);
