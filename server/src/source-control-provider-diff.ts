import { additionalRepositoryPath } from './source-control-provider-identity.js';
import { parseDiffFilePaths } from './vendor/t3-diff-file-revisions.js';
import type { ChangeRequestDiffFile } from './task-change-request-diff.js';

/** Keep Git-quoted remote names intact, including legal control characters.
 * Remote paths do not grant access to the Friday service's local filesystem. */
export function additionalRawDiffFiles(patch:string):{files:ChangeRequestDiffFile[];truncated:boolean}{
  const files:ChangeRequestDiffFile[]=[];let truncated=false;
  for(const section of patch.split(/(?=^diff --git )/m)){
    if(!section.trim())continue;const paths=parseDiffFilePaths(section)[0],name=paths?.newPath??paths?.oldPath;
    if(!paths||!section.startsWith('diff --git ')){truncated=true;continue;}
    try{additionalRepositoryPath(name);if(paths.oldPath!==null)additionalRepositoryPath(paths.oldPath);}catch{truncated=true;continue;}
    const binary=section.includes('\0')||/(?:^Binary files .+ differ$|^GIT binary patch$)/m.test(section);let additions=0,deletions=0,hunk=false;
    for(const line of section.split('\n')){if(line.startsWith('@@'))hunk=true;else if(hunk&&line.startsWith('+'))additions++;else if(hunk&&line.startsWith('-'))deletions++;}
    files.push({path:name!,...(paths.oldPath&&paths.oldPath!==name?{oldPath:paths.oldPath}:{}),status:paths.oldPath===null?'added':paths.newPath===null?'removed':paths.oldPath!==paths.newPath?'renamed':'modified',additions,deletions,patch:section,unavailable:binary,...(binary?{omissionReason:'binary' as const}:{}),noHunks:!/^@@/m.test(section)});
  }return {files,truncated};
}
