import {Engine} from '../../src/engine.js';
import {ManagedProjectFolders} from '../../src/managed-project-folders.js';
import {taskGit} from '../../src/git-process.js';
const directory=process.argv[2],phase=process.argv[3],engine=await new Engine(directory).open();
const folders=new ManagedProjectFolders(engine,async(cwd,args,options)=>{
 if(phase==='before-init'&&args[0]==='init')process.exit(91);
 const result=await taskGit(cwd,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],options);
 if(phase==='after-commit'&&args[0]==='commit')process.exit(92);
 return result;
});
await folders.create({requestId:'crash',name:'Crash'});process.exit(93);
