/** Run destructive HTTP suites only against disposable, freshly seeded stores. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ecod-http-check-'));

async function run(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [code, signal] = await once(child, 'exit');
    if (code !== 0) throw new Error(`${args.join(' ')} failed (${signal || code}).`);
  } finally { clearTimeout(timer); }
}

async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  return port;
}

try {
  for (const suite of ['smoke', 'features', 'final-gauntlet']) {
    const port = await availablePort();
    const env = { ...process.env, STORAGE: 'json', DATA_FILE: path.join(temporary, suite, 'db.json'),
      SEED_FRESH: '1', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
      BASE: `http://127.0.0.1:${port}/api`, PYTHONUTF8: '1' };
    console.log(`\n[http-check] ${suite}: disposable store, port ${port}`);
    await run(process.execPath, ['scripts/seed.mjs'], env);
    const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    server.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
    server.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (server.exitCode !== null) throw new Error('HTTP test server exited before startup.');
        try {
          const response = await fetch(`${env.BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok) { ready = true; break; }
        } catch { /* wait for the process to listen */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error('HTTP test server did not become ready.');
      await run(python, [`tests/${suite}.py`], env);
    } catch (err) {
      console.error(logs);
      throw err;
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const stopped = once(server, 'exit');
        server.kill();
        await stopped;
      }
    }
  }
  console.log('\n[http-check] All HTTP suites passed.');
} finally {
  // Only the exact directory created by mkdtemp above is eligible for cleanup.
  await fs.rm(temporary, { recursive: true, force: true });
}
