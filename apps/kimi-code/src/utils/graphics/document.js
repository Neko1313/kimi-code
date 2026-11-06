export function installGraphicsDocument() {
  document.open();
  document.write('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src \'none\'; connect-src \'none\'; frame-src \'none\'; object-src \'none\'"><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{position:relative}.root{position:absolute;top:0;overflow:hidden;contain:layout paint}.box{display:flex;flex-direction:column;position:relative;min-width:0}.leaf{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}.svg{position:relative;flex-shrink:0;overflow:hidden}.svg svg{width:100%;height:100%;display:block}</style>');
  document.close();
  const epochs = new Map();
  let options;
  let roots = [];
  let leaves = [];
  let live = new Set();
  let lastFocus;
  const safe = value => typeof value === 'string' || typeof value === 'number' ? String(value).replaceAll(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '') : '';
  const color = value => {
    const names = { accent: 'primary', dim: 'textDim', muted: 'textMuted' };
    return options.palette[names[value] ?? value] ?? (/^#[0-9a-f]{3,8}$/i.test(value ?? '') ? value : options.palette.textStrong);
  };
  const dimension = value => typeof value === 'number' && Number.isFinite(value) ? `${value * options.cellWidth}px` : typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value) ? value : undefined;
  const vertical = value => typeof value === 'number' && Number.isFinite(value) ? `${value * options.cellHeight}px` : dimension(value);
  function svg(node, path, background) {
    const p = node.props ?? {};
    if (typeof p.source !== 'string' || p.source.length > 1000000) throw new Error('Invalid SVG source');
    const parsed = new DOMParser().parseFromString(p.source, 'image/svg+xml');
    if (parsed.querySelector('parsererror') || (parsed.documentElement.localName !== 'svg' || parsed.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg')) return build({type:'Text',children:[`[Invalid SVG: ${safe(p.alt)}]`]},path,background);
    parsed.querySelectorAll('script,foreignObject,iframe,object,embed,audio,video').forEach(element => { element.remove(); });
    for (const element of parsed.querySelectorAll('*')) for (const name of element.getAttributeNames()) {
      if (/^on/i.test(name) || (/(?:href|src)$/i.test(name) && !/^(#|data:image\/)/i.test(element.getAttribute(name) ?? ''))) element.removeAttribute(name);
    }
    if (background) for (const text of parsed.querySelectorAll('text,tspan')) { text.style.setProperty('fill','transparent','important'); text.style.setProperty('stroke','transparent','important'); }
    const held = epochs.get(path);
    const epoch = held?.source === p.source ? held : { source: p.source, time: performance.now() };
    epochs.set(path, epoch); live.add(path);
    const host = document.createElement('div'); host.className = 'svg';
    const viewBox = (parsed.documentElement.getAttribute('viewBox') ?? '').trim().split(/[ ,]+/).map(Number);
    const naturalWidth = Number(p.width) || Number(parsed.documentElement.getAttribute('width')) || viewBox[2] || 116;
    const naturalHeight = Number(p.height) || Number(parsed.documentElement.getAttribute('height')) || (viewBox[2] > 0 ? naturalWidth * viewBox[3] / viewBox[2] : 42);
    const width = naturalWidth * options.svgScale;
    const height = naturalHeight * options.svgScale;
    const scale = Math.min(1, options.width / width, options.fitSvgHeight === false ? 1 : options.height / height);
    host.style.width = `${width * scale}px`;
    host.style.height = `${height * scale}px`;
    host.style.maxWidth = '100%';
    host.setAttribute('aria-label', safe(p.alt));
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');style.textContent = 'svg{display:block;width:100%;height:100%}' + (background ? 'text,tspan{fill:transparent!important;stroke:transparent!important}' : '');shadow.append(style);
    shadow.append(document.importNode(parsed.documentElement, true));
    host.dataset.epoch = String(epoch.time);
    return host;
  }
  function build(node, path, background) {
    if (typeof node === 'string') node = { type: 'Text', children: [node] };
    const p = { ...node.props };
    if (options.active && p.hover?.display === 'flex') p.display = 'flex';
    if (node.type === 'Svg') return svg(node, path, background);
    const element = document.createElement('div');
    const box = node.type === 'Box';
    element.className = box ? 'box' : 'leaf';
    element.style.color = color(p.dimColor || p.dim || p.disabled ? 'textMuted' : p.color);
    if (p.backgroundColor) element.style.backgroundColor = color(p.backgroundColor);
    if (p.bold) element.style.fontWeight = '700';
    if (p.display === 'none') element.style.display = 'none';
    for (const name of ['flexGrow', 'flexShrink']) if (typeof p[name] === 'number') element.style[name] = String(p[name]);
    if (box) {
      for (const name of ['flexDirection', 'alignItems', 'alignSelf', 'justifyContent', 'flexWrap', 'position', 'overflow']) if (p[name] !== undefined) element.style[name] = p[name];
      for (const name of ['flexGrow', 'flexShrink', 'order']) if (typeof p[name] === 'number') element.style[name] = String(p[name]);
      for (const name of ['width', 'minWidth', 'maxWidth', 'left', 'right', 'paddingLeft', 'paddingRight', 'marginLeft', 'marginRight', 'columnGap', 'flexBasis']) if (p[name] !== undefined) element.style[name] = dimension(p[name]);
      for (const name of ['height', 'minHeight', 'maxHeight', 'top', 'bottom', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'rowGap']) if (p[name] !== undefined) element.style[name] = vertical(p[name]);
      for (const [key, axes] of [['padding', ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']], ['paddingX', ['paddingLeft', 'paddingRight']], ['paddingY', ['paddingTop', 'paddingBottom']], ['marginX', ['marginLeft', 'marginRight']], ['marginY', ['marginTop', 'marginBottom']]]) {
        if (p[key] !== undefined) for (const axis of axes) element.style[axis] = /Top|Bottom/.test(axis) ? vertical(p[key]) : dimension(p[key]);
      }
      if (p.gap !== undefined) { element.style.columnGap = dimension(p.gap); element.style.rowGap = vertical(p.gap); }
      if (p.borderStyle) { element.style.border = `1px ${p.borderStyle === 'double' ? 'double' : 'solid'} ${color(p.borderColor ?? 'border')}`; }
      for (let index = 0; index < (node.children?.length ?? 0); index++) {
        const child = node.children[index];
        element.append(build(child, `${path}/${child?.props?.key ?? index}`, background));
      }
    } else {
      let text = node.children?.length ? node.children.map(child => typeof child === 'string' ? safe(child) : safe(child.props?.text ?? child.props?.label ?? child.children?.join(''))).join('') : safe(p.text ?? p.label ?? p.value ?? p.code);
      if (node.type === 'Input') text = safe(p.value);
      if (node.type === 'Select') text = (p.options ?? []).map((item, index) => `${index === p.selectedIndex ? '❯' : ' '} ${safe(item.label ?? item.value)}`).join('\n');
      if (node.type === 'Button' && (!p.plain || p.focused)) text = `[${text}]`;
      if (p.focused) { element.style.color = options.palette.primary; element.style.fontWeight = '700'; }
      element.textContent = text;
      if (p.focused || p.selected) { element.dataset.focused = 'true'; element.dataset.key = safe(p.key); }
      if (background) element.style.color = 'transparent';
      else leaves.push(element);
    }
    return element;
  }
  function glyphs() {
    const result = [];
    for (const leaf of leaves) {
      const text = leaf.firstChild;
      if (!text || leaf.getClientRects().length === 0) continue;
      const style = getComputedStyle(leaf);
      const rgb = style.color.match(/[\d.]+/g)?.slice(0,3).map(Number) ?? [255,255,255];
      for (const part of new Intl.Segmenter().segment(text.textContent)) {
        const range = document.createRange(); range.setStart(text, part.index); range.setEnd(text, part.index + part.segment.length);
        const rect = range.getBoundingClientRect();
        const column = Math.round(rect.x / options.cellWidth), row = Math.floor((rect.y + rect.height / 2) / options.cellHeight);
        if (column < 0 || row < 0 || column >= options.columns || row >= options.rows) continue;
        result.push({ text: part.segment, column, row, x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height), color: rgb, bold: Number(style.fontWeight) >= 600 });
      }
    }
    for (const host of roots[0].querySelectorAll('.svg')) for (const text of host.shadowRoot.querySelectorAll('text')) {
      const rect = text.getBoundingClientRect(), style = getComputedStyle(text);
      const column = Math.floor(rect.x / options.cellWidth), row = Math.floor((rect.y + rect.height / 2) / options.cellHeight);
      if (!text.textContent || column < 0 || row < 0 || column >= options.columns || row >= options.rows) continue;
      result.push({ text: safe(text.textContent), column, row, x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height), color: style.fill.match(/[\d.]+/g)?.slice(0,3).map(Number) ?? [255,255,255], bold: Number(style.fontWeight) >= 600 });
    }
    return result;
  }
  globalThis.kimiGraphics = {
    update(input) {
      options = input; leaves = []; live = new Set();
      roots.forEach(root => root.remove()); roots = [];
      document.body.style.background = input.background;
      document.body.style.fontFamily = 'monospace'; document.body.style.fontSize = `${input.cellWidth / 0.602}px`; document.body.style.lineHeight = `${input.cellHeight}px`;
      for (const background of input.cells === false ? [false] : [false, true]) {
        const root = document.createElement('div'); root.className = 'root'; root.style.left = `${background ? input.width : 0}px`;root.style.width = `${input.width}px`; root.style.maxHeight = `${input.height}px`;
        root.append(build(input.tree, 'root', background)); document.body.append(root); roots.push(root);
      }
      for (const path of epochs.keys()) if (!live.has(path)) epochs.delete(path);
      const totalRows = Math.ceil(roots[0].scrollHeight / input.cellHeight);
      const rows = Math.max(1,Math.min(input.rows, totalRows));
      roots[0].scrollTop = (input.scrollTop ?? 0) * input.cellHeight;
      const focused = input.active ? roots[0].querySelector('[data-focused="true"]') : null;
      if (focused && focused.dataset.key !== lastFocus) {
        const rect = focused.getBoundingClientRect();
        if (rect.top < 0) roots[0].scrollTop += rect.top;
        else if (rect.bottom > input.height) roots[0].scrollTop += rect.bottom - input.height;
      }
      lastFocus = focused?.dataset.key;
      if (roots[1]) roots[1].scrollTop = roots[0].scrollTop;
      return { rows, totalRows, offset: roots[0].scrollTop / input.cellHeight, glyphs: glyphs(), animations: 0 };
    },
    tick() {
      const now = performance.now();
      let animations = 0;
      for (const root of roots) for (const svg of root.querySelectorAll('.svg')) {
        const document = svg.shadowRoot.querySelector('svg');
        document.pauseAnimations(); document.setCurrentTime((now - Number(svg.dataset.epoch)) / 1000);
        for (const animation of svg.shadowRoot.getAnimations()) {
          animation.pause(); animation.currentTime = now - Number(svg.dataset.epoch); animations++;
        }
      }
      return { animations, glyphs: glyphs() };
    },
  };
}
