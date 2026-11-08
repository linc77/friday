export function projectScriptProgress(text: string): string {
  const clean = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const progress = clean.split('\n').map(line => line.trimEnd())
    .filter(line => line.trim()).slice(-10).map(line => line.slice(0, 400)).join('\n').slice(-4096);
  // A UTF-16 slice can split an emoji. Emit well-formed UTF-8 so native JSON
  // decoders never lose the entire snapshot to an unpaired surrogate.
  return Buffer.from(progress, 'utf8').toString('utf8');
}
