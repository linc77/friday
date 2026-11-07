// Execute only the pinned T3 pure grouping/sorting functions to produce an
// independent native parity oracle. MIT source notice: task-sidebar-order.ts.
import ts from 'typescript';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=process.argv[2];if(!root)throw Error('Pass the pinned T3 checkout');
const revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();if(revision!=='8cd9641f76874f2ce17d6c80acd71fab1f0b99d3')throw Error('Unexpected T3 baseline');
async function functions(path,names){const source=await readFile(join(root,path),'utf8'),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);return ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&(!names||names.includes(node.name?.text))||ts.isVariableStatement(node)&&node.declarationList.declarations.some(decl=>decl.name.getText(ast)==='SCRATCH_PROJECT_SCOPE_KEY')).map(node=>node.getText(ast)).join('\n');}
const code=[
 await functions('packages/shared/src/path.ts',['isWindowsDrivePath','isUncPath','isRootPath','trimTrailingPathSeparators','normalizeProjectPathForDispatch','normalizeProjectPathForComparison']),
 await functions('packages/contracts/src/environment.ts',['repositoryGroupingKeyOf','repositoryGroupingDisplayNameOf']),
 await functions('packages/client-runtime/src/environment/scoped.ts',['scopeProjectRef','scopeThreadRef','scopedRefKey','scopedProjectKey','scopedThreadKey']),
 await functions('packages/client-runtime/src/state/projectGrouping.ts'),
 await functions('packages/client-runtime/src/state/threadSort.ts',['toSortableTimestamp','getFirstSortableTimestamp','getLatestUserMessageTimestamp','getThreadSortTimestamp','sortThreads']),
 await functions('apps/web/src/components/Sidebar.logic.ts',['getProjectSortTimestamp','sortProjectsByActivity','sortLogicalProjectsForSidebar'])
].join('\n');
const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText;
const source=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const date=day=>`2026-10-${String(day).padStart(2,'0')}T12:00:00.000Z`;
const identity=(rootPath,key='github.com/owner/repo',display='Owner/Repo',origin)=>({canonicalKey:key,rootPath,displayName:display,name:display.split('/').at(-1),...(origin?{origin}:{})});
const project=(id,path,name,repositoryIdentity=null,day=1)=>({id,path,name,context:'',createdAt:date(day),updatedAt:date(day),...(repositoryIdentity?{repositoryIdentity}:{})});
const task=(id,projectId,created,updated,user,extra={})=>({id,projectId,cwd:'/unused',agent:'codex',title:id,prompt:'',mode:'code',status:'completed',createdAt:date(created),updatedAt:date(updated),durableId:null,threadId:null,turnId:null,result:'',error:null,events:[],approvals:[],artifact:null,lastRequestId:id,messages:[{id:'user',role:'user',text:'',at:date(user)}],...extra});
const basics=[project('main','/repo','Repo',identity('/repo')),project('worktree','/worktree','Repo',identity('/worktree')),project('subdir','/repo/packages/web','Web',identity('/repo')),project('other','/other','Repo',identity('/other','github.com/other/repo','Other/Repo'),4),project('plain','/plain','Notes',null,8)];
const tasks=[task('a','main',2,14,3),task('b','worktree',4,15,5),task('c','subdir',6,13,7),task('d','other',8,12,9),task('archived','plain',19,19,19,{archivedAt:date(20)}),task('z','main',2,3,3)];
const bases=[
 {name:'repositories, subdirectories, empty projects and archived activity',projects:basics,tasks},
 {name:'custom shared names and physical duplicate winners with a known older identity',projects:[...basics.map(p=>p.id==='main'||p.id==='worktree'?{...p,name:'Custom title'}:p),project('new-main','/repo/','Latest alias',null,9)],tasks},
 {name:'fork origins group apart from the upstream',projects:[project('upstream','/up','Repo',identity('/up')),project('fork','/fork','Repo',identity('/fork','github.com/owner/repo','Owner/Repo',{canonicalKey:'github.com/me/repo',displayName:'Me/Repo'})),project('fork2','/fork2','Repo',identity('/fork2','github.com/owner/repo','Owner/Repo',{canonicalKey:'github.com/me/repo',displayName:'Me/Repo'}))],tasks:[]},
 {name:'Windows and UNC physical identities, roots and path boundaries',projects:[project('windows','C:\\Repo\\','Windows',identity('c:\\repo')),project('windows2','c:/repo','Fresh',identity('C:/Repo'),3),project('win-sub','C:/Repo/Packages/Web','Web',identity('C:/Repo')),project('unc','\\\\Server\\Share\\','UNC'),project('root','/','Root'),project('prefix','/repo-other','Prefix',identity('/repo'))],tasks:[]},
 {name:'managed scratch projects coalesce without absorbing ordinary same-title projects',projects:[{...project('scratch-one','/scratch','No project'),isScratch:true},{...project('scratch-two','/other-scratch','Personal scratch'),isScratch:true},project('ordinary','/ordinary','No project')],tasks:[]},
 {name:'old timestamps, title ties and non-repository names',projects:[{...project('empty-a','/a','same'),createdAt:'invalid',updatedAt:'invalid'},project('empty-b','/b','same'),project('empty-c','/c','Café')],tasks:[]}
];
const cases=[];
for(let base=0;base<bases.length;base++)for(const mode of ['repository','repository_path','separate'])for(const sort of ['updated_at','created_at','manual'])for(const override of [false,true]){
 const input=bases[base],preferred=[...input.projects].reverse().map(p=>source.normalizeProjectPathForComparison(p.path));
 const overrides=override?{[source.normalizeProjectPathForComparison(input.projects[0].path)]:'separate'}:{};
 let projects=input.projects.map(p=>({...p,title:p.name,workspaceRoot:p.path,environmentId:'local',repositoryIdentity:p.repositoryIdentity??null,isScratch:p.isScratch??false}));
 if(sort==='manual')projects=projects.map((project,index)=>({project,index,rank:preferred.indexOf(source.normalizeProjectPathForComparison(project.path))})).sort((a,b)=>a.rank-b.rank||a.index-b.index).map(p=>p.project);
 let groups=source.buildProjectGroups({projects,settings:{sidebarProjectGroupingMode:mode,sidebarProjectGroupingOverrides:Object.fromEntries(Object.entries(overrides).map(([key,value])=>['local:'+key,value]))},groupScratchProjects:true}).map(group=>({...group.representative,projectKey:group.key,memberProjectRefs:group.memberProjectRefs,group}));
 const threads=input.tasks.map(t=>({...t,environmentId:'local',archivedAt:t.archivedAt??null,messages:t.messages?.map(m=>({...m,createdAt:m.at}))}));
 groups=source.sortLogicalProjectsForSidebar(groups,threads,sort);
 cases.push({base,mode,sort,overrides,preferred,expected:groups.map(p=>({id:p.projectKey,name:p.projectKey==='\0no-project'?'无项目':p.group.label,representative:p.group.representative.id,members:p.group.members.map(m=>m.project.id),projectIDs:p.group.memberProjectRefs.map(p=>p.projectId).sort()}))});
}
const threadSorts=['updated_at','created_at'].map(order=>({order,expected:source.sortThreads(tasks.map(t=>({...t,messages:t.messages.map(m=>({...m,createdAt:m.at}))})),order).map(t=>t.id)}));
await mkdir('apps/apple/Tests/FridayKitTests/Fixtures',{recursive:true});await writeFile('apps/apple/Tests/FridayKitTests/Fixtures/task-project-sidebar.json',JSON.stringify({source:revision,bases,cases,threadSorts},null,2)+'\n');console.log(`${cases.length} grouping/sorting cases and ${threadSorts.length} thread orders derived from pinned T3 source`);
