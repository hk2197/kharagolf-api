import { spawn } from 'child_process';

const child = spawn('npx.cmd', ['drizzle-kit', 'push', '--force', '--config', './drizzle.config.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true
});

child.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(output);
  if (output.includes('?')) {
    child.stdin.write('y\n');
  }
});

child.stderr.on('data', (data) => {
  process.stderr.write(data.toString());
});

child.on('close', (code) => {
  console.log(`child process exited with code ${code}`);
  process.exit(code);
});
