/*
Adapted from T3 Code 8cd9641f packages/source-control-gitcafe/src/server/gitCafeHosts.ts.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export const GITCAFE_HOSTS = ["git.cafe", "staging.git.cafe"] as const;
export type GitCafeHost = (typeof GITCAFE_HOSTS)[number];

export function gitCafeHost(host: string): GitCafeHost | null {
  const normalized = host.trim().toLowerCase();
  return GITCAFE_HOSTS.find((candidate) => candidate === normalized) ?? null;
}

export function isGitCafeHost(host: string): boolean {
  return gitCafeHost(host) !== null;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REMOTE_PATTERNS = [
  /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/iu,
  /^ssh:\/\/[^@/]+@([^/:]+)(?::\d+)?\/(.+)$/iu,
  /^[^@/:]+@([^/:]+):(.+)$/u,
];

export function gitCafeRepositoryPath(path: string): string | null {
  const repository = path
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  return REPOSITORY.test(repository) ? repository : null;
}

export function parseGitCafeRemote(
  url: string,
): { readonly host: GitCafeHost; readonly repository: string } | null {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (!match?.[1] || !match[2]) continue;
    const host = gitCafeHost(match[1]);
    const repository = gitCafeRepositoryPath(match[2]);
    return host && repository ? { host, repository } : null;
  }
  return null;
}
