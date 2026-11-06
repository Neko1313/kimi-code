import type { RenderElement } from '@moonshot-ai/kimi-code-sdk/plugin';
import { allocateImageId, deleteKittyImage, getCapabilities, getCellDimensions, renderImage } from '@moonshot-ai/pi-tui';

import { findGraphicsBrowser, GraphicsBrowser, type GraphicsPage, type GraphicsLayout } from '#/utils/graphics/browser';
import { currentTheme } from '#/tui/theme';
import { GRAPHICS_IDLE_MS, GRAPHICS_FRAME_MS, GRAPHICS_VISIBILITY_TIMEOUT_MS, GRAPHICS_MAX_COLUMNS, GRAPHICS_MAX_ROWS, GRAPHICS_MAX_PIXELS } from '#/constant/plugin-graphics';
import { graphicsCells } from '#/tui/utils/graphics-frame';

export class PluginGraphics {
  private browser: GraphicsBrowser | undefined;
  private failed = false;
  private ready: Promise<boolean> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly views = new Set<PluginGraphicsView>();

  constructor(private readonly changed: () => void, private readonly warning: (message: string) => void, private readonly write: (data: string) => void, private readonly enabled: () => boolean = () => true) {}

  initialize(): Promise<boolean> {
    if (!this.enabled()) return Promise.resolve(false);
    return this.ready ??= (async () => {
      try {
        const mode = (process.env['KIMI_CODE_PLUGIN_GRAPHICS'] ?? 'auto').toLowerCase();
        if (['0','false','off'].includes(mode)) return false;
        if (!['1','true','auto','cells','sextants','octants','images'].includes(mode)) throw new Error('KIMI_CODE_PLUGIN_GRAPHICS must be auto, cells, sextants, octants, images or off');
        if (mode === 'images' && getCapabilities().images === null) {
          this.warning('This terminal does not advertise an image protocol. Plugin graphics will use colored cells; use Kitty, Ghostty, WezTerm or iTerm2 for sharper images.');
        }
        const path = findGraphicsBrowser();
        if (!path) { this.warning('SVG animation needs Chrome or Chromium. Plugin text mode remains available.'); return false; }
        this.browser = new GraphicsBrowser(path);
        return true;
      } catch (error) { this.fail(error); return false; }
    })();
  }

  get available(): boolean { return this.enabled() && this.browser !== undefined && !this.failed; }

  createView(): PluginGraphicsView {
    clearTimeout(this.idle); this.idle = undefined;
    const view = new PluginGraphicsView(this.browser!, this.changed, error => { this.fail(error); }, this.write, () => { this.release(view); });
    this.views.add(view);
    return view;
  }

  private release(view: PluginGraphicsView): void {
    this.views.delete(view);
    if (this.views.size > 0 || this.failed) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.views.size > 0) return;
      this.browser?.dispose(); this.browser = undefined; this.ready = undefined;
    }, GRAPHICS_IDLE_MS);
    this.idle.unref();
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true; clearTimeout(this.idle);
    this.warning(`Plugin graphics unavailable: ${error instanceof Error ? error.message : String(error)}. Using text mode.`);
    for (const view of this.views) view.dispose();
    this.browser?.dispose();
    this.changed();
  }

  dispose(): void {
    clearTimeout(this.idle); this.failed = true;
    for (const view of this.views) view.dispose();
    this.browser?.dispose();
    this.failed = true;
  }
}

export class PluginGraphicsView {
  private page: GraphicsPage | undefined;
  private desired: Record<string, unknown> | undefined;
  private signature = '';
  private version = 0;
  private drawn = -1;
  private layout: GraphicsLayout | undefined;
  private output: string[] = [];
  private disposed = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private touched = 0;
  private readonly imageId = allocateImageId();
  private scrollTop = 0;

  get totalRows(): number { return this.layout?.totalRows ?? 0; }

  scroll(position: number): void {
    this.scrollTop = Math.max(0,Math.min(position,this.totalRows - Number(this.desired?.['rows'] ?? 0)));
    this.changed();
  }

  scrollBy(rows: number): void { this.scroll(this.scrollTop + rows); }

  constructor(private readonly browser: GraphicsBrowser, private readonly changed: () => void, private readonly failed: (error: unknown) => void, private readonly write: (data: string) => void, private readonly closed: () => void) {}

  render(tree: RenderElement, columns: number, rows: number, active: boolean, fitSvgHeight = true): string[] {
    if (this.disposed) return [];
    this.touched = Date.now();
    const cells = getCellDimensions();
    const mode = process.env['KIMI_CODE_PLUGIN_GRAPHICS']?.toLowerCase();
    const images = getCapabilities().images !== null && mode !== 'cells' && mode !== 'sextants' && mode !== 'octants';
    const cellWidth = Math.max(5,Math.min(20,Math.round(cells.widthPx)));
    const cellHeight = Math.max(10,Math.min(40,Math.round(cells.heightPx)));
    columns = Math.max(1,Math.min(columns,GRAPHICS_MAX_COLUMNS)); rows = Math.max(1,Math.min(rows,GRAPHICS_MAX_ROWS,Math.floor(GRAPHICS_MAX_PIXELS/(columns*cellWidth*cellHeight*2))));
    const background = currentTheme.color('canvasBackground');
    const light = [1,3,5].map(index => Number.parseInt(background.slice(index,index+2),16)).reduce((sum,value) => sum+value,0) > 384;
    const input = { tree, fitSvgHeight, scrollTop: this.scrollTop, columns, rows, active, width: columns * cellWidth, height: rows * cellHeight, cellWidth, cellHeight, svgScale: images ? 1.5 : 2.5, palette: currentTheme.palette, background, light, cells: !images, resolution: mode === 'octants' ? 'octants' : mode === 'sextants' ? 'sextants' : 'quadrants' };
    const signature = JSON.stringify(input);
    if (signature !== this.signature) { this.signature = signature; this.desired = input; this.version++; }
    if (!this.busy && !this.timer) void this.paint();
    return this.output;
  }

  private async paint(): Promise<void> {
    if (this.disposed || this.busy || !this.desired) return;
    this.busy = true;
    const began = Date.now();
    try {
      this.page ??= await this.browser.createPage();
      if (this.disposed) { this.page.dispose(); return; }
      const input = this.desired;
      const version = this.version;
      if (this.drawn !== version) { this.layout = await this.page.update(input); this.scrollTop = this.layout.offset; this.drawn = version; }
      const width = Number(input['width']), height = this.layout!.rows * Number(input['cellHeight']);
      const png = await this.page.capture(width, height, Boolean(input['cells']));
      if (this.disposed || version !== this.version) return;
      if (input['cells']) {
        const output = await graphicsCells(png, Number(input['columns']), this.layout!.rows, this.page.glyphs, input['resolution'] === 'octants' ? 'octants' : input['resolution'] === 'sextants' ? 'sextants' : 'quadrants');
        if (this.disposed || version !== this.version) return;
        this.output = output;
      }
      else {
        const rendered = renderImage(png.toString('base64'), { widthPx: width, heightPx: height }, { maxWidthCells: Number(input['columns']), maxHeightCells: this.layout!.rows, imageId: this.imageId, moveCursor: false });
        if (!rendered) this.output = [];
        else if (getCapabilities().images === 'kitty') this.output = [rendered.sequence,...Array.from({ length: rendered.rows - 1 }, () => '')];
        else {
          const offset = rendered.rows - 1;
          this.output = [...Array.from({ length: offset }, () => ''), `${offset ? `\u001B[${offset}A` : ''}${rendered.sequence}`];
        }
      }
      this.changed();
    } catch (error) { if (!this.disposed) this.failed(error); }
    finally {
      this.busy = false;
      if (!this.disposed && (this.version !== this.drawn || Date.now() - this.touched < GRAPHICS_VISIBILITY_TIMEOUT_MS)) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.paint(); }, Math.max(0,GRAPHICS_FRAME_MS - (Date.now() - began)));
        this.timer.unref();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer); this.page?.dispose();
    if (getCapabilities().images === 'kitty') this.write(deleteKittyImage(this.imageId));
    this.closed();
  }
}
