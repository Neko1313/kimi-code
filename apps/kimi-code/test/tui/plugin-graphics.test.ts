import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginGraphics } from '../../src/tui/controllers/plugin-graphics';
import { PluginChrome } from '../../src/tui/components/chrome/plugin-chrome';
import type { RenderElement, RuntimeElement } from '@moonshot-ai/kimi-code-sdk/plugin';
import { GraphicsBrowser, type GraphicsPage } from '../../src/utils/graphics/browser';
import { graphicsCells } from '../../src/tui/utils/graphics-frame';
import { darkColors } from '../../src/tui/theme/colors';
import { setCapabilities, resetCapabilitiesCache, visibleWidth } from '@moonshot-ai/pi-tui';
import { Jimp } from 'jimp';
import { ModsTree } from '../../src/tui/components/dialogs/mods-tree';
import { MoonLoader } from '../../src/tui/components/chrome/moon-loader';
import type { TUI } from '@moonshot-ai/pi-tui';
import { GRAPHICS_SEXTANTS, GRAPHICS_OCTANTS } from '../../src/constant/plugin-graphics';

const executable = process.env['KIMI_TEST_PLUGIN_GRAPHICS_BROWSER'];
const browsers: GraphicsBrowser[] = [];
afterEach(() => { for (const browser of browsers.splice(0)) browser.dispose(); vi.unstubAllEnvs(); });
const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><style>rect{animation:move 1s linear infinite}@keyframes move{to{transform:translateX(60px)}}</style><rect x="0" y="5" width="20" height="25" fill="#ff8040"/></svg>';
const tree = (label = 'Context 25%', svg = source) => ({ type: 'Box', props: { flexDirection: 'row', alignItems: 'flex-end' }, children: [
  { type: 'Text', props: { flexGrow: 1 }, children: [label] },
  { type: 'Svg', props: { source: svg, alt: 'Moving square', width: 100, height: 40 } },
] });
const input = (value = tree()) => ({ tree: value, columns: 60, rows: 8, cellWidth: 9, cellHeight: 18, width: 540, height: 144, svgScale: 2.5, palette: darkColors, background: darkColors.canvasBackground, active: false });
async function page(): Promise<GraphicsPage> {
  const browser = new GraphicsBrowser(executable!); browsers.push(browser);
  return browser.createPage();
}

describe('plugin graphics opt-out', () => {
  it('preserves live native spinner frames inside a plugin wrapper', () => {
    const spinner = new MoonLoader({ requestRender() {} } as unknown as TUI, 'braille', undefined, 'Working');
    const tree = new ModsTree({type:'Box',children:[{type:'Text',children:['Before']},{type:'Text',props:{key:'kimi-native-Spinner'},children:['Working']},{type:'Text',children:['After']}]}, () => {}, () => 5, undefined, false, (key,width) => key === 'kimi-native-Spinner' ? spinner.renderNative(width) : undefined);
    spinner.setReplacement(tree);
    try {
      const result = spinner.render(80).join(' ');
      expect(result).toContain('Before');
      expect(result).toContain('Working');
      expect(result).toContain('After');
      expect(result).toContain('⠋');
      spinner.setReplacement(undefined);
      expect(spinner.render(80).join('')).not.toContain('Before');
    } finally { spinner.stop(); tree.dispose(); }
  });

  it('averages both colors when converting a pixel cell', async () => {
    const png = new Jimp({width:4,height:2,color:0x000000ff});
    png.setPixelColor(0xc80000ff,2,0); png.setPixelColor(0xf00000ff,3,0);
    png.setPixelColor(0x0000c8ff,2,1); png.setPixelColor(0x0000f0ff,3,1);
    const lines = await graphicsCells(await png.getBuffer('image/png'),1,1,[]);
    expect(lines[0]).toContain('\u001B[0;38;2;220;0;0;48;2;0;0;220m▀');
  });
  it('draws six subcells with correct shapes and single-column widths', async () => {
    expect(GRAPHICS_SEXTANTS).toHaveLength(64);
    expect(GRAPHICS_SEXTANTS.every(symbol => visibleWidth(symbol) === 1)).toBe(true);
    expect(GRAPHICS_SEXTANTS[21]).toBe('▌');
    expect(GRAPHICS_SEXTANTS[42]).toBe('▐');
    expect(GRAPHICS_SEXTANTS[63]).toBe('█');
    const png = new Jimp({width:4,height:3,color:0x000000ff});
    for (const y of [0,2]) for (const x of [2,3]) png.setPixelColor(0xff0000ff,x,y);
    const lines = await graphicsCells(await png.getBuffer('image/png'),1,1,[],'sextants');
    expect(lines[0]).toContain(GRAPHICS_SEXTANTS[51]);
    expect(lines[0]).toContain('38;2;255;0;0;48;2;0;0;0');
    const half = new Jimp({width:4,height:6,color:0x000000ff});
    for (let y=0;y<3;y++) for (const x of [2,3]) half.setPixelColor(0xff0000ff,x,y);
    const adaptive = await graphicsCells(await half.getBuffer('image/png'),1,1,[],'sextants');
    expect(adaptive[0]).toContain('▀');
  });
  it('uses eight subcells and inverts colors when only the complementary glyph exists', async () => {
    expect(GRAPHICS_OCTANTS).toHaveLength(256);
    expect(GRAPHICS_OCTANTS[4]).toBe('𜴀');
    expect(GRAPHICS_OCTANTS[21]).toBe('𜴍');
    expect(GRAPHICS_OCTANTS.filter(Boolean).every(symbol => visibleWidth(symbol!) === 1)).toBe(true);
    const png = new Jimp({width:4,height:4,color:0x000000ff});
    for (let y=0;y<3;y++) png.setPixelColor(0xff0000ff,2,y);
    const lines = await graphicsCells(await png.getBuffer('image/png'),1,1,[],'octants');
    expect(lines[0]).toContain(GRAPHICS_OCTANTS[21]);
    const one = new Jimp({width:4,height:8,color:0x000000ff});
    one.setPixelColor(0xff0000ff,2,6); one.setPixelColor(0xff0000ff,2,7);
    const inverse = await graphicsCells(await one.getBuffer('image/png'),1,1,[],'octants');
    expect(inverse[0]).toContain(GRAPHICS_OCTANTS[191]);
    expect(inverse[0]).toContain('38;2;0;0;0;48;2;255;0;0');
  });
  it('explains when requested images fall back to terminal cells', async () => {
    vi.stubEnv('KIMI_CODE_PLUGIN_GRAPHICS', 'images');
    vi.stubEnv('KIMI_CODE_PLUGIN_GRAPHICS_BROWSER', '/example/browser');
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const warning = vi.fn();
    const graphics = new PluginGraphics(vi.fn(), warning, vi.fn());
    try {
      expect(await graphics.initialize()).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('colored cells'));
    } finally {
      graphics.dispose();
      resetCapabilitiesCache();
    }
  });
  it('honors the experimental flag before discovering a browser', async () => {
    vi.stubEnv('KIMI_CODE_PLUGIN_GRAPHICS_BROWSER','relative-browser');
    const warning = vi.fn();
    const graphics = new PluginGraphics(vi.fn(),warning,vi.fn(),()=>false);
    expect(await graphics.initialize()).toBe(false);
    expect(graphics.available).toBe(false);
    expect(warning).not.toHaveBeenCalled();
    graphics.dispose();
  });

  it('preserves text mode without starting a browser when disabled', async () => {
    vi.stubEnv('KIMI_CODE_PLUGIN_GRAPHICS','off');
    const warning = vi.fn();
    const graphics = new PluginGraphics(vi.fn(),warning,vi.fn());
    expect(await graphics.initialize()).toBe(false);
    expect(graphics.available).toBe(false);
    expect(warning).not.toHaveBeenCalled();
    graphics.dispose();
  });
});

describe.skipIf(!executable)('plugin SVG graphics', () => {
  it('animates CSS frames while preserving readable terminal text', async () => {
    const renderer = await page();
    const layout = await renderer.update(input());
    const first = await renderer.capture(540, layout.rows * 18, true);
    await new Promise(resolve => setTimeout(resolve, 180));
    const second = await renderer.capture(540, layout.rows * 18, true);
    expect(second.equals(first)).toBe(false);
    const lines = await graphicsCells(second, 60, layout.rows, layout.glyphs);
    expect(lines.join('')).toContain('Context 25%');
    const detailed = await graphicsCells(second, 60, layout.rows, layout.glyphs, 'sextants');
    expect(detailed.join('')).toContain('Context 25%');
    expect(detailed).not.toEqual(await graphicsCells(first, 60, layout.rows, layout.glyphs, 'sextants'));
    expect((await graphicsCells(second,60,layout.rows,layout.glyphs,'octants')).join('')).toContain('Context 25%');
    expect(lines).toHaveLength(layout.rows);
    renderer.dispose();
  });

  it('plays SMIL animation timelines', async () => {
    const renderer = await page();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect y="5" width="20" height="25" fill="#ff8040"><animate attributeName="x" values="0;60;0" dur="1s" repeatCount="indefinite"/></rect></svg>';
    const layout = await renderer.update(input(tree('SMIL',svg)));
    const first = await renderer.capture(540,layout.rows*18,true);
    await new Promise(resolve => setTimeout(resolve,180));
    const second = await renderer.capture(540,layout.rows*18,true);
    expect(second.equals(first)).toBe(false);
  });

  it('stops producing frames after a view closes', async () => {
    vi.stubEnv('KIMI_CODE_PLUGIN_GRAPHICS','cells');
    vi.stubEnv('KIMI_CODE_PLUGIN_GRAPHICS_BROWSER',executable!);
    let count = 0;
    const graphics = new PluginGraphics(()=>{ count++;view.render(tree() as RenderElement,60,8,false); },vi.fn(),vi.fn());
    await graphics.initialize();
    const view = graphics.createView();
    try {
      view.render(tree() as RenderElement,60,8,false);
      await vi.waitFor(()=>expect(count).toBeGreaterThanOrEqual(3),{timeout:4000});
      view.dispose();
      const stopped = count;
      await new Promise(resolve=>setTimeout(resolve,150));
      expect(count).toBe(stopped);
    } finally {graphics.dispose();}
  });

  it('keeps an unchanged SVG timeline when another widget updates', async () => {
    const renderer = await page();
    await renderer.update(input());
    await renderer.capture(540, 108, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    await renderer.capture(540, 108, true);
    const time = () => renderer.evaluate("document.querySelector('.svg').shadowRoot.getAnimations()[0].currentTime");
    const before = await time();
    await renderer.update(input(tree('Context 26%')));
    await renderer.capture(540, 108, true);
    expect(before).toBeGreaterThan(100);
    expect(await time()).toBeGreaterThanOrEqual(before);
  });

  it('isolates malformed SVG and keeps SVG labels readable in the cell renderer', async () => {
    const renderer = await page();
    const value = tree('Panel', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text x="5" y="25" fill="#ffffff">SVG label</text></svg>');
    value.children.push({type:'Svg',props:{source:'<svg broken',alt:'Broken icon',width:20,height:20}});
    const layout = await renderer.update(input(value));
    const png = await renderer.capture(540, layout.rows * 18, true);
    const lines = await graphicsCells(png, 60, layout.rows, renderer.glyphs);
    expect(lines.join('')).toContain('SVG label');
    expect(lines.join('')).toContain('Invalid SVG');
  });

  it('scrolls graphical content without forcing keyboard focus back into view', async () => {
    const renderer = await page();
    const value = {type:'Box',children:[...Array.from({length:30},(_,n)=>({type:'Text',children:[`Line ${n}`]})),{type:'Svg',props:{source,alt:'Animation',width:100,height:40}}]};
    const options = {...input(),tree:value};
    const initial = await renderer.update(options);
    expect(initial.totalRows).toBeGreaterThan(initial.rows);
    const scrolled = await renderer.update({...options,scrollTop:10});
    const png = await renderer.capture(540,scrolled.rows*18,true);
    const lines = await graphicsCells(png,60,scrolled.rows,renderer.glyphs);
    expect(lines.join('')).toContain('Line 10');
    expect(lines.join('')).not.toContain('Line 0');
    expect(scrolled.offset).toBeGreaterThan(0);
    const card = {...input(),tree:{type:'Svg',props:{source:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 500"><rect width="200" height="500" fill="#ff8040"/></svg>',alt:'Tall card'}}};
    const fitted = await renderer.update({...card,fitSvgHeight:true});
    const natural = await renderer.update({...card,fitSvgHeight:false});
    expect(fitted.totalRows).toBeLessThanOrEqual(card.rows);
    expect(natural.totalRows).toBeGreaterThan(card.rows);
  });

  it('renders native plugin trees containing SVG without losing native button actions', async () => {
    vi.stubEnv('KIMI_CODE_PLUGIN_GRAPHICS','cells');
    vi.stubEnv('KIMI_CODE_PLUGIN_GRAPHICS_BROWSER',executable!);
    const warning = vi.fn(), action = vi.fn();
    let ready = () => {};
    const frame = new Promise<void>(resolve => { ready = resolve; });
    const graphics = new PluginGraphics(ready,warning,vi.fn());
    const view = new PluginChrome(()=>8,action,vi.fn(),vi.fn(),graphics);
    try {
      expect(await graphics.initialize()).toBe(true);
      const value: RuntimeElement = {type:'box',direction:'column',children:[{type:'text',text:'Native panel'},{type:'Svg',props:{source,alt:'Square',width:100,height:40}},{type:'button',label:'Retry',action:'retry',hotkey:'r'}]};
      view.setTrees(new Map([['AbovePrompt',value]]));
      view.render(60);
      await frame;
      expect(view.render(60).join('')).toContain('Native panel');
      expect(warning).not.toHaveBeenCalled();
      view.focused=true;view.handleInput('r');
      expect(action).toHaveBeenCalledWith('AbovePrompt','action:retry');
    } finally { view.setTrees(new Map());graphics.dispose(); }
  });

  it('refuses scripts and external resource loads in SVG content', async () => {
    let requests = 0;
    const server = createServer((_, response) => { requests++; response.end('unexpected'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      const renderer = await page();
      await renderer.update(input(tree('Safe', `<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.leaked=true"><script>globalThis.leaked=true</script><image href="http://127.0.0.1:${address.port}/image"/><foreignObject><iframe src="http://127.0.0.1:${address.port}/frame"/></foreignObject><rect width="10" height="10"/></svg>`)));
      await renderer.capture(540, 108, true);
      expect(await renderer.evaluate('typeof globalThis.leaked')).toBe('undefined');
      expect(requests).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
