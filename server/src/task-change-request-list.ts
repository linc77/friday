/*
Adapted from T3 Code 8cd9641f shared/threadPullRequests.ts / mcp/toolkits/pullRequests/handlers.ts.
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
import type { WorkItem, TaskPullRequest } from './types.js';
import type { SavedChangeRequestStack } from './task-change-request-stack-types.js';
import { taskPullRequests } from './task-pull-requests.js';
import { changeRequestSyncKey } from './task-change-request-summary.js';
type Link=Omit<TaskPullRequest,'snapshot'>&{snapshot:NonNullable<TaskPullRequest['snapshot']>|null;stack:SavedChangeRequestStack|null};
const threadPullRequestKeyOf=(link:Link)=>changeRequestSyncKey(link as TaskPullRequest);
const normalizedKeyOf=(link:Link)=>{const [,host,repository]=JSON.parse(threadPullRequestKeyOf(link));return {host:String(host),repository:String(repository)};};
const visibleThreadPullRequests=(links:readonly Link[])=>links.filter(link=>!link.dismissedAt&&link.linkSource!=='stack-dismissed');
export interface ThreadPullRequestChain {
  readonly kind: "native" | "derived";
  readonly layers: ReadonlyArray<Link>;
  /** One per layer: 0 for the base, parent's depth + 1 above it. Siblings share a depth. */
  readonly depths: ReadonlyArray<number>;
}

export function resolveThreadPullRequestChains(
  links: ReadonlyArray<Link>,
): ReadonlyArray<ThreadPullRequestChain> {
  const visible = visibleThreadPullRequests(links);
  const chains: Array<ThreadPullRequestChain> = [];
  const placed = new Set<string>();

  const nativeStacks = new Map<string, Array<Link>>();
  for (const link of visible) {
    if (link.stack === null) continue;
    const key = normalizedKeyOf(link);
    const stackKey = `${key.host}/${key.repository}#stack:${link.stack.id}`;
    const members = nativeStacks.get(stackKey) ?? [];
    members.push(link);
    nativeStacks.set(stackKey, members);
  }
  for (const members of nativeStacks.values()) {
    const order = new Map(members[0]!.stack!.layers.map((layer, index) => [layer.number, index]));
    members.sort((left, right) => (order.get(left.number) ?? 0) - (order.get(right.number) ?? 0));
    for (const member of members) placed.add(threadPullRequestKeyOf(member));
    chains.push({ kind: "native", layers: members, depths: members.map((_, index) => index) });
  }

  const remaining = visible.filter((link) => !placed.has(threadPullRequestKeyOf(link)));
  const branchKey = (link: Link, branch: string) => {
    const key = normalizedKeyOf(link);
    return `${key.host}/${key.repository}:${branch}`;
  };
  const byHead = new Map<string, Link | null>();
  for (const link of remaining) {
    if (link.snapshot === null) continue;
    const key = branchKey(link, link.snapshot.headBranch);
    byHead.set(key, byHead.has(key) ? null : link);
  }
  const parentOf = (link: Link) => {
    if (link.snapshot === null) return undefined;
    const parent = byHead.get(branchKey(link, link.snapshot.baseBranch));
    return parent == null || parent === link ? undefined : parent;
  };
  const children = new Map<string, Array<Link>>();
  for (const link of remaining) {
    const parent = parentOf(link);
    if (parent === undefined) continue;
    const key = threadPullRequestKeyOf(parent);
    const siblings = children.get(key) ?? [];
    siblings.push(link);
    children.set(key, siblings);
  }
  for (const base of remaining) {
    if (parentOf(base) !== undefined) continue;
    const layers: Array<Link> = [];
    const depths: Array<number> = [];
    const pending: Array<{ readonly link: Link; readonly depth: number }> = [
      { link: base, depth: 0 },
    ];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const key = threadPullRequestKeyOf(next.link);
      // Two links with one identity would otherwise share a child list and expand forever.
      if (placed.has(key)) continue;
      placed.add(key);
      layers.push(next.link);
      depths.push(next.depth);
      const below = children.get(key) ?? [];
      for (let index = below.length - 1; index >= 0; index -= 1) {
        pending.push({ link: below[index]!, depth: next.depth + 1 });
      }
    }
    if (layers.length > 0) chains.push({ kind: "derived", layers, depths });
  }
  for (const link of remaining) {
    if (!placed.has(threadPullRequestKeyOf(link))) {
      chains.push({ kind: "derived", layers: [link], depths: [0] });
    }
  }
  return chains;
}


export function taskChangeRequestList(task:WorkItem){
 const refs=taskPullRequests(task),byURL=new Map(refs.map(pr=>[pr.url,pr])),native=new Map<string,SavedChangeRequestStack>();
 for(const [url,stack] of Object.entries(task.changeRequestStacks??{})){const parent=byURL.get(url);if(parent&&stack)for(const layer of stack.layers)native.set(changeRequestSyncKey({...parent,number:layer.number}),stack);}
 const links:Link[]=refs.map(pr=>{
  const stack=task.changeRequestStacks?.[pr.url]??native.get(changeRequestSyncKey(pr))??null;
  return {...pr,snapshot:pr.snapshot??null,stack};
 });
 const chains=resolveThreadPullRequestChains(links);
 return {pullRequests:links.map(link=>{
  const chain=chains.find(chain=>chain.layers.length>1&&chain.layers.includes(link)),index=chain?.layers.indexOf(link)??-1;
  return {host:normalizedKeyOf(link).host,repository:link.repository??normalizedKeyOf(link).repository,number:link.number,url:link.url,source:link.linkSource??'manual',watching:!!link.watch,state:link.snapshot?.state??null,title:link.snapshot?.title??null,headBranch:link.snapshot?.headBranch??null,baseBranch:link.snapshot?.baseBranch??null,isDraft:link.snapshot?.isDraft??null,stack:chain?{kind:chain.kind,position:chain.depths[index]!+1,size:chain.layers.length}:null};
 }),chains:chains.map(chain=>({kind:chain.kind,numbers:chain.layers.map(link=>link.number)}))};
}
