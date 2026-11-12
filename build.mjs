import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { build } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const source = join(root, 'src');
const output = join(root, 'dist');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const formats = { main: 'es', preload: 'cjs', renderer: 'es', offsetWorker: 'es' };

async function getZig() {
  const tools = join(root, 'tools');
  const release = 'zig-x86_64-windows-0.15.2';
  const executable = join(tools, release, 'zig.exe');
  if (await stat(executable).then(file => file.isFile(), () => false)) return executable;

  await mkdir(tools, { recursive: true });
  const archivePath = join(tools, `${release}.zip`);
  let archive = await readFile(archivePath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!archive) {
    process.stdout.write('Downloading Zig 0.15.2…\n');
    const response = await fetch(`https://ziglang.org/download/0.15.2/${release}.zip`, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`Zig 下载失败（HTTP ${response.status}）`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  const sha256 = createHash('sha256').update(archive).digest('hex');
  if (sha256 !== '3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c') {
    await rm(archivePath, { force: true });
    throw new Error('Zig 下载包的 SHA-256 校验失败，请重新构建');
  }
  const zip = await JSZip.loadAsync(archive);
  const staging = await mkdtemp(join(tools, 'zig-extract-'));
  try {
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      if (!entry.name.startsWith(release + '/') || entry.name.includes('\\') ||
          entry.name.split('/').some(part => part === '..' || part.includes(':'))) {
        throw new Error('Zig 压缩包包含无效路径');
      }
      const path = join(staging, entry.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await entry.async('nodebuffer'));
    }
    await rename(join(staging, release), join(tools, release));
    await rm(archivePath, { force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return executable;
}

async function buildSsoBridge() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('当前发布包在 Windows x64 上构建');
  }
  const run = promisify(execFile);
  const zig = await getZig();
  const cache = join(root, 'tools', 'zig-cache');
  try {
    const result = await run(zig, [
      'build', '--prefix', output,
      '--cache-dir', join(cache, 'local'),
      '--global-cache-dir', join(cache, 'global'),
    ], {
      cwd: join(root, 'native'),
      windowsHide: true,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    process.stderr.write(error.stdout ?? '');
    process.stderr.write(error.stderr ?? '');
    throw error;
  }
}

await rm(output, { recursive: true, force: true });
await buildSsoBridge();

for (const [entry, format] of Object.entries(formats)) {
  const worker = entry === 'offsetWorker';
  const filename = worker ? './main/offset-worker.js' : manifest.qwqnt.inject[entry];
  await build({
    configFile: false,
    root,
    resolve: { alias: { '@': source } },
    build: {
      outDir: output,
      emptyOutDir: false,
      target: entry === 'main' || worker ? 'node23' : undefined,
      minify: false,
      lib: {
        entry: worker ? join(source, 'main', 'offsets', 'worker.ts') : join(source, entry, 'index.ts'),
        formats: [format],
        fileName: () => filename.replace(/^\.\//, ''),
      },
      rolldownOptions: {
        external: id => id === 'electron' || isBuiltin(id),
        output: { minify: { compress: true, mangle: true } },
      },
    },
  });
}

for (const path of ['package.json', 'icon.svg', 'LICENSE']) {
  await cp(join(root, path), join(output, path), { recursive: true });
}
const zip = new JSZip();
for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  zip.file(relative(output, path).split(sep).join('/'), await readFile(path));
}
await writeFile(join(root, `${manifest.name}.zip`), await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
}));
