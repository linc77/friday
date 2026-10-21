export const sourceControlProviders = ['github', 'gitlab', 'bitbucket', 'forgejo', 'gitcafe', 'azure-devops'] as const;
export type SourceControlProvider = typeof sourceControlProviders[number];
export type AdditionalSourceControlProvider = 'forgejo' | 'gitcafe' | 'azure-devops';
export function isAdditionalSourceControlProvider(value: string): value is AdditionalSourceControlProvider {
  return value === 'forgejo' || value === 'gitcafe' || value === 'azure-devops';
}
export const sourceControlProviderDefinitions = {
  github: { label: 'GitHub', host: 'github.com', command: 'gh' },
  gitlab: { label: 'GitLab', host: 'gitlab.com', command: 'glab' },
  bitbucket: { label: 'Bitbucket', host: 'bitbucket.org', command: 'API' },
  forgejo: { label: 'Forgejo', host: '', command: 'fj / tea' },
  gitcafe: { label: 'GitCafe', host: 'git.cafe', command: 'cafe' },
  'azure-devops': { label: 'Azure DevOps', host: 'dev.azure.com', command: 'az' },
} as const;
