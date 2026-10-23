import {renderPanel, safePlainText, type ReplyPayload} from './replies.js';

export interface ChartContent {type: 'bar' | 'line' | 'pie'; series: string[]; data: {label: string; values: number[]}[]}
export interface DiagramContent {nodes: {id: string; label: string}[]; edges: {from: string; to: string; label?: string}[]}
export interface ReportContent {sections: {heading: string; body: string}[]}
export interface FormField {id: string; label: string; type: 'text' | 'select'; required: boolean; options?: {value: string; label: string}[]}
export interface FormContent {fields: FormField[]}
interface DraftBase {title: string; summary: string; replaces?: string}
export type PresentationDraft = DraftBase & (
  | {kind: 'chart'; content: ChartContent} | {kind: 'diagram'; content: DiagramContent}
  | {kind: 'report'; content: ReportContent} | {kind: 'form'; content: FormContent});
/** A file the host's own delivery tool presented; the path is absolute and not yet validated for upload. */
export interface DeliveredFile {path: string; description: string}
export interface TurnResult {text: string; artifacts: PresentationDraft[]; reasoning?: string; files?: DeliveredFile[]}
export const PRESENT_TOOL = 'lark_present';
export const PRESENTATION_GUIDE = '需要图表、流程图、长报告或收集选项时，可以调用 lark_present。普通聊天和代码解释直接用文字。工具只准备当前聊天的展示内容，不执行 HTML/JavaScript，不读取文件，不扩大任何人的权限。图表数据必须来自用户或已核实的资料；示例数据必须在标题或摘要标明“示例”。表单只收集完成当前任务必需的普通信息，不索取密码、密钥或其他敏感凭据。不要重复输出已提交工具的整份内容，也不要声称已创建云文档或链接；以系统最终展示结果为准。修改已展示作品时，只使用当前聊天提供的作品 ID 作为 replaces，保留原版。';

export class PresentationError extends Error {
  constructor(message = '展示内容不符合格式要求，请缩小内容或改用文字。') {super(message); this.name = 'PresentationError';}
}
export function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new PresentationError();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some(key => !names.includes(key))) throw new PresentationError();
}
function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u : /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u).test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new PresentationError();
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(value)
    || ['constructor', 'prototype', '__proto__'].includes(value)) throw new PresentationError();
  return value;
}
function array(value: unknown, max: number, empty = false): unknown[] {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > max) throw new PresentationError();
  return value;
}
function unique(values: string[]): void {if (new Set(values).size !== values.length) throw new PresentationError();}

/** The model supplies data, never executable card JSON, paths, recipients or permission policy. */
export function presentationDraft(value: unknown): PresentationDraft {
  const input = plainRecord(value);
  keys(input, ['kind', 'title', 'summary', 'content', 'replaces']);
  const base: DraftBase = {title: text(input.title, 80), summary: text(input.summary, 600, true)};
  if (input.replaces !== undefined) {
    if (typeof input.replaces !== 'string' || !/^[a-f0-9]{12}$/.test(input.replaces)) throw new PresentationError();
    base.replaces = input.replaces;
  }
  const content = plainRecord(input.content);
  let draft: PresentationDraft;
  if (input.kind === 'chart') {
    keys(content, ['type', 'series', 'data']);
    if (!['bar', 'line', 'pie'].includes(content.type as string)) throw new PresentationError();
    const series = array(content.series, 4).map(value => text(value, 40)); unique(series);
    const data = array(content.data, 24).map(value => {
      const row = plainRecord(value); keys(row, ['label', 'values']);
      const values = array(row.values, 4).map(n => {
        if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e12) throw new PresentationError(); return n;
      });
      if (values.length !== series.length) throw new PresentationError();
      return {label: text(row.label, 40), values};
    }); unique(data.map(row => row.label));
    if (content.type === 'pie' && (series.length !== 1 || data.some(row => row.values[0]! < 0) || !data.some(row => row.values[0]! > 0))) throw new PresentationError();
    draft = {...base, kind: 'chart', content: {type: content.type as ChartContent['type'], series, data}};
  } else if (input.kind === 'diagram') {
    keys(content, ['nodes', 'edges']);
    const nodes = array(content.nodes, 16).map(value => {const node = plainRecord(value); keys(node, ['id', 'label']); return {id: id(node.id), label: text(node.label, 80)};});
    unique(nodes.map(node => node.id));
    const ids = new Set(nodes.map(node => node.id));
    const edges = array(content.edges, 24, true).map(value => {
      const edge = plainRecord(value); keys(edge, ['from', 'to', 'label']);
      const from = id(edge.from), to = id(edge.to);
      if (!ids.has(from) || !ids.has(to)) throw new PresentationError();
      return {from, to, ...(edge.label === undefined ? {} : {label: text(edge.label, 50)})};
    });
    draft = {...base, kind: 'diagram', content: {nodes, edges}};
  } else if (input.kind === 'report') {
    keys(content, ['sections']);
    const sections = array(content.sections, 20).map(value => {
      const section = plainRecord(value); keys(section, ['heading', 'body']);
      return {heading: text(section.heading, 80), body: text(section.body, 4000, true)};
    });
    draft = {...base, kind: 'report', content: {sections}};
  } else if (input.kind === 'form') {
    keys(content, ['fields']);
    const fields = array(content.fields, 5).map(value => {
      const field = plainRecord(value); keys(field, ['id', 'label', 'type', 'required', 'options']);
      if (!['text', 'select'].includes(field.type as string) || (field.required !== undefined && typeof field.required !== 'boolean')) throw new PresentationError();
      const fieldId = id(field.id);
      if (['dsh_submit', 'dsh_result_form'].includes(fieldId)) throw new PresentationError();
      const result: FormField = {id: fieldId, label: text(field.label, 80), type: field.type as FormField['type'], required: field.required ?? true};
      if (field.type === 'select') {
        result.options = array(field.options, 10).map(value => {const option = plainRecord(value); keys(option, ['value', 'label']); return {value: id(option.value), label: text(option.label, 60)};});
        unique(result.options.map(option => option.value));
      } else if (field.options !== undefined) throw new PresentationError();
      return result;
    }); unique(fields.map(field => field.id));
    draft = {...base, kind: 'form', content: {fields}};
  } else throw new PresentationError();
  if (Buffer.byteLength(JSON.stringify(draft)) > 36_000) throw new PresentationError();
  return draft;
}

/** Local form values are untrusted user input; validate against the saved schema. */
export function formAnswers(form: FormContent, value: unknown): Record<string, string> {
  const input = plainRecord(value); keys(input, form.fields.map(field => field.id));
  const result: Record<string, string> = {};
  for (const field of form.fields) {
    const raw = input[field.id];
    if ((raw === undefined || raw === '') && !field.required) continue;
    const answer = text(raw, field.type === 'text' ? 1000 : 24, field.type === 'text');
    if (field.type === 'select' && !field.options!.some(option => option.value === answer)) throw new PresentationError('选项已失效，请重新生成表单。');
    result[field.id] = answer;
  }
  return result;
}

export function presentationText(draft: PresentationDraft): string {
  const body = draft.kind === 'chart' ? draft.content.data.map(row => `${row.label}：${row.values.map((n, i) => `${draft.content.series[i]} ${n}`).join('，')}`).join('\n')
    : draft.kind === 'diagram' ? [draft.content.nodes.map(node => node.label).join('、'), ...draft.content.edges.map(edge => `${draft.content.nodes.find(n => n.id === edge.from)!.label} → ${draft.content.nodes.find(n => n.id === edge.to)!.label}${edge.label ? `（${edge.label}）` : ''}`)].join('\n')
    : draft.kind === 'report' ? draft.content.sections.map(section => `${section.heading}\n${section.body}`).join('\n\n')
    : draft.content.fields.map(field => `${field.label}${field.options ? `：${field.options.map(option => option.label).join(' / ')}` : ''}`).join('\n');
  return safePlainText(`${draft.title}\n\n${draft.summary}\n\n${body}`);
}

/** Labels are quoted and encoded; the model cannot introduce Mermaid directives or click actions. */
export function diagramMermaid(content: DiagramContent): string {
  const quote = (value: string) => Array.from(value).map(char => /[\p{L}\p{N} ]/u.test(char) ? char : `#${char.codePointAt(0)};`).join('');
  return ['flowchart TD', ...content.nodes.map(node => `  ${node.id}["${quote(node.label)}"]`),
    ...content.edges.map(edge => `  ${edge.from} -->${edge.label ? `|"${quote(edge.label)}"|` : ''} ${edge.to}`)].join('\n');
}

export function presentationCard(draft: PresentationDraft, options: {token?: string; remote?: {url: string; imageKey?: string}; note?: string} = {}): ReplyPayload {
  const fallbackText = presentationText(draft);
  if (draft.kind === 'form' && !options.token && !options.note) return {kind: 'text', text: `${fallbackText}\n\n可以直接在聊天里告诉我。`};
  const base = renderPanel({title: draft.title, summary: `${draft.title}：${draft.summary} · 查看内容`, sections: [{text: draft.summary}], note: options.note});
  if (base.kind !== 'card') return {kind: 'text', text: fallbackText};
  const card = base.card;
  const body = card.body as {elements: Record<string, unknown>[]};
  const plain = (content: string) => ({tag: 'plain_text', content: safePlainText(content)});
  if (draft.kind === 'chart') {
    const content = draft.content;
    const values = content.data.flatMap(row => content.series.map((series, i) => ({category: row.label, series, value: row.values[i]!})));
    const chart = content.type === 'pie' ? {type: 'pie', valueField: 'value', categoryField: 'category', outerRadius: 0.8, legends: {visible: true, orient: 'bottom'}}
      : {type: content.type, xField: content.type === 'bar' && content.series.length > 1 ? ['category', 'series'] : 'category', yField: 'value', seriesField: 'series', legends: {visible: content.series.length > 1, orient: 'bottom'}};
    body.elements.push({tag: 'chart', aspect_ratio: '4:3', chart_spec: {...chart, data: [{id: 'data', values}], color: ['#405CF5', '#14B8A6', '#F59E0B', '#8B5CF6']}});
  } else if (draft.kind === 'form' && options.token) {
    body.elements.push({tag: 'form', name: 'dsh_result_form', elements: [
      ...draft.content.fields.map(field => field.type === 'text'
        ? {tag: 'input', name: field.id, label: plain(field.label), label_position: 'top', input_type: 'text', max_length: 1000, required: field.required, width: 'fill'}
        : {tag: 'select_static', name: field.id, placeholder: plain(field.label), required: field.required, width: 'fill', behaviors: [], options: field.options!.map(option => ({text: plain(option.label), value: option.value}))}),
      {tag: 'button', name: 'dsh_submit', form_name: 'dsh_result_form', text: plain('提交并继续'), type: 'primary', action_type: 'form_submit', form_action_type: 'submit',
        icon: {tag: 'standard_icon', token: 'send_outlined'}, behaviors: [{type: 'callback', value: {token: options.token}}]},
    ]});
  } else {
    if (options.remote?.imageKey) body.elements.push({tag: 'img', img_key: options.remote.imageKey, alt: plain(draft.title), mode: 'fit_horizontal', preview: true});
    else if (draft.kind === 'report') {
      body.elements.push({tag: 'div', text: plain(draft.content.sections.map(section => section.heading).join(' · '))});
      const detail = renderPanel({title: draft.title, summary: `${draft.title}：查看完整说明`, sections: draft.content.sections.map(section => ({title: section.heading, text: section.body, collapsible: true}))});
      if (!options.remote) {
        if (detail.kind === 'card') body.elements.push(...(detail.card.body as {elements: Record<string, unknown>[]}).elements);
        else return {kind: 'text', text: fallbackText};
      }
    } else if (draft.kind === 'diagram') body.elements.push({tag: 'div', text: plain(draft.content.nodes.map(node => node.label).join(' · '))});
    else body.elements.push({tag: 'div', text: plain(draft.content.fields.map(field => field.label).join(' · '))});
    if (options.remote) body.elements.push({tag: 'button', text: plain(draft.kind === 'diagram' ? '打开画板' : '阅读完整内容'), type: 'primary',
      behaviors: [{type: 'open_url', default_url: options.remote.url}]});
    else if (options.token) body.elements.push({tag: 'button', text: plain(draft.kind === 'diagram' ? '生成飞书画板' : '生成飞书文档'), type: 'primary',
      behaviors: [{type: 'callback', value: {token: options.token}}]});
  }
  if (Buffer.byteLength(JSON.stringify({msg_type: 'interactive', content: JSON.stringify(card)})) > 27_000) return {kind: 'text', text: fallbackText};
  return {kind: 'card', card, fallbackText: options.remote ? `${fallbackText}\n\n${options.remote.url}` : fallbackText};
}
