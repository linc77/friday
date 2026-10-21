import {Engine} from '../../src/engine.js';
import {workspaceCommand,taskGit} from '../../src/git-process.js';
import {ManagedProjectFolders} from '../../src/managed-project-folders.js';
const directory=process.argv[2],phase=process.argv[3],source=process.argv[4];
const engine=await new Engine(directory,undefined,undefined,{environment:{GH_TOKEN:'synthetic-token'},changeRequestSyncIntervalMs:0,request:async(_url,init)=>{
 if(init?.method==='POST')process.exit(81);
 return new Response(JSON.stringify({login:'fixture'}),{headers:{'Content-Type':'application/json'}});
},execute:async(cwd,command,args,options)=>{
 const result=await workspaceCommand(cwd,command,args,options);if(phase==='clone'&&command==='git'&&args.includes('clone'))process.exit(91);return result;
}}).open();
if(phase==='clone')await engine.projectRepositories.clone({requestId:'crash-clone',name:'Crash',remoteURL:source,path:directory+'/projects/crash'});
else{
 const folders=new ManagedProjectFolders(engine,(cwd,args,options)=>taskGit(cwd,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],options));
 const result=await folders.create({requestId:'project',name:'Publish'});if(result.status!=='created')throw Error('Fixture setup failed');
 await engine.projectRepositories.publish(result.project.id,{requestId:'crash-publish',provider:'github',account:'fixture',repository:'fixture/publish',visibility:'private',protocol:'ssh',remoteName:'origin'});
}
await new Promise(()=>{});
