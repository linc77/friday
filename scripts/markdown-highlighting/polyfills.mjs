import 'fast-text-encoding';

// JavaScriptCore provides WebAssembly but no browser base64/UTF-8 globals.
// This decoder is used only by Shiki's bundled, fixed WASM binary.
if (typeof globalThis.atob !== 'function') globalThis.atob = value => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const input = String(value).replace(/[\t\n\f\r ]/g, '').replace(/=+$/, '');
  let bits = 0, count = 0, output = '';
  for (const character of input) {
    const digit = alphabet.indexOf(character); if (digit < 0) throw new TypeError('Invalid base64');
    bits = (bits << 6) | digit; count += 6;
    if (count >= 8) { count -= 8; output += String.fromCharCode((bits >>> count) & 255); }
  }
  return output;
};
