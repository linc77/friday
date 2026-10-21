#!/usr/bin/env node
import { mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
const args = process.argv.slice(2), npm = args.includes('--global'), spec = args.at(-1), prefix = npm ? args[args.indexOf('--prefix') + 1] : process.env.UV_TOOL_DIR;
if (args[0] === 'tool' && args[1] === 'list') { console.log('fixture-agent v1.2.3'); process.exit(0); }
const name = npm ? spec.slice(0, spec.lastIndexOf('@')) : spec.split('==')[0], version = npm ? spec.slice(spec.lastIndexOf('@') + 1) : spec.split('==')[1];
if (npm) {
  const root = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', name); mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version, bin: { 'fixture-agent': 'bin/agent.js' } }));
  const file = join(root, 'bin/agent.js'); writeFileSync(file, '#!' + process.execPath + '\nconsole.log(require("node:fs").existsSync(' + JSON.stringify(root) + ')?"npm-private-native":"relocation-broken")\n'); chmodSync(file, 0o755);
} else {
  const file = join(prefix, 'fixture-agent', 'bin', 'agent'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '#!' + process.execPath + '\nconsole.log("uv-private-native")\n'); chmodSync(file, 0o755);
  mkdirSync(process.env.UV_TOOL_BIN_DIR, { recursive: true }); symlinkSync(file, join(process.env.UV_TOOL_BIN_DIR, 'fixture-agent'));
}
