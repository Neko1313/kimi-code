import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { resolveCommandPath } from '../process/resolve-command';
import { installGraphicsDocument } from './document';

import { GRAPHICS_COMMAND_TIMEOUT_MS } from '#/constant/plugin-graphics';

export function findGraphicsBrowser(): string | undefined {
  const custom = process.env['KIMI_CODE_PLUGIN_GRAPHICS_BROWSER'];
  if (custom) {
    if (!isAbsolute(custom)) throw new Error('KIMI_CODE_PLUGIN_GRAPHICS_BROWSER must be an absolute browser path');
    return custom;
  }
  for (const command of ['google-chrome', 'chromium', 'chromium-browser', 'chrome', 'msedge']) {
    const path = resolveCommandPath(command);
    if (path) return path;
  }
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') {
    const base = process.env['PROGRAMFILES'];
    if (base) return join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
  }
  return undefined;
}

export class GraphicsBrowser {
  private sequence = 0;
  private buffer = '';
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private child: ChildProcess | undefined;
  private profile: string | undefined;
  private ready: Promise<void> | undefined;
  private stopped = false;
  private error = '';

  constructor(private readonly executable: string) {}

  start(): Promise<void> {
    return this.ready ??= this.launch();
  }

  private async launch(): Promise<void> {
    this.profile = await mkdtemp(join(tmpdir(), 'kimi-plugin-graphics-'));
    if (this.stopped) { await rm(this.profile, { recursive: true, force: true }); return; }
    this.child = spawn(this.executable, [
      '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-sync',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--no-first-run', '--no-default-browser-check', '--no-startup-window', '--hide-scrollbars', '--remote-debugging-pipe',
      `--user-data-dir=${this.profile}`,
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr?.on('data', data => { this.error = (this.error + String(data)).slice(-2000); });
    this.child.once('error', error => { this.fail(error); });
    this.child.once('exit', () => {
      this.fail(new Error(`Plugin graphics browser exited${this.error ? `: ${this.error}` : ''}`));
      if (this.profile) void rm(this.profile, { recursive: true, force: true }).catch(() => {});
    });
    (this.child.stdio[3] as Writable).on('error', error => { this.fail(error); });
    (this.child.stdio[4] as Readable).on('error', error => { this.fail(error); });
    (this.child.stdio[4] as Readable).setEncoding('utf8').on('data', data => { this.receive(String(data)); });
    await this.send('Browser.getVersion');
  }

  private receive(data: string): void {
    this.buffer += data;
    if (this.buffer.length > 32_000_000) { this.dispose(); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message: { id?: number; result?: unknown; error?: { message: string } };
      try { message = JSON.parse(raw); } catch { this.dispose(); return; }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.stopped || !this.child || this.child.exitCode !== null) return Promise.reject(new Error('Plugin graphics browser is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Plugin graphics timed out: ${method}`)); }, GRAPHICS_COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      (this.child!.stdio[3] as Writable).write(JSON.stringify({ id, method, params, sessionId }) + '\0', error => {
        if (!error) return;
        this.pending.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }

  async createPage(): Promise<GraphicsPage> {
    await this.start();
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new GraphicsPage(this, targetId, sessionId);
    await page.initialize();
    return page;
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.fail(new Error('Plugin graphics browser is closed'));
    this.child?.kill();
    if (!this.child?.pid && this.profile) void rm(this.profile, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GraphicsGlyph { text: string; column: number; row: number; x: number; y: number; width: number; height: number; color: number[]; bold: boolean }
export interface GraphicsLayout { rows: number; totalRows: number; offset: number; glyphs: GraphicsGlyph[]; animations: number }

export class GraphicsPage {
  constructor(private readonly browser: GraphicsBrowser, private readonly target: string, private readonly session: string) {}

  async initialize(): Promise<void> {
    await this.call('Page.enable');
    await this.call('Runtime.enable');
    await this.call('Network.enable');
    await this.call('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'file://*', 'ftp://*', 'ws://*', 'wss://*'] });
    await this.evaluate(`(${installGraphicsDocument.toString()})()`);
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> { return this.browser.send(method, params, this.session); }

  async evaluate(expression: string): Promise<any> {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }

  async update(input: Record<string, unknown>): Promise<GraphicsLayout> {
    const { width, height } = input;
    await this.call('Emulation.setDeviceMetricsOverride', { width: Number(width) * 2, height, deviceScaleFactor: 1, mobile: false });
    await this.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: input['light'] ? 'light' : 'dark' }] });
    return this.evaluate(`globalThis.kimiGraphics.update(${JSON.stringify(input)})`);
  }

  glyphs: GraphicsGlyph[] = [];

  async capture(width: number, height: number, cells: boolean): Promise<Buffer> {
    const frame = await this.evaluate('globalThis.kimiGraphics.tick()');
    this.glyphs = frame.glyphs;
    const result = await this.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: width * (cells ? 2 : 1), height, scale: 1 } });
    return Buffer.from(result.data, 'base64');
  }

  dispose(): void { void this.browser.send('Target.closeTarget', { targetId: this.target }).catch(() => {}); }
}
