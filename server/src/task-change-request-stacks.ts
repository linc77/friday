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
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { pinTaskChangeRequest, readTaskChangeRequest, type SourceControlRepository } from './task-change-requests.js';
import { changeRequestDetail, object } from './task-change-request-data.js';
import { readStack, stackSubmission, affectedStack, stackBranchAccess } from './task-change-request-stack-data.js';
import type { ChangeRequestStack, SavedChangeRequestStack, StackActionSubmission } from './task-change-request-stack-types.js';
import type { ChangeRequestOperation } from './task-change-request-actions.js';
import type { Workspace } from './types.js';
const stamp = () => new Date().toISOString();
const active = (v: ChangeRequestOperation) => ['queued', 'running'].includes(v.status);
type Input = { taskId: string; id: string; repository: SourceControlRepository; fingerprint: string; submission: StackActionSubmission; stack: ChangeRequestStack };
type MergeReceipt = { status: 'pending' | 'merged' | 'enqueued' | 'failed'; uuid?: string; receivedAt: number };
const mergeReceipt = (raw: unknown): MergeReceipt => {
  const v = object(raw), details = object(v.details);
  if (!['pending', 'merged', 'enqueued', 'failed'].includes(v.status) || v.status === 'pending' && (typeof details.uuid !== 'string' || !details.uuid || details.uuid.length > 4096)) throw new Error('GitHub 堆叠合并回执无效，请在平台核对');
  return { status: v.status, ...(typeof details.uuid === 'string' ? { uuid: details.uuid } : {}), receivedAt: Date.now() };
};

export class TaskChangeRequestStacks {
  readonly definition;
  constructor(private engine: Engine) {
    this.definition = defineTask<Input, { phase: 'run'; index: number }, { status: string }, {}>({
      name: 'friday.change_request_stack', version: 1, initial: () => ({ phase: 'run', index: 0 }),
      phases: { run: async (task, runtime, ctx) => {
        const input = task.input, index = task.state.checkpoint.index, s = input.submission;
        const finish = async (status: ChangeRequestOperation['status'], error?: string) => {
          await this.invalidate(input);
          for (const layer of input.stack.layers) this.engine.changeRequestSync.request(input.taskId, `https://${input.repository.host}/${input.repository.path}/${input.repository.provider === 'gitcafe' ? 'pulls' : 'pull'}/${layer.number}`);
          await this.cleanup(input.id); await this.patch(input, { status, ...(error ? { error } : {}) });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        if (!(await engine.snapshot()).tasks.some(t => t.id === input.taskId)) { await finish('interrupted', '堆叠 PR 所属任务不存在'); return; }
        let writing = false;
        try {
          const p = await pinTaskChangeRequest(engine.directory, input.repository, engine.sourceControl, runtime.signal, input.fingerprint);
          await this.patch(input, { status: 'running' });
          await this.invalidate(input);
          if (p.additional) {
            if (await runtime.memo<boolean>('provider-effect-completed', ctx)) { await finish('completed'); return; }
            if (await runtime.memo<boolean>('provider-effect-started', ctx)) { await finish('interrupted', '堆叠操作结果尚未确认，请在平台核对；不会自动重发'); return; }
            affectedStack(await readStack(p, input.repository, s.targetNumber, runtime.signal), s);
            const effects = await p.additional.stackEffects(s.targetNumber, s, runtime.signal);
            if (effects.length !== 1) throw new Error('平台堆叠操作回执无效');
            await runtime.memo('provider-effect-started', true, ctx); writing = true;
            await effects[0]!.run(runtime.signal);
            await runtime.memo('provider-effect-completed', true, ctx); writing = false;
            await this.effect(input, effects[0]!.key); await finish('completed'); return;
          }
          if (s.action === 'merge') {
            let response = await runtime.memo<MergeReceipt>('merge-response', ctx);
            if (!response) {
              if (await runtime.memo<boolean>('merge-started', ctx)) { await finish('interrupted', '堆叠合并结果未确认，请在平台核对；不会自动重发'); return; }
              const fresh = await readStack(p, input.repository, s.targetNumber, runtime.signal, false); affectedStack(fresh, s);
              const detail = await changeRequestDetail(p, input.repository, s.targetNumber, runtime.signal, { checks: false });
              if (!detail.actions.includes('merge') || !detail.mergeMethods.includes(s.mergeMethod ?? 'merge')) throw new Error('当前账号或仓库不支持此堆叠合并方式');
              await runtime.memo('merge-started', true, ctx); writing = true;
              response = mergeReceipt(await p.json(`repos/${input.repository.path}/pulls/${s.targetNumber}/merge-async`, { method: 'PUT', body: { merge_method: s.mergeMethod ?? 'merge', merge_action: 'default', sha: s.expectedStackHeads.find(h => h.number === s.targetNumber)!.headSha }, signal: runtime.signal }));
              await runtime.memo('merge-response', response, ctx); writing = false;
              await this.effect(input, 'stack-merge-request');
            }
            const deadline = response.receivedAt + 5 * 60_000; let result = response;
            for (let attempt = 0; result.status === 'pending' && Date.now() < deadline; attempt++) {
              await delay(Math.min(1000 * 2 ** attempt, 10000), undefined, { signal: runtime.signal });
              result = mergeReceipt(await p.json(`repos/${input.repository.path}/pulls/${s.targetNumber}/merge-async/${encodeURIComponent(result.uuid!)}`, { signal: runtime.signal }));
            }
            if (result.status === 'pending') { await finish('interrupted', 'GitHub 仍在处理堆叠合并，请先在平台核对再提交其他请求'); return; }
            if (result.status === 'failed') { await finish('failed', 'GitHub 拒绝堆叠合并，请检查分支规则和合并要求'); return; }
            await this.effect(input, result.status === 'enqueued' ? 'stack-merge-enqueued' : 'stack-merged');
            await finish('completed'); return;
          }
          const layers = affectedStack(input.stack, s), layer = layers[index];
          if (!layer) { await finish('completed'); return; }
          const key = 'layer-' + layer.number;
          const completed = await runtime.memo<{ headSha: string }>(key + '-pushed', ctx);
          if (completed) {
            await this.effect(input, key); await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'run', index: index + 1 } }), ctx); return;
          }
          if (await runtime.memo<boolean>(key + '-push-started', ctx)) { await finish('interrupted', `PR #${layer.number} 推送结果未确认，之前的更新保留；不会自动重发`); return; }
          const path = await this.checkout(input.id), git = async (args: string[], allowFailure = false) => {
            if (!p.repositoryGit) throw new Error('GitHub 连接不支持堆叠变基');
            return p.repositoryGit(path, input.repository.path, args, { signal: runtime.signal, allowFailure });
          };
          let prepared = await runtime.memo<{ base: string }>('checkout', ctx);
          if (!prepared) {
            const fresh = await readStack(p, input.repository, s.targetNumber, runtime.signal, false); affectedStack(fresh, s);
            if (fresh!.base !== input.stack.base || fresh!.layers.length !== input.stack.layers.length || fresh!.layers.some((l, i) => l.number !== input.stack.layers[i].number || l.headBranch !== input.stack.layers[i].headBranch)) throw new Error('堆叠分支关系已改变，请刷新后重新确认');
            await stackBranchAccess(p, input.repository, input.stack, s, runtime.signal);
            for (const branch of [input.stack.base, ...layers.map(l => l.headBranch)]) { await git(['check-ref-format', '--branch', branch]); if (branch.startsWith('+') || branch.includes(':')) throw new Error('堆叠分支名称无效'); }
            if (layers.some(l => l.headBranch === input.stack.base) || new Set(layers.map(l => l.headBranch)).size !== layers.length) throw new Error('堆叠源分支与基线重复');
            await git(['init', '--quiet']); await git(['remote', 'add', 'origin', `https://${input.repository.host}/${input.repository.path}.git`]);
            await git(['fetch', '--quiet', '--no-tags', `https://${input.repository.host}/${input.repository.path}.git`, `+refs/heads/${input.stack.base}:refs/remotes/origin/${input.stack.base}`, ...layers.map(l => `+refs/heads/${l.headBranch}:refs/remotes/origin/${l.headBranch}`)]);
            for (const l of layers) if ((await git(['rev-parse', '--verify', `refs/remotes/origin/${l.headBranch}^{commit}`])).stdout.trim().toLowerCase().startsWith(l.headSha!.toLowerCase()) === false) throw new Error('堆叠远端源分支已改变，请刷新');
            prepared = { base: (await git(['rev-parse', '--verify', `refs/remotes/origin/${input.stack.base}^{commit}`])).stdout.trim() };
            await runtime.memo('checkout', prepared, ctx);
          }
          let rebased = await runtime.memo<string>(key + '-rebased', ctx);
          if (!rebased) {
            const previous = index ? await runtime.memo<{ headSha: string }>('layer-' + layers[index - 1].number + '-pushed', ctx) : undefined;
            if (index && !previous) throw new Error('前一层变基回执不存在，请核对平台');
            const parentOld = index ? layers[index - 1].headSha! : prepared.base, parentNew = previous?.headSha ?? prepared.base;
            const upstream = index ? parentOld : (await git(['merge-base', parentOld, layer.headSha!])).stdout.trim();
            await git(['checkout', '--quiet', '--detach', layer.headSha!]);
            if ((await git(['rebase', '--quiet', '--onto', parentNew, upstream], true)).code !== 0) { await git(['rebase', '--abort'], true); throw new Error(`PR #${layer.number} 与下层冲突，已完成 ${index} 层；之前的远端更新保留，请解决后重新确认`); }
            rebased = (await git(['rev-parse', 'HEAD'])).stdout.trim();
            if (!/^[a-f\d]{40,64}$/.test(rebased)) throw new Error('堆叠变基结果无效');
            await runtime.memo(key + '-rebased', rebased, ctx);
          }
          // Re-pin before each push; never repeat an uncertain external write.
          if (rebased !== layer.headSha) {
            const writer = await pinTaskChangeRequest(engine.directory, input.repository, engine.sourceControl, runtime.signal, input.fingerprint);
            await runtime.memo(key + '-push-started', true, ctx); writing = true;
            await writer.repositoryGit!(path, input.repository.path, ['push', '--quiet', `--force-with-lease=refs/heads/${layer.headBranch}:${layer.headSha}`, `https://${input.repository.host}/${input.repository.path}.git`, `${rebased}:refs/heads/${layer.headBranch}`], { signal: runtime.signal });
          }
          await runtime.memo(key + '-pushed', { headSha: rebased }, ctx); writing = false;
          await this.effect(input, key); await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'run', index: index + 1 } }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await finish(writing ? 'interrupted' : 'failed', writing ? '堆叠操作结果未确认，之前的更新保留；请在平台核对，不会自动重发' : error instanceof Error ? error.message : '堆叠操作失败');
        }
      } },
      abort: async (task, runtime, ctx) => {
        await this.invalidate(task.input);
        await this.cleanup(task.input.id); await this.patch(task.input, { status: 'interrupted', error: '堆叠操作已中断，之前的更新保留；请核对平台，不会自动重复写入' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }
  private async checkout(id: string) {
    const parent = join(this.engine.directory, 'stack-checkouts'); await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== join(await realpath(this.engine.directory), 'stack-checkouts')) throw new Error('堆叠临时目录无效');
    const path = join(parent, id); await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink()) throw new Error('堆叠临时目录无效'); return path;
  }
  private async invalidate(input: Input) { for (const layer of input.stack.layers) await this.engine.changeRequests.invalidateReference(input.repository, layer.number); }
  private async cleanup(id: string) {
    if (!/^[\w-]{36}$/.test(id)) return;
    const parent = join(this.engine.directory, 'stack-checkouts');
    try { if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== join(await realpath(this.engine.directory), 'stack-checkouts')) return; await rm(join(parent, id), { recursive: true, force: true }); } catch {}
  }
  private patch(input: Pick<Input, 'taskId' | 'id'>, change: Partial<ChangeRequestOperation>) { return this.engine.mutate(state => { const op = state.tasks.find(t => t.id === input.taskId)?.changeRequestOperations?.find(o => o.id === input.id); if (op) Object.assign(op, change, { updatedAt: stamp() }); }); }
  private effect(input: Input, key: string) { return this.engine.mutate(state => { const op = state.tasks.find(t => t.id === input.taskId)?.changeRequestOperations?.find(o => o.id === input.id); if (op && !op.completedEffects.includes(key)) { op.completedEffects.push(key); op.updatedAt = stamp(); } }); }
  async get(id: string, url: unknown, signal?: AbortSignal, cache = false) {
    const target = cache ? undefined : await this.engine.changeRequests.target(id, url, signal);
    const stack = target ? await readStack(target.pinned, target.repository, target.number, signal) : await this.engine.changeRequests.stack(id, url, signal);
    const saved: SavedChangeRequestStack | null = stack ? { ...stack, layers: stack.layers.map(({ headSha: _, ...layer }) => layer), syncedAt: stamp() } : null;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), task = state.tasks.find(t => t.id === id); if (!task) return;
      const previous = task.changeRequestStacks?.[String(url)];
      if (JSON.stringify(previous ? { ...previous, syncedAt: undefined } : null) === JSON.stringify(saved ? { ...saved, syncedAt: undefined } : null)) return;
      task.changeRequestStacks = Object.fromEntries([...Object.entries(task.changeRequestStacks ?? {}).filter(([key]) => key !== url), [String(url), saved]]); state.revision++;
    }, context);
    return { stack };
  }
  async open(id: string, raw: unknown) {
    const v = object(raw); if (!Number.isSafeInteger(v.number) || v.number < 1 || !Number.isSafeInteger(v.stackNumber)) throw new Error('堆叠导航目标无效');
    const target = await this.engine.changeRequests.target(id, v.url), stack = await readStack(target.pinned, target.repository, target.number);
    if (!stack || stack.number !== v.stackNumber || !stack.layers.some(l => l.number === v.number)) throw new Error('堆叠成员已改变，请刷新');
    await this.get(id, v.url);
    const pr = await readTaskChangeRequest(target.pinned, target.repository, v.number);
    await this.engine.changeRequestLinks.open(id, { reference: pr.url }, undefined, target.pinned.fingerprint);
    return { url: pr.url };
  }
  async start(id: string, raw: unknown) {
    const s = stackSubmission(raw), digest = createHash('sha256').update(JSON.stringify(s)).digest('hex');
    const receipt = (state: Workspace) => { const saved = state.changeRequestRequests?.[s.requestId]; if (saved && (saved.taskId !== id || saved.digest !== digest)) throw new Error('PR／MR 请求 ID 已用于不同操作'); return saved; };
    const existing = receipt(await this.engine.snapshot()); if (existing) return existing.operationId;
    const target = await this.engine.changeRequests.target(id, s.url);
    if (target.repository.provider !== 'github' && target.repository.provider !== 'gitcafe') throw new Error('此平台不支持堆叠 PR 操作');
    const stack = await readStack(target.pinned, target.repository, target.number); affectedStack(stack, s);
    const detail = await changeRequestDetail(target.pinned, target.repository, s.targetNumber, undefined, { checks: false });
    if (s.action === 'merge' ? !detail.actions.includes('merge') || !detail.mergeMethods.includes(s.mergeMethod ?? 'merge') : detail.stackRebase !== true) throw new Error('当前账号不支持这项堆叠操作');
    if (s.action === 'update-branch' && !target.pinned.additional) await stackBranchAccess(target.pinned, target.repository, stack!, s);
    const operationId = randomUUID(), urls = stack!.layers.map(l => `https://${target.repository.host}/${target.repository.path}/${target.repository.provider === 'gitcafe' ? 'pulls' : 'pull'}/${l.number}`);
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); if (receipt(state)) return;
      if (state.tasks.some(t => t.changeRequestOperations?.some(op => active(op) && (op.stackURLs ?? [op.url]).some(url => urls.some(candidate => candidate.toLowerCase() === url.toLowerCase()))))) throw new Error('堆叠中的 PR 已有操作正在发送，请等待完成');
      const task = state.tasks.find(t => t.id === id); if (!task) throw new Error('本地任务不存在');
      const durableId = await tx.createTask(this.definition, { taskId: id, id: operationId, repository: target.repository, fingerprint: target.pinned.fingerprint, submission: s, stack: stack! }, { ownership: { kind: 'conversation' } });
      task.changeRequestOperations = [...(task.changeRequestOperations ?? []).filter(active), ...(task.changeRequestOperations ?? []).filter(v => !active(v)).slice(-39), { id: operationId, durableId, url: s.url, stackURLs: urls, stackNumber: s.stackNumber, action: s.action, status: 'queued', createdAt: stamp(), updatedAt: stamp(), completedEffects: [] }];
      state.changeRequestRequests ??= {}; state.changeRequestRequests[s.requestId] = { taskId: id, operationId, digest }; state.revision++;
    }, context);
    this.engine.harness.resume(); return receipt(await this.engine.snapshot())!.operationId;
  }
}
