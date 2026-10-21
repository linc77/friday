import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { antigravityBrowserMarker } from './antigravity-profile.js';
// T3 8cd9641f antigravityAuthSupport: auth URLs are side-channel data, never
// JSON-RPC messages or instructions. The ACP SDK still owns RPC framing.
const prefix = 'Open the following link to authenticate the ACP server: ';
function authorization(value: string, receive: (url: string) => void) {
  if (value.length > 16384) throw new Error('Antigravity 登录地址过长');
  let url: URL; try { url = new URL(value); } catch { throw new Error('Antigravity 登录地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Antigravity 登录地址格式无效'); receive(url.href);
}
export function antigravityOutput(receive: (url: string) => void) {
  const decoder = new StringDecoder('utf8'); let pending = '';
  const stdout = new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        pending += decoder.write(chunk); if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error('Antigravity 输出行超过预算');
        let index: number;
        while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1); if (line.startsWith(prefix)) authorization(line.slice(prefix.length).trim(), receive); else this.push(line + '\n'); }
        callback();
      } catch (error) { callback(error instanceof Error ? error : new Error('Antigravity 输出无效')); }
    },
    flush(callback: TransformCallback) { try { pending += decoder.end(); if (pending.startsWith(prefix)) authorization(pending.slice(prefix.length).trim(), receive); else if (pending) this.push(pending + '\n'); callback(); } catch (error) { callback(error instanceof Error ? error : new Error('Antigravity 输出无效')); } },
  });
  const stderrDecoder = new StringDecoder('utf8'); let stderrLine = '', dropped = false;
  const stderr = (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    for (const character of text) {
      if (character === '\n') {
        if (!dropped) { const marker = stderrLine.indexOf(antigravityBrowserMarker); if (marker >= 0) { let value: unknown; try { value = JSON.parse(stderrLine.slice(marker + antigravityBrowserMarker.length).trim()); } catch { throw new Error('Antigravity 浏览器回传无效'); } if (typeof value !== 'string') throw new Error('Antigravity 浏览器回传无效'); authorization(value, receive); } }
        stderrLine = ''; dropped = false;
      } else if (!dropped) { stderrLine += character; if (stderrLine.length > 32768) { stderrLine = ''; dropped = true; } }
    }
  };
  return { stdout, stderr };
}
