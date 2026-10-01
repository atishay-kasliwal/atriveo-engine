#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { version } = require('../package.json');

async function main() {
  const target = `${process.platform}-${process.arch}`;
  if (!['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'].includes(target)) {
    throw new Error(`Unsupported platform: ${target}. Run from source with Bun instead.`);
  }
  const name = `atriveo-engine-${target.replace('win32', 'windows')}${process.platform === 'win32' ? '.exe' : ''}`;
  const dir = path.join(os.homedir(), '.cache', 'atriveo-engine', version);
  const binary = path.join(dir, name);
  try { await fs.access(binary); } catch {
    const base = `https://github.com/atishay-kasliwal/atriveo-engine/releases/download/v${version}`;
    const download = async (file) => {
      const response = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Cannot download ${file}: HTTP ${response.status}. Check that v${version} is released.`);
      return Buffer.from(await response.arrayBuffer());
    };
    const [bytes, sums] = await Promise.all([download(name), download('SHA256SUMS')]);
    const expected = sums.toString().split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === name)?.[0];
    if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Release checksum mismatch');
    await fs.mkdir(dir, { recursive: true });
    const temporary = `${binary}.${process.pid}.tmp`;
    await fs.writeFile(temporary, bytes, { mode: 0o755 });
    await fs.rename(temporary, binary);
  }
  const child = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
main().catch(error => { console.error(`atriveo: ${error.message}`); process.exitCode = 1; });
