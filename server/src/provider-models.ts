export type ProviderModel = {
  id: string; name: string; description: string; isDefault: boolean;
  reasoningEfforts: string[]; defaultReasoningEffort: string;
  isCustom?: boolean; resolvedModel?: string;
};

export function appendCustomModels(models: ProviderModel[], custom: { id: string; name: string }[]): ProviderModel[] {
  const ids = new Set(models.map(model => model.id));
  return [...models, ...custom.filter(model => !ids.has(model.id)).map(model => ({
    ...model, description: '', isDefault: false, isCustom: true,
    // An arbitrary ID does not establish model capabilities or account access.
    reasoningEfforts: [], defaultReasoningEffort: '',
  }))];
}
