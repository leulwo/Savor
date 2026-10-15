const { spawnSync } = require('node:child_process');
const path = require('node:path');

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run security:check.');
const root = path.resolve(__dirname, '..');
const commands = [
  ['--prefix', 'backend', 'audit', '--audit-level=low'],
  ['--prefix', 'frontend', 'audit', '--audit-level=low'],
  ['run', 'lint'],
  ['test'],
  ['run', 'build'],
];
for (const args of commands) {
  console.log(`\nSecurity check: npm ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [npm, ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error('Security check stopped: a required check did not pass.');
    process.exit(result.status || 1);
  }
}
console.log('\nDependency audits, type checks, tests and production builds passed.');
