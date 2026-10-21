/*
Adapted from T3 Code 8cd9641f packages/source-control-gitlab/src/server/gitLabAuthStatus.ts.
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
const HOST_LINE_PATTERN = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(?::\d+)?$/iu;
const LOGGED_IN_PATTERN = /Logged in to .+? as\s+([^\s(]+)/iu;

export interface GitLabAuthStatusHost {
  readonly host: string;
  readonly account: string | null;
}

export function parseGitLabAuthStatusHosts(text: string): ReadonlyArray<GitLabAuthStatusHost> {
  const hosts: GitLabAuthStatusHost[] = [];
  let currentHost: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentHost === null) return;

    const account = LOGGED_IN_PATTERN.exec(currentLines.join("\n"))?.[1]?.trim() || null;
    hosts.push({ host: currentHost, account });
    currentHost = null;
    currentLines = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const isHostLine =
      rawLine.length === rawLine.trimStart().length && HOST_LINE_PATTERN.test(line);
    if (isHostLine) {
      flush();
      currentHost = line.toLowerCase();
      continue;
    }

    if (currentHost !== null) {
      currentLines.push(line);
    }
  }

  flush();
  return hosts;
}

export function findAuthenticatedGitLabHost(
  hosts: ReadonlyArray<GitLabAuthStatusHost>,
): GitLabAuthStatusHost | undefined {
  return hosts.find((host) => host.account !== null);
}
