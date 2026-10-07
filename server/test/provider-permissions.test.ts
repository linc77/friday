import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCodexSettings, loadCodexSettings, validateSettings } from '../src/codex-settings.js';
import { defaultClaudeSettings, loadClaudeSettings, validateClaudeSettings } from '../src/claude-provider.js';

test('Legacy provider settings default to Auto; older clients preserve saved permission modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-permission-settings-'));
  try {
    for (const [provider, defaults, load, validate] of [
      ['codex', defaultCodexSettings, loadCodexSettings, validateSettings],
      ['claude', defaultClaudeSettings, loadClaudeSettings, validateClaudeSettings],
    ] as const) {
      assert.equal((await load(directory)).permissionMode, 'auto');
      const { permissionMode: _, ...legacy } = defaults;
      await writeFile(join(directory, `${provider}-provider.json`), JSON.stringify(legacy));
      assert.equal((await load(directory)).permissionMode, 'auto');
      const saved = validate({ ...defaults, permissionMode: 'default' }, defaults);
      assert.equal(validate(legacy, saved).permissionMode, 'default');
      assert.equal(validate({ ...legacy, permissionMode: 'auto' }, saved).permissionMode, 'auto');
      for (const permissionMode of [null, '', 'invalid', 'bypassPermissions']) {
        assert.throws(() => validate({ ...defaults, permissionMode }, saved), /权限模式/);
      }
    }
    for (const permissionMode of ['acceptEdits', 'plan']) {
      assert.equal(validateClaudeSettings({ ...defaultClaudeSettings, permissionMode }).permissionMode, permissionMode);
      assert.throws(() => validateSettings({ ...defaultCodexSettings, permissionMode }, defaultCodexSettings), /权限模式/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
