import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {presentationDraft, type ChartContent, type DiagramContent, type PresentationDraft} from './presentation.js';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));
const palette = ['#405cf5', '#0d9488', '#d97706', '#8b5cf6'];
const number = (value: number) => Number(value.toPrecision(5)).toLocaleString('en-US');
const svgText = (x: number, y: number, value: string, extra = '') => `<text x="${x}" y="${y}" ${extra}>${escape(value)}</text>`;

function chartSvg(chart: ChartContent): string {
  const width = Math.max(640, chart.data.length * 52), height = 390;
  let body = '';
  if (chart.type === 'pie') {
    const total = chart.data.reduce((sum, row) => sum + row.values[0]!, 0);
    let start = -Math.PI / 2;
    for (const [index, row] of chart.data.entries()) {
      const ratio = row.values[0]! / total, end = start + ratio * Math.PI * 2;
      const title = `<title>${escape(row.label)}: ${number(row.values[0]!)}</title>`;
      if (ratio === 1) body += `<circle cx="320" cy="185" r="146" fill="${palette[index % palette.length]}">${title}</circle>`;
      else if (ratio > 0) body += `<path d="M320 185 L${320 + Math.cos(start) * 146} ${185 + Math.sin(start) * 146} A146 146 0 ${ratio > .5 ? 1 : 0} 1 ${320 + Math.cos(end) * 146} ${185 + Math.sin(end) * 146} Z" fill="${palette[index % palette.length]}">${title}</path>`;
      start = end;
    }
  } else {
    const values = chart.data.flatMap(row => row.values), min = Math.min(0, ...values), max = Math.max(0, ...values);
    const span = max - min || 1, y = (v: number) => 305 - (v - min) / span * 260;
    const step = (width - 96) / chart.data.length, x = (i: number) => 72 + step * (i + .5);
    for (let tick = 0; tick <= 4; tick++) {
      const value = min + span * tick / 4, yy = y(value);
      body += `<path d="M64 ${yy} H${width - 16}" stroke="#e8edf5"/>${svgText(56, yy + 4, number(value), 'text-anchor="end" class="tick"')}`;
    }
    for (let series = 0; series < chart.series.length; series++) {
      const color = palette[series]!;
      if (chart.type === 'line') body += `<polyline fill="none" stroke="${color}" stroke-width="3" points="${chart.data.map((row, i) => `${x(i)},${y(row.values[series]!)}`).join(' ')}"/>`;
      for (const [i, row] of chart.data.entries()) {
        const value = row.values[series]!, yy = y(value), title = `<title>${escape(row.label)} · ${escape(chart.series[series]!)}: ${number(value)}</title>`;
        if (chart.type === 'line') body += `<circle cx="${x(i)}" cy="${yy}" r="4" fill="${color}">${title}</circle>`;
        else {
          const barWidth = Math.max(2, Math.min(44, step * .76 / chart.series.length));
          body += `<rect x="${x(i) + (series - chart.series.length / 2) * barWidth}" y="${Math.min(yy, y(0))}" width="${barWidth - 1}" height="${Math.max(.8, Math.abs(yy - y(0)))}" rx="3" fill="${color}">${title}</rect>`;
        }
      }
    }
    body += chart.data.map((row, i) => svgText(x(i), 329, row.label, `text-anchor="end" transform="rotate(-28 ${x(i)} 329)"`)).join('');
  }
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="数据图表">${body}</svg>`;
}

function diagramSvg(diagram: DiagramContent): string {
  // Bounded deterministic layout, including cyclic graphs. Source labels never become SVG attributes or directives.
  const indegree = new Map(diagram.nodes.map(node => [node.id, 0]));
  for (const edge of diagram.edges) indegree.set(edge.to, indegree.get(edge.to)! + 1);
  const rank = new Map<string, number>(), pending = diagram.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  for (const id of pending) rank.set(id, 0);
  for (let i = 0; i < pending.length; i++) for (const edge of diagram.edges.filter(edge => edge.from === pending[i])) {
    rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, rank.get(edge.from)! + 1));
    indegree.set(edge.to, indegree.get(edge.to)! - 1);
    if (indegree.get(edge.to) === 0) pending.push(edge.to);
  }
  if (pending.length !== diagram.nodes.length) diagram.nodes.forEach((node, i) => rank.set(node.id, Math.floor(i / 3)));
  const rows = [...new Set(rank.values())].sort((a, b) => a - b).map(r => diagram.nodes.filter(node => rank.get(node.id) === r));
  const width = Math.max(640, Math.max(...rows.map(row => row.length)) * 230 + 40), height = rows.length * 128 + 32;
  const points = new Map<string, {x: number; y: number}>();
  rows.forEach((row, r) => row.forEach((node, col) => points.set(node.id, {x: width / 2 + (col - (row.length - 1) / 2) * 230, y: r * 128 + 48})));
  let body = '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#9aa9c4"/></marker></defs>';
  for (const edge of diagram.edges) {
    const a = points.get(edge.from)!, b = points.get(edge.to)!;
    body += `<path d="M${a.x} ${a.y + 28} C${a.x} ${a.y + 72},${b.x} ${b.y - 72},${b.x} ${b.y - 30}" fill="none" stroke="#9aa9c4" stroke-width="2" marker-end="url(#arrow)"/>`;
    if (edge.label) body += svgText((a.x + b.x) / 2 + 8, (a.y + b.y) / 2, edge.label, 'class="tick"');
  }
  for (const node of diagram.nodes) {
    const p = points.get(node.id)!;
    body += `<rect x="${p.x - 100}" y="${p.y - 28}" width="200" height="56" rx="12" fill="#f2f5ff" stroke="#dce3fa"/><title>${escape(node.label)}</title>`;
    const parts = Array.from(node.label), short = parts.length > 14 ? parts.slice(0, 13).join('') + '…' : node.label;
    body += svgText(p.x, p.y + 5, short, 'text-anchor="middle"');
  }
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="流程与关系图">${body}</svg>`;
}

/** A portable static view of the same validated data that feeds the Lark adapter. No model HTML or active web content. */
export function nativePresentationHtml(value: PresentationDraft): string {
  const draft = presentationDraft(value);
  const content = draft.kind === 'chart' ? `<div class="visual">${chartSvg(draft.content)}</div><details><summary>查看数据</summary><table><thead><tr><th>类别</th>${draft.content.series.map(s => `<th>${escape(s)}</th>`).join('')}</tr></thead><tbody>${draft.content.data.map(row => `<tr><th>${escape(row.label)}</th>${row.values.map(v => `<td>${number(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`
    : draft.kind === 'diagram' ? `<div class="visual">${diagramSvg(draft.content)}</div><details><summary>查看节点与连接</summary><p>${draft.content.nodes.map(node => escape(node.label)).join(' · ')}</p><ul>${draft.content.edges.map(edge => `<li>${escape(draft.content.nodes.find(node => node.id === edge.from)!.label)} → ${escape(draft.content.nodes.find(node => node.id === edge.to)!.label)}${edge.label ? ` · ${escape(edge.label)}` : ''}</li>`).join('')}</ul></details>`
    : draft.kind === 'report' ? draft.content.sections.map(section => `<section><h2>${escape(section.heading)}</h2><p class="prose">${escape(section.body)}</p></section>`).join('')
    : `<p class="notice">请在飞书卡片中填写并提交，助手会接着你的选择继续。</p>${draft.content.fields.map(field => `<section><h2>${escape(field.label)}</h2>${field.options ? `<ul class="options">${field.options.map(option => `<li>${escape(option.label)}</li>`).join('')}</ul>` : '<div class="placeholder">文本回答</div>'}</section>`).join('')}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>${escape(draft.title)}</title><style>body{margin:0;background:#f6f8fc;color:#243047;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:920px;margin:32px auto;padding:32px;background:#fff;border:1px solid #e6ebf3;border-radius:20px}header{border-bottom:1px solid #edf0f5;padding-bottom:22px;margin-bottom:24px}.eyebrow{font-size:12px;color:#65748e;letter-spacing:.12em}h1{font-size:28px;line-height:1.3;margin:10px 0 12px}h2{font-size:18px;margin:28px 0 10px}p{margin:0 0 12px}.summary{color:#65748e}.visual{overflow:auto}svg{width:100%;min-width:480px;display:block}svg text{font-size:13px;fill:#34425b}.tick{font-size:11px;fill:#65748e}details{border-top:1px solid #edf0f5;margin-top:20px;padding-top:16px}summary{cursor:pointer;color:#405cf5}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{padding:10px;text-align:left;border-bottom:1px solid #edf0f5}th{font-weight:600}.prose{white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:14px 18px;background:#f2f5ff;border-radius:10px}.options{display:flex;flex-wrap:wrap;gap:12px;padding:0;list-style:none}.options li,.placeholder{border:1px solid #dce3ee;border-radius:10px;padding:10px 18px}.placeholder{color:#8793a7}@media(max-width:600px){main{margin:0;border:0;border-radius:0;padding:22px}h1{font-size:24px}}</style></head><body><main><header><div class="eyebrow">DSH · 作品</div><h1>${escape(draft.title)}</h1><p class="summary">${escape(draft.summary)}</p></header>${content}</main></body></html>`;
}

/** Write only a generated immutable snapshot under this session's own workspace; never open a model-supplied path. */
export async function saveNativePresentation(cwd: string, sessionId: string, draft: PresentationDraft): Promise<string> {
  if (!isAbsolute(cwd) || !/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('Invalid presentation owner');
  const root = await realpath(cwd), html = nativePresentationHtml(draft), digest = createHash('sha256').update(html).digest('hex');
  let directory = root;
  for (const part of ['.dsh-lark-results', sessionId]) {
    directory = join(directory, part);
    await mkdir(directory, {mode: 0o700}).catch(error => {if (error.code !== 'EEXIST') throw error;});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Unsafe presentation directory');
  }
  const path = join(directory, `${draft.kind}-${digest.slice(0, 24)}.html`);
  let file;
  try {file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await existing.stat();
      if (!stat.isFile() || stat.size !== Buffer.byteLength(html) || (stat.mode & 0o077)) throw new Error('Unsafe presentation snapshot');
      const buffer = Buffer.alloc(stat.size + 1), {bytesRead} = await existing.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size || buffer.subarray(0, bytesRead).toString('utf8') !== html) throw new Error('Presentation snapshot changed');
    } finally {await existing.close();}
    return path;
  }
  try {await file.writeFile(html); await file.chmod(0o400); await file.sync();} finally {await file.close();}
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {await dir.sync();} finally {await dir.close();}
  return path;
}
