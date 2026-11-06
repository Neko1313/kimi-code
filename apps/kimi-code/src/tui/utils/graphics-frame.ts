import { Jimp } from 'jimp';
import { visibleWidth, truncateToWidth } from '@moonshot-ai/pi-tui';

import { GRAPHICS_QUADRANTS, GRAPHICS_SEXTANTS, GRAPHICS_OCTANTS } from '#/constant/plugin-graphics';

import type { GraphicsGlyph } from '#/utils/graphics/browser';
import { sanitizeShellOutput } from './shell-output';

export async function graphicsCells(png: Buffer, columns: number, rows: number, glyphs: readonly GraphicsGlyph[], resolution: 'quadrants' | 'sextants' | 'octants' = 'quadrants'): Promise<string[]> {
  const image = await Jimp.read(png);
  const { data, width, height } = image.bitmap;
  const half = Math.floor(width / 2);
  const cellWidth = half / columns;
  const cellHeight = height / rows;
  const rgb = (x: number, y: number): number[] => {
    const offset = (Math.max(0, Math.min(height - 1, Math.floor(y))) * width + Math.max(0, Math.min(width - 1, Math.floor(x)))) * 4;
    return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
  };
  const sample = (column: number, row: number, right: boolean, bottom: boolean): number[] => {
    const result = [0, 0, 0]; let count = 0;
    for (let y = Math.floor((row + (bottom ? 0.5 : 0)) * cellHeight); y < Math.min(height, (row + (bottom ? 1 : 0.5)) * cellHeight); y++) {
      for (let x = Math.floor((column + (right ? 0.5 : 0)) * cellWidth); x < Math.min(half, (column + (right ? 1 : 0.5)) * cellWidth); x++) {
        const offset = (y * width + half + x) * 4;
        for (let k = 0; k < 3; k++) result[k]! += data[offset + k]!;
        count++;
      }
    }
    return result.map(value => Math.round(value / Math.max(1, count)));
  };
  const distance = (a: number[],b: number[]): number => a.reduce((sum,value,index) => sum + (value-b[index]!)**2,0);
  const sums = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const counts = new Uint8Array(256);
  const denseCell = (column: number, row: number, divisions: 3 | 4) => {
    const pixels: number[][] = [];
    for (let partY = 0; partY < divisions; partY++) for (let partX = 0; partX < 2; partX++) {
      const x0 = Math.floor((column + partX / 2) * cellWidth), x1 = Math.floor((column + (partX + 1) / 2) * cellWidth);
      const y0 = Math.floor((row + partY / divisions) * cellHeight), y1 = Math.floor((row + (partY + 1) / divisions) * cellHeight);
      const value = [0, 0, 0]; let count = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const offset = (y * width + half + x) * 4;
        for (let channel = 0; channel < 3; channel++) value[channel]! += data[offset + channel]!;
        count++;
      }
      pixels.push(value.map(component => component / Math.max(1, count)));
    }
    const all = (1 << (divisions * 2)) - 1;
    for (let mask = 1; mask <= all; mask++) {
      const bit = mask & -mask, index = 31 - Math.clz32(bit), rest = mask ^ bit;
      counts[mask] = counts[rest]! + 1;
      for (let channel = 0; channel < 3; channel++) sums[channel]![mask] = sums[channel]![rest]! + pixels[index]![channel]!;
    }
    let bestMask = all, bestScore = -Infinity;
    for (let mask = 1; mask <= all; mask += 2) {
      const other = all ^ mask, count = counts[mask]!, otherCount = counts[other]!;
      if (divisions === 4 && GRAPHICS_OCTANTS[mask] === undefined && GRAPHICS_OCTANTS[other] === undefined) continue;
      let score = 0;
      for (let channel = 0; channel < 3; channel++) {
        const a = sums[channel]![mask]!, b = sums[channel]![other]!;
        score += a * a / count + (otherCount === 0 ? 0 : b * b / otherCount);
      }
      if (score > bestScore) { bestScore = score; bestMask = mask; }
    }
    const other = all ^ bestMask;
    let foreground = sums.map(channel => Math.round(channel[bestMask]! / counts[bestMask]!));
    let background = counts[other] === 0 ? foreground : sums.map(channel => Math.round(channel[other]! / counts[other]!));
    if (divisions === 4 && GRAPHICS_OCTANTS[bestMask] === undefined) {
      bestMask = other;
      [foreground, background] = [background, foreground];
    }
    return { text: (divisions === 3 ? GRAPHICS_SEXTANTS[bestMask] : GRAPHICS_OCTANTS[bestMask])!, foreground, background, bold: false, mask: bestMask, divisions };
  };
  const reconstructionError = (column: number, row: number, candidate: { foreground: number[]; background: number[]; mask: number; divisions: number }): number => {
    const x0 = Math.floor(column * cellWidth), x1 = Math.floor((column + 1) * cellWidth);
    const y0 = Math.floor(row * cellHeight), y1 = Math.floor((row + 1) * cellHeight);
    const xMid = Math.floor((column + 0.5) * cellWidth);
    let error = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const partX = Number(x >= xMid);
      let partY = 0;
      while (partY + 1 < candidate.divisions && y >= Math.floor((row + (partY + 1) / candidate.divisions) * cellHeight)) partY++;
      const color = candidate.mask & (1 << (partY * 2 + partX)) ? candidate.foreground : candidate.background;
      const offset = (y * width + half + x) * 4;
      for (let channel = 0; channel < 3; channel++) error += (data[offset + channel]! - color[channel]!) ** 2;
    }
    return error;
  };
  const pixelCell = (column: number,row: number) => {
    const pixels = [sample(column,row,false,false),sample(column,row,true,false),sample(column,row,false,true),sample(column,row,true,true)];
    let best = { error: Infinity, mask: 15, foreground: pixels[0]!, background: pixels[0]! };
    for (let mask = 1; mask < 16; mask += 2) {
      const average = (selected: boolean): number[] => {
        const group = pixels.filter((_, index) => Boolean(mask & (1 << index)) === selected);
        if (group.length === 0) return pixels[0]!;
        return [0, 1, 2].map(channel => Math.round(group.reduce((sum, pixel) => sum + pixel[channel]!, 0) / group.length));
      };
      const foreground = average(true), background = average(false);
      const error = pixels.reduce((sum, pixel, index) => sum + distance(pixel, mask & (1 << index) ? foreground : background), 0);
      if (error < best.error) best = { error, mask, foreground, background };
    }
    const quadrant = { text: GRAPHICS_QUADRANTS[best.mask]!, foreground: best.foreground, background: best.background, bold: false, mask: best.mask, divisions: 2 };
    if (resolution === 'quadrants') return quadrant;
    const sextant = denseCell(column, row, 3);
    let bestCell = reconstructionError(column, row, sextant) < reconstructionError(column, row, quadrant) ? sextant : quadrant;
    if (resolution === 'octants') {
      const octant = denseCell(column, row, 4);
      if (reconstructionError(column, row, octant) < reconstructionError(column, row, bestCell)) bestCell = octant;
    }
    return bestCell;
  };
  const cells: ({ text: string; foreground: number[]; background: number[]; bold: boolean } | null)[][] = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => pixelCell(column,row)));
  for (const glyph of glyphs) {
    if (glyph.row < 0 || glyph.row >= rows || glyph.column < 0 || glyph.column >= columns) continue;
    const text = truncateToWidth(sanitizeShellOutput(glyph.text).replaceAll(/[\r\n\t]/g, ''), columns - glyph.column, '');
    if (!text) continue;
    let visible = text === ' ';
    for (let y = Math.max(0, glyph.y); !visible && y < Math.min(height, glyph.y + glyph.height); y++) {
      for (let x = Math.max(0, glyph.x); x < Math.min(half, glyph.x + glyph.width); x++) {
        const a = rgb(x, y), b = rgb(half + x, y);
        if (a.some((value, index) => Math.abs(value - b[index]!) > 12)) { visible = true; break; }
      }
    }
    if (!visible) continue;
    const cell = cells[glyph.row]![glyph.column];
    if (!cell) continue;
    cells[glyph.row]![glyph.column] = { text, foreground: glyph.color.map(Math.round), background: cell.background, bold: glyph.bold };
    for (let offset = 1; offset < visibleWidth(text) && glyph.column + offset < columns; offset++) cells[glyph.row]![glyph.column + offset] = null;
  }
  return cells.map(row => {
    let style = '', result = '';
    for (const cell of row) {
      if (!cell) continue;
      const next = `0;38;2;${cell.foreground.join(';')};48;2;${cell.background.join(';')}${cell.bold ? ';1' : ''}`;
      if (next !== style) { style = next; result += `\u001B[${style}m`; }
      result += cell.text;
    }
    return result + '\u001B[0m';
  });
}
