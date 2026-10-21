import { basename, extname } from 'node:path';

export type TaskFilePreviewKind = 'text' | 'markdown' | 'html' | 'table' | 'image' | 'audio' | 'video' | 'pdf' | 'unsupported';
const mimeTypes: Record<string, string> = {
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf', '.md': 'text/markdown', '.mdx': 'text/markdown',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.xml': 'application/xml', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.aiff': 'audio/aiff',
  '.avi': 'video/x-msvideo', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.ogv': 'video/ogg', '.webm': 'video/webm',
};
export const taskFileMimeType = (path: string) => mimeTypes[extname(path).toLowerCase()] ?? 'application/octet-stream';
export function taskFilePreviewKind(path: string): TaskFilePreviewKind {
  const extension = extname(path).toLowerCase(), mime = taskFileMimeType(path);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown') return 'markdown';
  if (extension === '.csv' || extension === '.tsv') return 'table';
  return 'text'; // Actual bytes decide whether an unknown extension is text.
}
export const taskFileLanguage = (path: string) => {
  const extension = extname(path).slice(1).toLowerCase(), name = basename(path).toLowerCase();
  return ({ ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', mdx: 'mdx', htm: 'html', h: 'c', cs: 'csharp', kt: 'kotlin' } as Record<string, string>)[extension]
    ?? (name === 'dockerfile' ? 'dockerfile' : name === 'makefile' ? 'makefile' : name === '.gitignore' ? 'ini' : extension || 'text');
};
