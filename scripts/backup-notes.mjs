import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { backupNoteDatabase } from '../server/src/image-backup.ts';

const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) {
  console.error('用法：pnpm notes:backup /绝对路径/笔记备份.sqlite（FRIDAY_DATA_DIR 可指定主机数据目录）');
  process.exitCode = 1;
} else {
  try {
    const directory = process.env.FRIDAY_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Friday');
    const result = await backupNoteDatabase(join(directory, 'friday.sqlite'), resolve(destination));
    console.log(`已导出正文与 ${result.images} 张图片，图片共 ${result.bytes} 字节：${resolve(destination)}`);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
