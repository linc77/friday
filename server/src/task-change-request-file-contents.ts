// Revision semantics and the 1 MiB full-text limit follow T3 Code 8cd9641f's
// getPullRequestDiffFileContents / getMergeRequestDiffFileContents providers.
import { extname } from 'node:path';
import type { PinnedSourceControlConnection } from './source-control-connections.js';
import type { SourceControlRepository } from './task-change-requests.js';
import { normalizeTaskChangeRequest } from './task-change-requests.js';
import { changeRequestFiles, changeRequestPath, object, words, type ChangeRequestFile } from './task-change-request-data.js';
import { changeRequestCommitDiff, changeRequestCommits } from './task-change-request-timeline.js';
import { changeRequestDiffSlice, diffCursor } from './task-change-request-diff.js';

export type ChangeRequestFileContents = {
  path: string; side: 'old' | 'new'; revision: string | null; requestHeadSha: string; scopeCommit: string | null;
  kind: 'text' | 'image' | 'absent' | 'unavailable'; mimeType: string; byteLength: number;
  requestBaseSha?: string;
  text?: string; base64?: string; reason?: 'oversized' | 'binary' | 'symlink';
};
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{40,64}$/i.test(value);
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const maxText = 1024 * 1024, maxImage = 4 * 1024 * 1024;
export function changeRequestFilePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw) || raw.startsWith('/') || raw.includes('\\') || raw.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new Error('PR／MR 文件路径无效');
  return raw;
}
function head(raw: Record<string, any>, r: SourceControlRepository) { return words(r.provider === 'github' ? object(raw.head).sha : r.provider === 'gitlab' ? raw.sha ?? object(raw.diff_refs).head_sha : object(object(raw.source).commit).hash, 64); }
function base(raw: Record<string, any>, r: SourceControlRepository) { return words(r.provider === 'github' ? object(raw.base).sha : r.provider === 'gitlab' ? object(raw.diff_refs).base_sha : object(object(raw.destination).commit).hash, 64); }
async function commitBase(p: PinnedSourceControlConnection, r: SourceControlRepository, commit: string, signal?: AbortSignal) {
  const path = r.provider === 'github' ? `repos/${r.path}/commits/${commit}` : r.provider === 'gitlab' ? `projects/${encodeURIComponent(r.path)}/repository/commits/${commit}` : `repositories/${r.path}/commit/${commit}`;
  const value = await p.json(path, { signal });
  if ((value.sha ?? value.id ?? value.hash) !== commit) throw new Error('平台返回的提交版本不一致');
  const parents = r.provider === 'gitlab' ? value.parent_ids : value.parents;
  if (!Array.isArray(parents)) throw new Error('平台未返回可确认的父提交');
  if (!parents.length) return null;
  const parent = r.provider === 'gitlab' ? parents[0] : object(parents[0])[r.provider === 'github' ? 'sha' : 'hash'];
  if (!sha(parent)) throw new Error('平台返回的父提交无效'); return parent;
}
export function changeRequestFileBytes(raw: Record<string, any>, limit: number, expectedPath: string): { data?: Buffer; size: number; reason?: 'oversized' | 'symlink' } {
  if (raw.type === 'symlink' || raw.type === 'submodule' || raw.submodule_git_url) return { size: 0, reason: 'symlink' };
  if (raw.path !== undefined && raw.path !== expectedPath || raw.file_path !== undefined && raw.file_path !== expectedPath) throw new Error('平台返回的文件路径不一致');
  if (!Number.isSafeInteger(raw.size) || raw.size < 0) throw new Error('平台返回的文件大小无效');
  if (raw.size > limit) return { size: raw.size, reason: 'oversized' };
  if (raw.encoding !== 'base64' || typeof raw.content !== 'string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(raw.content)) throw new Error('平台未返回可读取的文件内容');
  const clean = raw.content.replace(/[\r\n]/g, ''); const data = Buffer.from(clean, 'base64');
  if (data.length !== raw.size || data.toString('base64') !== clean) throw new Error('平台返回的文件内容不完整');
  return { data, size: data.length };
}
export async function changeRequestFileContents(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, input: { path: unknown; head: unknown; side: unknown; commit?: unknown; cursor?: unknown; base?: unknown; slice?: unknown }, signal?: AbortSignal): Promise<ChangeRequestFileContents> {
  if (p.host !== r.host || p.provider !== r.provider) throw new Error('Source Control 连接与目标不一致');
  if (p.additional) return p.additional.fileContents(number, input, signal);
  const requestedPath = changeRequestFilePath(input.path);
  if (!sha(input.head) || input.side !== 'old' && input.side !== 'new' || input.commit !== undefined && !sha(input.commit) || input.base !== undefined && !sha(input.base) || input.slice !== undefined && input.slice !== true) throw new Error('文件版本或审查范围无效');
  if (input.cursor !== undefined) diffCursor(input.cursor);
  if (p.host !== r.host || p.provider !== r.provider) throw new Error('Source Control 连接与目标不一致');
  const expectedHead = input.head.toLowerCase(), scopeCommit = typeof input.commit === 'string' ? input.commit.toLowerCase() : undefined, requestPath = changeRequestPath(r, number);
  const before = await p.json(requestPath, { signal });
  if (normalizeTaskChangeRequest(r, before).number !== number) throw new Error('平台返回的 PR／MR 不一致');
  if (head(before, r) !== expectedHead) throw new Error('PR／MR 的代码版本已改变，请刷新详情');
  if (input.base !== undefined && base(before, r) !== input.base) throw new Error('PR／MR 的 Diff 基准已改变，请刷新详情');
  let files: ChangeRequestFile[], revision: string | null;
  if (input.slice === true || input.cursor !== undefined) {
    const diff = await changeRequestDiffSlice(p, r, number, { head: expectedHead, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}), ...(scopeCommit ? { commit: scopeCommit } : {}), ...(input.base ? { base: input.base } : {}) }, signal); files = diff.files;
    revision = input.side === 'new' ? scopeCommit ?? expectedHead : scopeCommit ? await commitBase(p, r, scopeCommit, signal) : diff.baseSha ?? null;
  } else if (scopeCommit) {
    const diff = await changeRequestCommitDiff(p, r, number, scopeCommit, signal); files = diff.files;
    revision = input.side === 'new' ? scopeCommit : await commitBase(p, r, scopeCommit, signal);
  } else {
    const diff = await changeRequestFiles(p, r, number, expectedHead, signal); files = diff.files;
    revision = input.side === 'new' ? expectedHead : diff.baseSha ?? null;
  }
  const file = files.find(f => f.path === requestedPath);
  if (!file) throw new Error('该文件不在当前 PR／MR 的所选 Diff 中');
  const absent = input.side === 'old' && ['added', 'add', 'new'].includes(file.status) || input.side === 'new' && ['removed', 'deleted', 'delete'].includes(file.status);
  const path = changeRequestFilePath(input.side === 'old' ? file.oldPath || file.path : file.path);
  const common = { path, side: input.side as 'old' | 'new', revision: absent ? null : revision, requestHeadSha: expectedHead, ...(base(before, r) ? { requestBaseSha: base(before, r) } : {}), scopeCommit: scopeCommit ?? null };
  let result: ChangeRequestFileContents;
  if (absent) result = { ...common, kind: 'absent', mimeType: 'text/plain', byteLength: 0, text: '' };
  else {
    if (!revision || !sha(revision)) throw new Error('平台没有可确认的文件版本');
    const mimeType = imageTypes[extname(path).toLowerCase()] ?? 'text/plain'; const limit = mimeType.startsWith('image/') ? maxImage : maxText;
    let content: ReturnType<typeof changeRequestFileBytes>;
    if (r.provider === 'bitbucket') {
      if (!p.bytes) throw new Error('此连接不支持完整文件读取');
      const data = Buffer.from(await p.bytes(`repositories/${r.path}/src/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`, { signal, maxResponseBytes: maxImage + 1 }));
      content = data.length > limit ? { size: data.length, reason: 'oversized' } : { data, size: data.length };
    } else {
      const endpoint = r.provider === 'github' ? `repos/${r.path}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${revision}` : `projects/${encodeURIComponent(r.path)}/repository/files/${encodeURIComponent(path)}?ref=${revision}`;
      let value = await p.json(endpoint, { signal, maxResponseBytes: 6 * 1024 * 1024 });
      if (r.provider === 'github' && value.type === 'file' && value.encoding === 'none' && Number.isSafeInteger(value.size) && Number(value.size) <= limit && sha(value.sha)) {
        if (value.path !== path) throw new Error('平台返回的文件路径不一致');
        const blob = await p.json(`repos/${r.path}/git/blobs/${value.sha}`, { signal, maxResponseBytes: 6 * 1024 * 1024 });
        if (blob.sha !== value.sha || blob.size !== value.size) throw new Error('平台返回的文件版本不一致'); value = { ...blob, path };
      }
      content = changeRequestFileBytes(value, limit, path);
    }
    result = { ...common, kind: 'unavailable', mimeType, byteLength: content.size, ...(content.reason ? { reason: content.reason } : {}) };
    if (content.data) {
      if (mimeType.startsWith('image/')) result = { ...result, kind: 'image', base64: content.data.toString('base64') };
      else {
        try { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.data); if (text.includes('\0')) throw new Error(); result = { ...result, kind: 'text', text }; }
        catch { result.reason = 'binary'; }
      }
    }
  }
  const after = await p.json(requestPath, { signal });
  if (normalizeTaskChangeRequest(r, after).number !== number || head(after, r) !== expectedHead || base(after, r) !== base(before, r)) throw new Error('PR／MR 的代码版本已改变，请刷新详情');
  if (scopeCommit && !(await changeRequestCommits(p, r, number, signal)).commits.some(c => c.oid === scopeCommit)) throw new Error('所选提交已不在当前 PR／MR 的可见提交记录中');
  return result;
}
