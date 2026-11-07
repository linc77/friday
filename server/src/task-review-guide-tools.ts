import {realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
/** The investigation can read its checkout and run only literal Git inspection commands. */
export async function reviewGuideTool(name:string,input:Record<string,unknown>,cwd:string):Promise<{behavior:'allow';updatedInput:Record<string,unknown>}|{behavior:'deny';message:string}> {
  const deny={behavior:'deny' as const,message:'Review guides may only inspect the checked-out change.'};
  if(['Read','Grep','Glob'].includes(name)){
    const path=String(input.file_path??input.path??cwd),root=await realpath(cwd),target=await realpath(resolve(cwd,path)).catch(()=>null);
    if(!target)return deny;const rel=relative(root,target);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel==='.git'||rel.startsWith('.git/'))return deny;
    return {behavior:'allow',updatedInput:input};
  }
  if(name!=='Bash'||typeof input.command!=='string'||/[\r\n;&|<>`$\\]/.test(input.command))return deny;
  const match=/^git\s+(diff|log|show)(\s.*)?$/.exec(input.command.trim());
  if(!match||/(?:--output|(?:^|\s)-o(?:\s|$)|--no-index|--ext-diff|--textconv|--exec-path|--git-dir|--work-tree)/.test(match[2]??''))return deny;
  return {behavior:'allow',updatedInput:{...input,command:`git --no-pager ${match[1]} --no-ext-diff --no-textconv${match[2]??''}`}};
}
