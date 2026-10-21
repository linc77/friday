// Slice and omission semantics follow T3 Code 8cd9641f's getDiff providers.
import type { PinnedSourceControlConnection, JsonOptions } from './source-control-connections.js';
import { SourceControlHTTPError, SourceControlResponseTooLarge } from './source-control-connections.js';
import { normalizeTaskChangeRequest, type SourceControlRepository } from './task-change-requests.js';
import { changeRequestPath, object, type ChangeRequestFile } from './task-change-request-data.js';
import { changeRequestCommits } from './task-change-request-timeline.js';
import { parseDiffFilePaths } from './vendor/t3-diff-file-revisions.js';

export type DiffOmission = 'binary' | 'too_large' | 'collapsed' | 'host_omitted';
export type ChangeRequestDiffFile = ChangeRequestFile & { omissionReason?: DiffOmission; noHunks?: boolean; diffCursor?: string };
export type ChangeRequestDiffSlice = { headSha: string; requestHeadSha: string; baseSha?: string; scopeCommit: string | null; cursor: string | null; nextCursor: string | null; files: ChangeRequestDiffFile[]; truncated: boolean; omittedFileStats: { path: string; additions: number; deletions: number }[] };
const oid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40,64}$/i.test(v);
const size = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : undefined;
const quote = (v: string) => /[\s"\\]/.test(v) ? JSON.stringify(v) : v;
const path = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v) && !v.startsWith('/') && !v.split('/').some(s => !s || s === '.' || s === '..' || s.toLowerCase() === '.git');
export function diffCursor(v: unknown): number {
  if (v === undefined || v === null) return 1;
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,6}$/.test(v)) throw new Error('Diff 分页游标无效'); return Number(v);
}
function stats(patch: string) {
  let additions = 0, deletions = 0, hunk = false;
  for (const line of patch.split('\n')) { if (line.startsWith('@@')) hunk = true; else if (hunk && line.startsWith('+')) additions++; else if (hunk && line.startsWith('-')) deletions++; }
  return { additions, deletions };
}
export function rawDiffFiles(patch: string): { files: ChangeRequestDiffFile[]; truncated: boolean } {
  const files: ChangeRequestDiffFile[] = []; let truncated = false;
  if (!patch.trim()) return { files, truncated };
  for (const section of patch.replace(/^\uFEFF/, '').split(/(?=^diff --git )/m)) {
    if (!section.trim()) continue;
    const paths = parseDiffFilePaths(section)[0], name = paths?.newPath ?? paths?.oldPath;
    if (!paths || !section.startsWith('diff --git ') || !path(name) || paths.oldPath !== null && !path(paths.oldPath)) { truncated = true; continue; }
    const binary = section.includes('\0') || /(?:^Binary files .+ differ$|^GIT binary patch$)/m.test(section);
    files.push({ path: name, ...(paths.oldPath && paths.oldPath !== name ? { oldPath: paths.oldPath } : {}), status: paths.oldPath === null ? 'added' : paths.newPath === null ? 'removed' : paths.oldPath !== paths.newPath ? 'renamed' : 'modified', ...stats(section), patch: section, unavailable: binary, ...(binary ? { omissionReason: 'binary' } : {}), noHunks: !/^@@/m.test(section) });
  }
  return { files, truncated };
}
export function diffPageFiles(provider: SourceControlRepository['provider'], entries: unknown[], cursor: string, patch?: string) {
  const files: ChangeRequestDiffFile[] = [], omittedFileStats: ChangeRequestDiffSlice['omittedFileStats'] = []; let truncated = false;
  const raw = patch === undefined ? undefined : rawDiffFiles(patch); const byPath = new Map(raw?.files.map(f => [f.path, f]));
  truncated ||= raw?.truncated ?? false;
  for (const entry of entries) {
    const v = object(entry), name = v.filename ?? v.new_path ?? object(v.new).path ?? object(v.old).path, previous = v.previous_filename ?? v.old_path ?? object(v.old).path;
    if (!path(name) || previous !== undefined && previous !== null && !path(previous)) { truncated = true; continue; }
    const status = typeof v.status === 'string' ? v.status.trim().toLowerCase() : v.new_file ? 'added' : v.deleted_file ? 'removed' : v.renamed_file ? 'renamed' : 'modified';
    const oldPath = previous && previous !== name ? previous : undefined;
    const hunks = provider === 'bitbucket' ? byPath.get(name)?.patch ?? '' : typeof (v.patch ?? v.diff) === 'string' ? v.patch ?? v.diff : '';
    const counted = stats(hunks), additions = size(v.additions ?? v.lines_added) ?? counted.additions, deletions = size(v.deletions ?? v.lines_removed) ?? counted.deletions;
    const reason: DiffOmission | undefined = !hunks && v.too_large === true ? 'too_large' : !hunks && v.collapsed === true ? 'collapsed' : hunks.includes('\0') || /(?:^Binary files .+ differ$|^GIT binary patch$)/m.test(hunks) ? 'binary' : !hunks && additions + deletions > 0 ? 'host_omitted' : undefined;
    if (!hunks && reason) { truncated = true; omittedFileStats.push({ path: name, additions, deletions }); }
    const removed = ['removed','deleted'].includes(status), added = ['added','new'].includes(status), renamed = ['renamed','rename'].includes(status);
    const header = [`diff --git ${quote('a/' + (oldPath ?? name))} ${quote('b/' + name)}`, ...(added ? ['new file mode 100644'] : []), ...(removed ? ['deleted file mode 100644'] : []), ...(renamed ? [`rename from ${quote(oldPath ?? name)}`, `rename to ${quote(name)}`] : []), `--- ${removed || !added ? quote('a/' + (oldPath ?? name)) : '/dev/null'}`, `+++ ${removed ? '/dev/null' : quote('b/' + name)}`].join('\n');
    files.push({ path: name, ...(oldPath ? { oldPath } : {}), status, additions, deletions, patch: hunks.startsWith('diff --git ') ? hunks : header + '\n' + hunks, unavailable: reason !== undefined, ...(reason ? { omissionReason: reason } : {}), noHunks: !/^@@/m.test(hunks), diffCursor: cursor });
  }
  return { files, truncated, omittedFileStats };
}
const version = (v: Record<string, any>, r: SourceControlRepository) => ({ head: r.provider === 'github' ? object(v.head).sha : r.provider === 'gitlab' ? v.sha ?? object(v.diff_refs).head_sha : object(object(v.source).commit).hash, base: r.provider === 'github' ? object(v.base).sha : r.provider === 'gitlab' ? object(v.diff_refs).base_sha : object(object(v.destination).commit).hash });
export async function changeRequestDiffSlice(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, input: { head: unknown; base?: unknown; cursor?: unknown; commit?: unknown }, signal?: AbortSignal): Promise<ChangeRequestDiffSlice> {
  signal?.throwIfAborted();
  if (p.provider !== r.provider || p.host !== r.host) throw new Error('Source Control 连接与目标不一致');
  if (p.additional) return p.additional.diff(number, input, signal);
  const page = diffCursor(input.cursor);
  if (!oid(input.head) || input.base !== undefined && !oid(input.base) || input.commit !== undefined && !oid(input.commit)) throw new Error('Diff 版本或提交范围无效');
  if (p.provider !== r.provider || p.host !== r.host) throw new Error('Source Control 连接与目标不一致');
  const endpoint = changeRequestPath(r, number), before = await p.json(endpoint, { signal }), initial = version(before, r), identity = normalizeTaskChangeRequest(r, before);
  if (identity.number !== number || initial.head !== input.head || input.base !== undefined && initial.base !== input.base) throw new Error('PR／MR 的代码版本已改变，请刷新详情');
  const commit = typeof input.commit === 'string' ? input.commit : undefined;
  if (commit && !(await changeRequestCommits(p, r, number, signal)).commits.some(c => c.oid === commit)) throw new Error('所选提交已不在当前 PR／MR 的可见提交记录中');
  const common = { headSha: commit ?? input.head, requestHeadSha: input.head, ...(oid(initial.base) ? { baseSha: initial.base } : {}), scopeCommit: commit ?? null, cursor: typeof input.cursor === 'string' ? input.cursor : null };
  const options: JsonOptions = { signal, maxResponseBytes: 8 * 1024 * 1024, timeoutMs: 60_000 };
  let result: ChangeRequestDiffSlice | undefined, fallbackError: SourceControlHTTPError | undefined;
  if (r.provider === 'github' && !commit && input.cursor === undefined && p.text) {
    try {
      const patch = await p.text(endpoint, { ...options, accept: 'application/vnd.github.diff' });
      const decoded = rawDiffFiles(patch);
      if (!patch.trim() || decoded.files.length) result = { ...common, ...decoded, nextCursor: null, omittedFileStats: [] };
    } catch (error) { signal?.throwIfAborted(); if (!(error instanceof SourceControlHTTPError) && !(error instanceof SourceControlResponseTooLarge)) throw error; if (error instanceof SourceControlHTTPError) fallbackError = error; }
  }
  if (!result) {
    let entries: unknown[], more: boolean; let patch: string | undefined, legacyTruncated = false;
    const paging = `per_page=100&page=${page}`;
    try {
    if (r.provider === 'github' && commit) { const value = await p.json(`repos/${r.path}/commits/${commit}?${paging}`, options); if (value.sha !== commit || !Array.isArray(value.files)) throw new Error('平台返回的提交版本不一致'); entries = value.files; more = entries.length >= 100; }
    else if (r.provider === 'bitbucket') {
      const value = await p.json(commit ? `repositories/${r.path}/diffstat/${commit}?pagelen=100&page=${page}` : endpoint + `/diffstat?pagelen=100&page=${page}`, options);
      if (!Array.isArray(value.values)) throw new Error('平台返回的 Diff 文件页无效'); entries = value.values; more = typeof value.next === 'string';
      if (!p.text) throw new Error('Bitbucket 连接不支持 Diff'); patch = await p.text(commit ? `repositories/${r.path}/diff/${commit}` : endpoint + '/diff', options);
    } else {
      try { entries = await p.array(r.provider === 'github' ? endpoint + '/files?' + paging : commit ? `projects/${encodeURIComponent(r.path)}/repository/commits/${commit}/diff?${paging}` : endpoint + '/diffs?' + paging, options); more = entries.length >= 100; }
      catch (error) {
        signal?.throwIfAborted();
        if (r.provider !== 'gitlab' || commit || page !== 1 || !(error instanceof SourceControlHTTPError) || error.status !== 404) throw error;
        const legacy = await p.json(endpoint + '/changes', options); if (!Array.isArray(legacy.changes)) throw new Error('平台返回的 Diff 文件页无效'); entries = legacy.changes; more = false; legacyTruncated = legacy.overflow === true || typeof legacy.changes_count === 'string' && legacy.changes_count.endsWith('+');
      }
    }
    } catch (error) { signal?.throwIfAborted(); throw fallbackError ?? error; }
    result = { ...common, ...diffPageFiles(r.provider, entries, String(page), patch), nextCursor: more && page < 9_999_999 ? String(page + 1) : null };
    if (legacyTruncated || more && page === 9_999_999) result.truncated = true;
  }
  const after = await p.json(endpoint, { signal }), latest = version(after, r);
  if (latest.head !== initial.head || latest.base !== initial.base || normalizeTaskChangeRequest(r, after).url !== identity.url) throw new Error('PR／MR 的代码版本已改变，请刷新详情');
  if (commit && !(await changeRequestCommits(p, r, number, signal)).commits.some(c => c.oid === commit)) throw new Error('所选提交已不在当前 PR／MR 的可见提交记录中');
  return result;
}
