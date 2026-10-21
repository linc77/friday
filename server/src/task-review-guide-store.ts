import {createHash} from 'node:crypto';
import {chmodSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {SourceControlRepository} from './task-change-requests.js';
import type {ReviewGuide,ReviewGuideExcerptSnapshot} from './task-review-guide-types.js';
export class ReviewGuideStore {
  private database?: DatabaseSync;
  private closed = false;
  constructor(private directory: string) {}
  private key(repository: SourceControlRepository, number: number) { return createHash('sha256').update(JSON.stringify([repository.provider,repository.host,repository.path,number])).digest('hex'); }
  private db() {
    if(this.closed)throw new Error('Guide 存储已关闭');
    if(this.database)return this.database;
    const file=join(this.directory,'source-control-guides.sqlite');
    try{const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error('Guide 存储不是独立文件');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const db=new DatabaseSync(file);try{chmodSync(file,0o600);db.exec('CREATE TABLE IF NOT EXISTS guides(scope TEXT PRIMARY KEY,guide TEXT NOT NULL)');}catch(error){db.close();throw error;}return this.database=db;
  }
  get(repository: SourceControlRepository, number: number): {guide:ReviewGuide;excerpts:ReviewGuideExcerptSnapshot[]} | null {const row=this.db().prepare('SELECT guide FROM guides WHERE scope=?').get(this.key(repository,number)) as {guide:string}|undefined;if(!row)return null;const value=JSON.parse(row.guide);return value.guide?value:{guide:value,excerpts:[]};}
  put(repository: SourceControlRepository, number: number, guide: ReviewGuide, excerpts:ReviewGuideExcerptSnapshot[]) {this.db().prepare('INSERT INTO guides(scope,guide) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET guide=excluded.guide').run(this.key(repository,number),JSON.stringify({guide,excerpts}));}
  close(){this.closed=true;this.database?.close();this.database=undefined;}
}
