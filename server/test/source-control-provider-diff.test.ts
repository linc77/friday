import test from 'node:test';
import assert from 'node:assert/strict';
import { additionalRawDiffFiles } from '../src/source-control-provider-diff.js';
import { additionalRepositoryPath } from '../src/source-control-provider-identity.js';
import { gitCafeDiffPatch } from '../src/vendor/t3-gitcafe-diff.js';
import { azureDevOpsFilePatch } from '../src/vendor/t3-azure-devops-diff.js';

test('Remote provider diffs preserve quoted Unicode, tabs, newlines and literal backslashes without treating them as local paths',()=>{
  const oldPath='旧\t名\\before.ts',path='新\n名.ts';
  const patch=azureDevOpsFilePatch({change:{path,oldPath,changeKind:'rename-changed',objectId:null,originalObjectId:null},texts:{oldContents:'old\n',newContents:'new\n',binary:false}});
  const result=additionalRawDiffFiles(patch.section);assert.equal(result.truncated,false);assert.equal(result.files[0].path,path);assert.equal(result.files[0].oldPath,oldPath);assert.equal(result.files[0].status,'renamed');assert.equal(result.files[0].additions,1);assert.equal(result.files[0].deletions,1);
  assert.equal(additionalRepositoryPath(oldPath),oldPath);
});
test('GitCafe JSON hunks retain exact path identity, submodules, missing-newline markers and omission metadata',()=>{
  const path='目录/含 空格\n文件.ts';const value=gitCafeDiffPatch({items:[{path,status:'added',hunks:[{oldStart:0,oldLines:0,newStart:1,newLines:1,lines:[{origin:'+',content:'new'},{origin:'>',content:''}]}]},{path:'module',isSubmodule:true,newOid:'a'.repeat(40),oldOid:'b'.repeat(40)},{path:'large',tooLarge:true,additions:100,deletions:20}]});
  const result=additionalRawDiffFiles(value.patch);assert.equal(result.files.length,3);assert.equal(result.files[0].path,path);assert(value.patch.includes('\\ No newline at end of file'));assert(value.patch.includes('Subproject commit '+ 'a'.repeat(40)));assert.deepEqual(value.omittedFileStats,[{path:'large',additions:100,deletions:20}]);assert(value.truncated);
});
test('Remote path validation rejects traversal, absolute paths, NUL and broken Unicode while retaining legal whitespace',()=>{
  for(const path of ['../private','a/../private','/private','a//b','a/./b','a\0b','a\ud800'])assert.throws(()=>additionalRepositoryPath(path));
  assert.equal(additionalRepositoryPath(' a \r\n.ts '),' a \r\n.ts ');
  const diff='diff --git a/../private b/../private\n--- a/../private\n+++ b/../private\n@@ -1 +1 @@\n-old\n+new\n';const result=additionalRawDiffFiles(diff);assert.equal(result.files.length,0);assert(result.truncated);
});
