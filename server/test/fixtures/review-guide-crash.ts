// A synthetic model that records its durable session, then dies with its owner.
import {appendFile,writeFile} from 'node:fs/promises';
import {Engine} from '../../src/engine.js';
import type {Executor} from '../../src/types.js';
const [data,id,url,cwd,head,marker]=process.argv.slice(2);
const executor:Executor={async run(request){if(request.purpose!=='review_guide')return 'Fixture';await request.update({kind:'session',threadId:'crash-session',codexHome:'/synthetic/fixture'});await appendFile(marker,'model-started\n');return new Promise(()=>{});},async answer(){},async steer(){}};
const engine=await new Engine(data,executor,undefined,{environment:{GH_TOKEN:'synthetic-guide-token'},command:()=>null,request:async(input,init)=>{
 const address=new URL(String(input));if(address.host!=='api.github.com')throw Error('Unexpected fixture host');
 if(address.pathname==='/graphql'){
  const q=JSON.parse(String(init?.body)).query;
  if(q.includes('FridayReviewThreads'))return Response.json({data:{viewer:{login:'reviewer'},repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}},comments:{nodes:[]},reviews:{nodes:[]}}}}});
  if(q.includes('FridayTimelineCommits'))return Response.json({data:{repository:{pullRequest:{commits:{nodes:[],pageInfo:{hasPreviousPage:false}},reviewDismissals:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
  return Response.json({data:{viewer:{login:'reviewer'},repository:{viewerPermission:'WRITE',pullRequest:{id:'pr-node',viewerCanUpdate:true}}}});
 }
 if(address.pathname==='/repos/fixture/project/pulls/17')return Response.json({number:17,html_url:url,title:'Fixture request',state:'open',head:{sha:head,ref:'linc/feature'},base:{ref:'main'},user:{login:'author'}});
 if(address.pathname.endsWith('/comments')||address.pathname.endsWith('/reviews'))return Response.json([]);
 throw Error('Unexpected fixture API');
}}).open();
const run=await engine.reviewGuides.start(id,{url,requestId:'crash-guide',expectedHeadSha:head});await writeFile(marker+'.run',run);
setInterval(()=>{},1000);
