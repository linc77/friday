export type ProviderModel = {
  id: string; name: string; description: string; isDefault: boolean;
  reasoningEfforts: string[]; defaultReasoningEffort: string;
  isCustom?: boolean; resolvedModel?: string;
  optionDescriptors?: ProviderOptionDescriptor[];
};

export type ProviderOptionSelection = { id: string; value: string | boolean };
export type ProviderOptionDescriptor = { id: string; label: string; description?: string } & (
  { type: 'select'; options: { id: string; label: string; description?: string; isDefault?: boolean }[]; currentValue?: string }
  | { type: 'boolean'; currentValue?: boolean });
export type ProviderModelSelection = { model?: string; reasoningEffort?: string; modelOptions?: ProviderOptionSelection[] };
const validText = (value: unknown, maximum = 128): value is string => typeof value === 'string' && !!value.trim() && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
export function providerOptionSelections(input: unknown): ProviderOptionSelection[] | undefined {
  if (input === undefined) return undefined;
  const values = Array.isArray(input) ? input : input && typeof input === 'object' ? Object.entries(input).map(([id, value]) => ({ id, value })) : undefined;
  if (!values || values.length > 32) throw new Error('模型选项格式无效');
  const seen = new Set<string>();
  return values.map(value => {
    if (!value || !validText(value.id) || seen.has(value.id) || ['__proto__', 'constructor', 'prototype'].includes(value.id) || !(typeof value.value === 'boolean' || validText(value.value, 1024))) throw new Error('模型选项格式无效或重复');
    seen.add(value.id); return { id: value.id, value: typeof value.value === 'string' ? value.value.trim() : value.value };
  });
}
export function providerOptionDescriptors(model: ProviderModel): ProviderOptionDescriptor[] {
  const descriptors = model.optionDescriptors ?? [];
  return model.reasoningEfforts.length && !descriptors.some(option => ['reasoningEffort', 'reasoning', 'effort', 'variant', 'thinkingLevel'].includes(option.id))
    ? [{ id: 'reasoningEffort', label: 'Reasoning', type: 'select', options: model.reasoningEfforts.map(id => ({ id, label: id, ...(id === model.defaultReasoningEffort ? { isDefault: true } : {}) })), ...(model.defaultReasoningEffort ? { currentValue: model.defaultReasoningEffort } : {}) }, ...descriptors]
    : descriptors;
}
export function selectedProviderOptions(model: ProviderModel, selection?: ProviderModelSelection) {
  const options = providerOptionSelections(selection?.modelOptions) ?? [], descriptors = providerOptionDescriptors(model), values: Record<string, string | boolean> = Object.create(null);
  for (const option of options) {
    const descriptor = descriptors.find(value => value.id === option.id);
    if (!descriptor || (descriptor.type === 'boolean' ? typeof option.value !== 'boolean' : typeof option.value !== 'string' || !descriptor.options.some(value => value.id === option.value))) throw new Error('模型选项已改变或不受支持，请重新选择');
    values[option.id] = option.value;
  }
  const optionEffort = ['reasoningEffort', 'reasoning', 'effort', 'variant', 'thinkingLevel'].map(id => values[id]).find(value => typeof value === 'string');
  if (optionEffort && selection?.reasoningEffort && optionEffort !== selection.reasoningEffort) throw new Error('模型选项与推理强度不一致');
  return { values, effort: typeof optionEffort === 'string' ? optionEffort : selection?.reasoningEffort };
}

export function appendCustomModels(models: ProviderModel[], custom: { id: string; name: string }[]): ProviderModel[] {
  const ids = new Set(models.map(model => model.id));
  return [...models, ...custom.filter(model => !ids.has(model.id)).map(model => ({
    ...model, description: '', isDefault: false, isCustom: true,
    // An arbitrary ID does not establish model capabilities or account access.
    reasoningEfforts: [], defaultReasoningEffort: '',
  }))];
}
