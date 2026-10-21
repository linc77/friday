#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
appendFileSync('claude-wire.jsonl', JSON.stringify({ args, configDirectory: process.env.CLAUDE_CONFIG_DIR }) + '\n');
if (args.includes('--version')) { console.log('2.1.285 (Claude Code)'); process.exit(0); }
if (args.includes('auth')) {
  const loggedIn = process.env.FRIDAY_TEST_AUTH !== 'none';
  console.log(JSON.stringify({ loggedIn, authMethod: 'api_key', apiProvider: 'firstParty' })); process.exit(loggedIn ? 0 : 1);
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); appendFileSync('claude-wire.jsonl', line + '\n');
  if (message.type === 'user') throw new Error('A provider probe must not start a turn');
  if (message.type === 'control_request' && message.request.subtype === 'get_usage') {
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
      rate_limits_available: process.env.FRIDAY_TEST_USAGE !== 'unsupported', rate_limits: { five_hour: { utilization: 23, resets_at: '2033-05-18T03:33:20Z' }, seven_day: { utilization: 45, resets_at: null }, model_scoped: [{ display_name: 'Future Model', utilization: 67, resets_at: null }] },
    } } })); return;
  }
  if (message.type === 'control_request') console.log(JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: message.request_id, response: {
      account: { email: 'claude@example.com', tokenSource: 'ANTHROPIC_API_KEY' },
      commands: [{ name: 'compact', description: 'Compact context', argumentHint: '', builtin: true }],
      models: [
        { value: 'default', displayName: 'Default', resolvedModel: 'gateway-model', description: '', supportedEffortLevels: ['low', 'high'] },
        { value: 'sonnet', displayName: 'Sonnet', description: '', supportedEffortLevels: ['medium', 'high'] },
      ],
    },
  } }));
});
