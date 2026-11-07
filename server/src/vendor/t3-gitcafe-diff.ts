/*
Adapted from T3 Code 8cd9641f packages/source-control-gitcafe/src/server/gitCafePullRequestJson.ts.
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
import { quoteGitPatchPath } from "./t3-git-patch-path.js";
export type GitCafeDiffFile = {
  path: string; oldPath?: string | null;
  status?: 'added' | 'deleted' | 'modified' | 'typeChanged' | 'conflicted' | 'renamed' | 'copied';
  additions?: number; deletions?: number; binary?: boolean; tooLarge?: boolean; hunksOmitted?: boolean;
  isSubmodule?: boolean; oldOid?: string; newOid?: string;
  hunks?: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: { origin: string; content: string }[] }[];
};

export function gitCafeDiffPatch(diff: { items: GitCafeDiffFile[]; truncated?: boolean }) {
  const chunks: Array<string> = [];
  const omittedFileStats: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const file of diff.items) {
    const oldPath = file.oldPath ?? file.path;
    const a = quoteGitPatchPath(`a/${oldPath}`);
    const b = quoteGitPatchPath(`b/${file.path}`);
    const before = file.status === "added" ? "/dev/null" : a;
    const after = file.status === "deleted" ? "/dev/null" : b;
    const mode = file.isSubmodule ? "160000" : "100644";
    const lines = [`diff --git ${a} ${b}`];
    if (file.status === "added") lines.push(`new file mode ${mode}`);
    if (file.status === "deleted") lines.push(`deleted file mode ${mode}`);
    if (file.status === "renamed" || file.status === "copied") {
      const action = file.status === "renamed" ? "rename" : "copy";
      lines.push(
        `${action} from ${quoteGitPatchPath(oldPath)}`,
        `${action} to ${quoteGitPatchPath(file.path)}`,
      );
    }
    if (file.binary) {
      lines.push(`Binary files ${before} and ${after} differ`);
    } else if (file.tooLarge || file.hunksOmitted) {
      omittedFileStats.push({
        path: file.path,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      });
    } else if (file.isSubmodule) {
      const hasOld = file.status !== "added" && file.oldOid !== undefined;
      const hasNew = file.status !== "deleted" && file.newOid !== undefined;
      lines.push(`--- ${before}`, `+++ ${after}`);
      lines.push(`@@ -${hasOld ? "1" : "0,0"} +${hasNew ? "1" : "0,0"} @@`);
      if (hasOld) lines.push(`-Subproject commit ${file.oldOid}`);
      if (hasNew) lines.push(`+Subproject commit ${file.newOid}`);
    } else {
      const hunks = file.hunks ?? [];
      if (hunks.length > 0) lines.push(`--- ${before}`, `+++ ${after}`);
      for (const hunk of hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        for (const line of hunk.lines) {
          // GitCafe marks a missing final newline with libgit2's own origins.
          if (["=", ">", "<"].includes(line.origin)) lines.push("\\ No newline at end of file");
          else lines.push(`${line.origin}${line.content.replace(/\n$/u, "")}`);
        }
      }
    }
    chunks.push(lines.join("\n"));
  }
  return {
    patch: chunks.length === 0 ? "" : `${chunks.join("\n")}\n`,
    truncated: diff.truncated === true || omittedFileStats.length > 0,
    nextCursor: null,
    ...(omittedFileStats.length === 0 ? {} : { omittedFileStats }),
  };
}
