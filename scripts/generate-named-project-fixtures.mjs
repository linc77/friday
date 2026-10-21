// Independent oracle from the pinned T3 source; license: task-sidebar-order.ts.
import ts from 'typescript';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.argv[2],revision='8cd9641f76874f2ce17d6c80acd71fab1f0b99d3';
if(!root||execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==revision)throw Error('Pass the pinned T3 checkout');
async function select(path,names){const raw=await readFile(join(root,path),'utf8'),ast=ts.createSourceFile(path,raw,ts.ScriptTarget.Latest,true);return ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)||ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>names.includes(declaration.name.getText(ast)))).map(node=>node.getText(ast)).join('\n');}
const raw=await select('packages/shared/src/path.ts',['WINDOWS_RESERVED_NAME','newProjectFolderName'])+'\n'+await select('apps/server/src/project/ManagedProjectFolders.ts',['ICON_BACKGROUNDS','escapeXml','namedProjectIconSvg'])+'\nexport {namedProjectIconSvg};';
const js=ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText,source=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const names=['Pinball Stats','pinball stats','Café résumé','中文项目','你好 世界','CON','prn','Aux','NUL','com1','LPT9','COM10','a'.repeat(90),'a'.repeat(63)+' -- tail','.. / ../ &?','💫','A🦄 B⚡️','<&"','', '  '];
await writeFile('server/test/fixtures/t3-named-projects.json',JSON.stringify({source:revision,cases:names.map(name=>({name,folder:source.newProjectFolderName(name),svg:source.namedProjectIconSvg(name)}))},null,2)+'\n');
console.log(`${names.length} project folder and icon cases derived from pinned T3 source`);
