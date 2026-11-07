import test from 'node:test';
import assert from 'node:assert/strict';
import { azureDevOpsFilePatch, azureDevOpsUnreadableFilePatch, formatAzureDevOpsDiffCursor, parseAzureDevOpsDiffCursor } from '../src/vendor/t3-azure-devops-diff.js';
import { parseDiffFilePaths } from '../src/vendor/t3-diff-file-revisions.js';
import type { AzureDevOpsChangeEntry } from '../src/vendor/t3-azure-devops-types.js';
const change=(extra:Partial<AzureDevOpsChangeEntry>={}):AzureDevOpsChangeEntry=>({path:'file.ts',oldPath:'file.ts',changeKind:'change',objectId:'a'.repeat(40),originalObjectId:'b'.repeat(40),...extra});
test('Azure iteration cursors bind an iteration and file offset, rejecting malformed or unsafe components',()=>{
  assert.deepEqual(parseAzureDevOpsDiffCursor(formatAzureDevOpsDiffCursor({iterationId:3,fileIndex:300})),{iterationId:3,fileIndex:300});
  for(const value of [undefined,null,'','1','0:0','1:-1','1:2:3','1:1.5','9007199254740992:1','1:Infinity'])assert.equal(parseAzureDevOpsDiffCursor(value),null);
});
test('Azure patches use context hunks, exact missing-newline markers and the new/deleted empty range rules',()=>{
  const updated=azureDevOpsFilePatch({change:change(),texts:{oldContents:'old\n',newContents:'new',binary:false}});assert(updated.section.includes('@@ -1 +1 @@'));assert(updated.section.includes('\\ No newline at end of file'));assert.equal(updated.truncated,false);
  const added=azureDevOpsFilePatch({change:change({changeKind:'new'}),texts:{oldContents:'',newContents:'new\n',binary:false}});assert(added.section.includes('--- /dev/null'));assert(added.section.includes('@@ -0,0 +1 @@'));
  const deleted=azureDevOpsFilePatch({change:change({changeKind:'deleted'}),texts:{oldContents:'old\n',newContents:'',binary:false}});assert(deleted.section.includes('+++ /dev/null'));assert(deleted.section.includes('@@ -1 +0,0 @@'));
});
test('Azure rename headers preserve Unicode, spaces and linebreaks in repository paths',()=>{
  const input=change({changeKind:'rename-pure',oldPath:'旧\t名.ts',path:'新\n名.ts'}),result=azureDevOpsFilePatch({change:input,texts:{oldContents:'same\n',newContents:'same\n',binary:false}}),paths=parseDiffFilePaths(result.section);
  assert.equal(paths[0].oldPath,input.oldPath);assert.equal(paths[0].newPath,input.path);assert(result.section.includes('rename from '));assert(!result.section.includes('@@'));
});
test('Azure binary, oversized and unreadable files stay listed with explicit omission rather than synthesized replacement text',()=>{
  for(const texts of [{oldContents:'old',newContents:'base64 bytes',binary:true},{oldContents:'a\0b',newContents:'text',binary:false},{oldContents:'a'.repeat(512*1024+1),newContents:'b',binary:false}]){
    const result=azureDevOpsFilePatch({change:change(),texts});assert.equal(result.truncated,true);assert(result.section.startsWith('diff --git '));assert(!result.section.includes('@@'));
  }
  const missing=azureDevOpsUnreadableFilePatch(change());assert(missing.truncated);assert(!missing.section.includes('@@'));
});
test('Azure edit-distance limits leave a retriable file entry instead of forcing an unbounded whole-file patch',()=>{
  const before=Array.from({length:1200},(_,index)=>'old-'+index).join('\n')+'\n',after=Array.from({length:1200},(_,index)=>'new-'+index).join('\n')+'\n';
  const result=azureDevOpsFilePatch({change:change(),texts:{oldContents:before,newContents:after,binary:false}});assert(result.abandoned);assert(result.truncated);assert(!result.section.includes('@@'));
});
