import manifest from './vendor/t3-claude-model-manifest.json' with { type: 'json' };
import { selectedProviderOptions, type ProviderModel, type ProviderModelSelection, type ProviderOptionDescriptor } from './provider-models.js';

type Profile = { capabilities: { optionDescriptors: ProviderOptionDescriptor[] }; adapter?: { claudeCode?: { effortMap?: Record<string, string | null>; modelSuffixes?: Record<string, Record<string, string>> } } };
function profile(model: { id: string; resolvedModel?: string }) {
  const ids = model.resolvedModel ? [model.resolvedModel] : [model.id];
  const entry = manifest.catalog.models.find(entry => ids.some(id => id === entry.slug || ('aliases' in entry && entry.aliases?.includes(id!))));
  return entry ? (manifest.catalog.profiles as Record<string, Profile>)[entry.profile] : undefined;
}
export function claudeOptionDescriptors(model: { id: string; resolvedModel?: string; reasoningEfforts: string[] }, native: { supportsFastMode?: boolean; supportsAdaptiveThinking?: boolean }): ProviderOptionDescriptor[] {
  const configured = profile(model)?.capabilities.optionDescriptors;
  if (configured) {
    const runtime = profile(model)?.adapter?.claudeCode;
    return structuredClone(configured).flatMap(descriptor => {
      if (descriptor.id === 'fastMode' && native.supportsFastMode === false) return [];
      if (descriptor.id !== 'effort' || descriptor.type !== 'select' || !model.reasoningEfforts.length) return [descriptor];
      const options = descriptor.options.filter(option => {
        const mapped = runtime?.effortMap && Object.hasOwn(runtime.effortMap, option.id) ? runtime.effortMap[option.id] : option.id;
        return mapped === null || model.reasoningEfforts.includes(mapped);
      });
      return options.length ? [{ ...descriptor, options }] : [];
    });
  }
  return [
    ...(model.reasoningEfforts.length ? [{ id: 'effort', label: 'Reasoning', type: 'select' as const, options: model.reasoningEfforts.map(id => ({ id, label: id })) }] : []),
    ...(native.supportsFastMode ? [{ id: 'fastMode', label: 'Fast Mode', type: 'boolean' as const }] : []),
  ];
}
export function compileClaudeOptions(model: ProviderModel, selection?: ProviderModelSelection) {
  const options = selectedProviderOptions(model, selection), descriptors = model.optionDescriptors ?? [], runtime = profile(model)?.adapter?.claudeCode;
  const effortDescriptor = descriptors.find(value => value.id === 'effort' && value.type === 'select');
  const effort = options.effort || (effortDescriptor?.type === 'select' ? effortDescriptor.currentValue ?? effortDescriptor.options.find(value => value.isDefault)?.id : undefined);
  const apiEffort = effort && runtime?.effortMap && Object.hasOwn(runtime.effortMap, effort) ? runtime.effortMap[effort] ?? undefined : effort;
  let apiModel = model.id;
  for (const [id, suffixes] of Object.entries(runtime?.modelSuffixes ?? {})) {
    const value = options.values[id], descriptor = descriptors.find(option => option.id === id);
    const selected = typeof value === 'string' ? value : descriptor?.type === 'select' ? descriptor.currentValue ?? descriptor.options.find(value => value.isDefault)?.id : undefined;
    if (selected && suffixes[selected]) apiModel += suffixes[selected];
  }
  const settings: Record<string, boolean> = {};
  for (const [option, key] of [['fastMode', 'fastMode'], ['thinking', 'alwaysThinkingEnabled']] as const) {
    if (descriptors.some(value => value.id === option && value.type === 'boolean')) {
      const value = options.values[option]; if (typeof value === 'boolean') settings[key] = value; else if (option === 'fastMode') settings[key] = false;
    }
  }
  // Clear a standing orchestration setting when returning to a regular effort.
  if (effortDescriptor?.type === 'select' && effortDescriptor.options.some(value => value.id === 'ultracode')) settings.ultracode = effort === 'ultracode';
  return { model: model.id, apiModel, effort, apiEffort, modelSettings: settings, promptEffort: effort === 'ultrathink' && apiEffort === undefined ? 'ultrathink' : undefined };
}
