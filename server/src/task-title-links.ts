/*!
 * Linked title subject policy follows pingdotgg/t3code
 * 8cd9641f76874f2ce17d6c80acd71fab1f0b99d3/apps/server/src/textGeneration/ThreadTitleLinks.ts
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { findExecutable } from './agents.js';
import { workspaceCommand } from './git-process.js';
import { resolve } from 'node:path';
import type { SourceControlConnections } from './source-control-connections.js';

type TitleLink = { url: string; host: string; provider: 'github' | 'gitlab'; endpoint: string };
type Dependencies = { command?: typeof findExecutable; execute?: typeof workspaceCommand; connections?: SourceControlConnections };
export type TaskTitleLinkInput = { message: string; cwd: string; signal: AbortSignal };

export function taskTitleLinks(message: string, githubHosts: string[] = []): TitleLink[] {
  const links = new Map<string, TitleLink>();
  for (const match of message.matchAll(/https:\/\/[^\s<>"')\]`]+/g)) {
    let url: URL;
    try { url = new URL(match[0].replace(/[.,;!?]+$/, '')); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || !['github.com', 'gitlab.com', ...githubHosts].includes(url.host)) continue;
    url.hash = ''; url.search = ''; if (links.has(url.href)) continue;
    const github = url.host === 'github.com' || githubHosts.includes(url.host) ? /^\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname) : null;
    const gitlab = url.host === 'gitlab.com' ? /^\/(.+)\/-\/(merge_requests|issues)\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname) : null;
    const endpoint = github ? `repos/${github[1]}/${github[2]}/issues/${github[3]}`
      : gitlab ? `projects/${encodeURIComponent(gitlab[1])}/${gitlab[2]}/${gitlab[3]}` : undefined;
    if (!endpoint) continue;
    links.set(url.href, { url: url.href, host: url.host, provider: github ? 'github' : 'gitlab', endpoint });
    if (links.size === 2) break;
  }
  return [...links.values()];
}
const prefix = (text: string, limit: number) => text.slice(0, /[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[limit] ?? '') ? limit - 1 : limit);

export async function resolveTaskTitleLinks(input: TaskTitleLinkInput, dependencies: Dependencies = {}): Promise<string | undefined> {
  input.signal.throwIfAborted();
  const deadline = Date.now() + 3_000;
  let githubHosts = dependencies.connections && input.message.includes('https://') ? await dependencies.connections.githubHosts(input.cwd, undefined, false) : [];
  const unknownHost = [...input.message.matchAll(/https:\/\/[^\s<>"')\]`]+/g)].some(match => {
    try { const url = new URL(match[0]); return !url.username && !url.password && !['github.com', 'gitlab.com', ...githubHosts].includes(url.host) && /^\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/[1-9]\d*/.test(url.pathname); } catch { return false; }
  });
  if (dependencies.connections && unknownHost) {
    try { githubHosts = await dependencies.connections.githubHosts(input.cwd, AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])); }
    catch { input.signal.throwIfAborted(); }
  }
  const links = taskTitleLinks(input.message, githubHosts); if (!links.length) return undefined;
  const command = dependencies.command ?? findExecutable; const execute = dependencies.execute ?? workspaceCommand;
  const subjects = await Promise.allSettled(links.map(async link => {
    try {
      let value: unknown;
      if (dependencies.connections) {
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
        const pinned = await dependencies.connections.pin(input.cwd, link.provider, link.host, signal);
        value = await pinned.json(link.endpoint, { signal, maxResponseBytes: link.provider === 'github' ? 1_000_000 : 32_000 });
      } else {
      const binary = command(link.provider === 'github' ? 'gh' : 'glab'); if (!binary) return `${link.url}: unavailable`;
      // Exact public host and a constructed REST path, never a message-supplied
      // hostname, CLI option or Git remote. No local repository history is read.
      const result = await execute(input.cwd, resolve(binary), ['api', '--hostname', link.host, ...(link.host === 'github.com' ? ['--method', 'GET'] : []), link.endpoint], {
        signal: input.signal, timeout: 3000, killGraceMs: 0, limit: link.host === 'github.com' ? 1_000_000 : 32_000,
      });
      value = JSON.parse(result.stdout);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid linked subject');
      const subject = value as Record<string, unknown>; const body = subject[link.provider === 'github' ? 'body' : 'description'];
      if (typeof subject.title !== 'string' || body !== null && body !== undefined && typeof body !== 'string') throw new Error('Invalid linked subject');
      const title = prefix(subject.title, 300); const snippet = prefix(typeof body === 'string' ? body : '', 1200);
      // Invalid escaped UTF-16 must not poison the model request or a future
      // native snapshot. The subject budget keeps this validation bounded.
      encodeURIComponent(title); encodeURIComponent(snippet);
      return link.url + '\n' + JSON.stringify({ title, body: snippet });
    } catch { return `${link.url}: unavailable`; }
  }));
  input.signal.throwIfAborted();
  return subjects.map((result, index) => result.status === 'fulfilled' ? result.value : `${links[index].url}: unavailable`).join('\n\n');
}
