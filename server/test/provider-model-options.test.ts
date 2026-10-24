import test from 'node:test';
import assert from 'node:assert/strict';
import { providerOptionSelections, selectedProviderOptions, type ProviderModel } from '../src/provider-models.js';
import { codexServiceTierOptions } from '../src/codex-provider.js';
import { claudeOptionDescriptors, compileClaudeOptions } from '../src/claude-model-options.js';

test('model selections preserve false, accept T3 array and legacy object forms, and reject unsupported or conflicting values', () => {
  const model: ProviderModel = { id: 'fixture', name: 'Fixture', description: '', isDefault: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', optionDescriptors: [{ id: 'fastMode', label: 'Fast', type: 'boolean' }] };
  assert.deepEqual(providerOptionSelections({ fastMode: false }), [{ id: 'fastMode', value: false }]);
  assert.equal(selectedProviderOptions(model, { modelOptions: [{ id: 'fastMode', value: false }] }).values.fastMode, false);
  assert.equal(selectedProviderOptions(model, { modelOptions: [{ id: 'reasoningEffort', value: 'high' }] }).effort, 'high');
  for (const input of [[{ id: 'fastMode', value: 'false' }], [{ id: 'unknown', value: true }], [{ id: 'reasoningEffort', value: 'invalid' }]]) assert.throws(() => selectedProviderOptions(model, { modelOptions: input }));
  assert.throws(() => selectedProviderOptions(model, { reasoningEffort: 'low', modelOptions: [{ id: 'reasoningEffort', value: 'high' }] }));
  for (const input of [null, 'bad', [{ id: 'same', value: true }, { id: 'same', value: false }], [{ id: '__proto__', value: true }], [{ id: 'bad', value: {} }]]) assert.throws(() => providerOptionSelections(input));
});
test('Codex exposes only advertised service tiers and keeps standard as an explicit reset', () => {
  assert.deepEqual(codexServiceTierOptions({ model: 'unreported' }), []);
  const modern = codexServiceTierOptions({ serviceTiers: [{ id: 'fast', name: 'Fast' }, { id: 'flex', name: 'Flex' }], defaultServiceTier: 'fast' })[0];
  assert.equal(modern.type, 'select');
  if (modern.type === 'select') { assert.deepEqual(modern.options.map(value => value.id), ['default', 'fast', 'flex']); assert.equal(modern.currentValue, 'fast'); }
  const legacy = codexServiceTierOptions({ additionalSpeedTiers: ['fast'] })[0];
  assert.equal(legacy.currentValue, 'default');
});
test('fixed T3 Claude profiles compile workflow, prompt effort, fast reset and expanded context into their actual native forms', () => {
  const make = (id: string): ProviderModel => {
    const model = { id, name: id, description: '', isDefault: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: '' };
    return { ...model, optionDescriptors: claudeOptionDescriptors(model, {}) };
  };
  const model = make('claude-opus-5-5'); model.reasoningEfforts = ['high', 'xhigh', 'ultracode', 'ultrathink'];
  const workflow = compileClaudeOptions(model, { modelOptions: [{ id: 'effort', value: 'ultracode' }, { id: 'fastMode', value: true }] });
  assert.equal(workflow.apiEffort, 'xhigh'); assert.deepEqual(workflow.modelSettings, { fastMode: true, ultracode: true });
  const prompt = compileClaudeOptions(model, { modelOptions: [{ id: 'effort', value: 'ultrathink' }] });
  assert.equal(prompt.apiEffort, undefined); assert.equal(prompt.promptEffort, 'ultrathink'); assert.equal(prompt.modelSettings.fastMode, false); assert.equal(prompt.modelSettings.ultracode, false);
  const legacy = make('claude-sonnet-4-6'), context = legacy.optionDescriptors?.find(value => value.id === 'contextWindow');
  assert.ok(context?.type === 'select');
  if (context?.type === 'select') {
    const expanded = context.options.find(option => option.id === '1m'); assert.ok(expanded);
    assert.ok(compileClaudeOptions(legacy, { modelOptions: [{ id: 'contextWindow', value: expanded.id }] }).apiModel.startsWith(legacy.id + '['));
  }
  const custom = make('custom-never-in-catalog'); assert.equal(custom.optionDescriptors?.some(value => value.id === 'fastMode'), false);
});
