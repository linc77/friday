/*
Adapted from T3 Code 8cd9641f, githubStackActions.ts / githubStackRebase.ts / gitHubPullRequestJson.ts.
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
// Behavior follows T3 Code 8cd9641f: native GitHub stacks, ordered bottom to top.
import { SourceControlHTTPError, type PinnedSourceControlConnection } from './source-control-connections.js';
import type { SourceControlRepository } from './task-change-requests.js';
import { object, words, githubGraphql } from './task-change-request-data.js';
import type { ChangeRequestStack, StackActionSubmission } from './task-change-request-stack-types.js';

const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export function decodeStack(raw: unknown): ChangeRequestStack | null {
  if (!Array.isArray(raw)) throw new Error('GitHub 堆叠数据无效');
  if (!raw.length) return null;
  const v = object(raw[0]), base = typeof v.base === 'string' ? v.base : object(v.base).ref;
  if (v.id != null && typeof v.id !== 'string' && !Number.isSafeInteger(v.id) || v.node_id != null && typeof v.node_id !== 'string') throw new Error('GitHub 堆叠数据无效');
  if (!positive(v.number) || typeof base !== 'string' || !base || typeof v.url !== 'string' || !Array.isArray(v.pull_requests)) throw new Error('GitHub 堆叠数据无效');
  const layers: ChangeRequestStack['layers'] = v.pull_requests.map((value: unknown) => {
    const layer = object(value), head = object(layer.head);
    if (!positive(layer.number) || typeof head.ref !== 'string' || !head.ref || layer.state != null && typeof layer.state !== 'string' || layer.title !== undefined && typeof layer.title !== 'string' || layer.draft !== undefined && typeof layer.draft !== 'boolean' || layer.merged_at != null && typeof layer.merged_at !== 'string' || head.sha !== undefined && typeof head.sha !== 'string') throw new Error('GitHub 堆叠层数据无效');
    return { number: layer.number, headBranch: head.ref, state: typeof layer.merged_at === 'string' && layer.merged_at.trim() || layer.state?.trim().toUpperCase() === 'MERGED' ? 'merged' : layer.state?.trim().toUpperCase() === 'CLOSED' ? 'closed' : 'open',
      ...(typeof layer.title === 'string' ? { title: layer.title } : {}), ...(typeof layer.draft === 'boolean' ? { isDraft: layer.draft } : {}), ...(head.sha ? { headSha: head.sha } : {}) };
  });
  if (new Set(layers.map(l => l.number)).size !== layers.length) throw new Error('GitHub 堆叠层重复');
  return { id: v.id == null ? words(v.node_id).trim() || String(v.number) : String(v.id), number: v.number, url: typeof v.html_url === 'string' && v.html_url.trim() ? v.html_url.trim() : v.url, base, layers };
}
export async function readStack(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal, details = true) {
  if (p.additional) return p.additional.stack(number, signal);
  if (r.provider !== 'github') return null;
  try {
    let stack = decodeStack(await p.array(`repos/${r.path}/stacks?pull_request=${number}`, { signal, maxResponseBytes: 8 * 1024 * 1024 }));
    if (stack && details) stack = decodeStack([await p.json(`repos/${r.path}/stacks/${stack.number}`, { signal, maxResponseBytes: 8 * 1024 * 1024 })]);
    if (stack && !stack.layers.some(l => l.number === number)) throw new Error('GitHub 堆叠成员已改变，请刷新');
    return stack;
  } catch (error) { if (error instanceof SourceControlHTTPError && error.status === 404) return null; throw error; }
}
export function stackSubmission(raw: unknown): StackActionSubmission {
  const v = object(raw);
  if (typeof v.requestId !== 'string' || !/^[\w-]{1,100}$/.test(v.requestId) || ['__proto__', 'constructor', 'prototype'].includes(v.requestId)
    || typeof v.url !== 'string' || v.url.length > 4096 || !['merge', 'update-branch'].includes(v.action) || !positive(v.stackNumber) || !positive(v.targetNumber)
    || !Array.isArray(v.expectedStackHeads) || !v.expectedStackHeads.length || v.expectedStackHeads.some((h: any) => !positive(h?.number) || typeof h.headSha !== 'string' || !/^[a-f\d]{4,64}$/i.test(h.headSha))
    || new Set(v.expectedStackHeads.map((h: any) => h.number)).size !== v.expectedStackHeads.length
    || v.mergeMethod !== undefined && !['merge', 'squash', 'rebase'].includes(v.mergeMethod) || v.updateMethod !== undefined && v.updateMethod !== 'rebase') throw new Error('堆叠 PR 操作格式无效');
  return { requestId: v.requestId, url: v.url, action: v.action, stackNumber: v.stackNumber, targetNumber: v.targetNumber, expectedStackHeads: v.expectedStackHeads.map((h: any) => ({ number: h.number, headSha: h.headSha })), ...(v.mergeMethod ? { mergeMethod: v.mergeMethod } : {}), ...(v.action === 'update-branch' ? { updateMethod: 'rebase' } : {}) };
}
export function affectedStack(stack: ChangeRequestStack | null, input: StackActionSubmission) {
  const at = stack?.layers.findIndex(l => l.number === input.targetNumber) ?? -1;
  if (!stack || stack.number !== input.stackNumber || at < 0 || input.action === 'update-branch' && at !== stack.layers.length - 1) throw new Error('堆叠 PR 已改变，请刷新后重新确认');
  const layers = (input.action === 'merge' ? stack.layers.slice(0, at + 1) : stack.layers).filter(l => l.state !== 'merged');
  if (!layers.length || layers.some(l => l.state !== 'open') || input.action === 'merge' && (stack.layers[at].state !== 'open' || layers.some(l => l.isDraft))) throw new Error('堆叠中的所有操作层必须开放，合并前须退出草稿');
  if (layers.length !== input.expectedStackHeads.length || layers.some(l => !l.headSha || !/^[a-f\d]{4,64}$/i.test(l.headSha) || !input.expectedStackHeads.some(h => h.number === l.number && h.headSha === l.headSha))) throw new Error('堆叠 PR 的代码版本已改变，请刷新后重新确认');
  return layers;
}
export async function stackBranchAccess(p: PinnedSourceControlConnection, r: SourceControlRepository, stack: ChangeRequestStack, input: StackActionSubmission, signal?: AbortSignal) {
  const layers = affectedStack(stack, input), variables: Record<string, unknown> = { owner: r.owner, name: r.name };
  layers.forEach((l, i) => { variables['n' + i] = l.number; });
  const result = await githubGraphql(p, `query FridayStackBranchAccess($owner:String!,$name:String!${layers.map((_, i) => `,$n${i}:Int!`).join('')}){repository(owner:$owner,name:$name){${layers.map((_, i) => `l${i}:pullRequest(number:$n${i}){headRepository{viewerPermission} maintainerCanModify}`).join(' ')}}}`, variables, signal);
  if (layers.some((_, i) => { const pr = object(object(result.repository)['l' + i]); return !pr.headRepository || pr.maintainerCanModify !== true && !['WRITE', 'MAINTAIN', 'ADMIN'].includes(object(pr.headRepository).viewerPermission); })) throw new Error('没有更新堆叠中所有源分支的权限');
}
