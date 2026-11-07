// Adapted from pingdotgg/t3code@8cd9641f (MIT); license is bundled as T3code-LICENSE.txt.
import type { CDPSession, Frame, Page } from 'playwright-core';
export function hostEditingCommand(key: string, modifiers: number): string | null {
  const modifier = modifiers & 7; if (modifier !== 2 && modifier !== 4) return null;
  const lower = key.toLowerCase();
  return lower === 'c' ? 'copy' : lower === 'x' ? 'cut' : modifier !== 4 ? null : lower === 'a' ? 'selectAll' : lower === 'z' ? modifiers & 8 ? 'redo' : 'undo' : null;
}
export const hostClipboardScript = String.raw`(() => {
  let keying = false;
  let copied = "";
  // The same Ctrl or Cmd + C or X that editingCommand sends as copy or cut.
  addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x") return;
    keying = true;
    copied = "";
    setTimeout(() => { keying = false; });
  }, true);
  const selection = () => {
    let field = document.activeElement;
    while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null)
      return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart);
    return String(document.getSelection() ?? "");
  };
  const record = (text) => {
    copied = String(text ?? "").slice(0, 1048576);
  };
  // Capturing at window runs before page handlers can stop the event, and
  // before cut removes the selection.
  const snapshot = (event) => {
    if (keying && event.isTrusted) record(selection());
  };
  // Bubbling back to window picks up text a page handler set instead.
  const replace = (event) => {
    if (keying && event.isTrusted && event.defaultPrevented) record(event.clipboardData?.getData("text/plain"));
  };
  for (const type of ["copy", "cut"]) {
    addEventListener(type, snapshot, true);
    addEventListener(type, replace);
  }
  globalThis.takeCopy = () => {
    const text = copied;
    copied = "";
    return text;
  };
})();`;
const world = 'friday-host-clipboard';
export class HostBrowserClipboard {
  private frames = new Map<Frame, CDPSession>();
  private closed = false;
  constructor(private readonly page: Page, private readonly main: CDPSession) {}
  async install() {
    await this.record(this.main);
    this.page.on('frameattached', frame => { void this.frame(frame); });
    this.page.on('framenavigated', frame => { void this.frame(frame); });
    this.page.on('framedetached', frame => { const session = this.frames.get(frame); this.frames.delete(frame); void session?.detach().catch(() => {}); });
    for (const frame of this.page.frames()) if (frame !== this.page.mainFrame()) void this.frame(frame);
  }
  private async record(session: CDPSession) {
    await session.send('Page.enable');
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: hostClipboardScript, worldName: world, runImmediately: true });
  }
  private async frame(frame: Frame) {
    if (this.closed || frame === this.page.mainFrame() || this.frames.has(frame) || frame.isDetached()) return;
    const session = await this.page.context().newCDPSession(frame).catch(() => null);
    if (!session) return;
    if (this.closed || frame.isDetached() || this.frames.has(frame)) { await session.detach().catch(() => {}); return; }
    this.frames.set(frame, session); await this.record(session).catch(() => {});
  }
  private async takeSession(session: CDPSession): Promise<string[]> {
    const tree = await session.send('Page.getFrameTree').catch(() => null); if (!tree) return [];
    const ids = (node: typeof tree.frameTree): string[] => [node.frame.id, ...(node.childFrames ?? []).flatMap(ids)];
    return Promise.all(ids(tree.frameTree).map(async frameId => {
      try {
        const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId, worldName: world });
        const { result } = await session.send('Runtime.evaluate', { contextId: executionContextId, expression: 'globalThis.takeCopy?.()', returnByValue: true });
        return typeof result.value === 'string' ? result.value.slice(0, 1048576) : '';
      } catch { return ''; }
    }));
  }
  async take(): Promise<string | undefined> {
    const values = await Promise.all([this.main, ...this.frames.values()].map(session => this.takeSession(session)));
    return values.flat().find(value => value.length > 0);
  }
  close() { this.closed = true; for (const session of this.frames.values()) void session.detach().catch(() => {}); this.frames.clear(); }
}
