import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
if (process.argv[2] === 'child') {
  globalThis.allocation = Buffer.alloc(48 * 1024 * 1024, 0x41);
  process.send('ready');
} else {
  const input = readline.createInterface({ input: process.stdin });
  let request;
  const emit = (type, fields = {}) => console.log(JSON.stringify({ version: 1, requestId: request.requestId, type, ...fields }));
  input.on('line', line => {
    const value = JSON.parse(line);
    if (!request) {
      request = value;
      if (process.env.FIXTURE_MODE === 'spoof') { emit('resources', { privateCommitBytes: 1 }); return; }
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => emit('status', { message: 'ready', current: child.pid }));
    } else if (value.command === 'cancel' && process.env.FIXTURE_MODE !== 'hang') {
      emit('complete', { status: 'paused', completeness: 'partial' }); process.exit(0);
    }
  });
  input.on('close', () => { if (process.env.FIXTURE_MODE !== 'hang') process.exit(0); });
}
setTimeout(() => process.exit(0), 20000);
