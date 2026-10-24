import { chunksByBytes } from './message.js';

export type ReplyPayload =
  | {kind: 'text'; text: string}
  | {kind: 'post'; markdown: string}
  | {kind: 'card'; card: Record<string, unknown>; fallbackText: string};

export interface ReplyAction {
  label: string;
  value: Record<string, string>;
  primary?: boolean;
  confirm?: {title: string; text: string};
}

export interface ReplyPanel {
  title: string;
  summary: string;
  subtitle?: string;
  metrics?: {label: string; value: string; note?: string}[];
  sections: {title?: string; text: string; collapsible?: boolean}[];
  actions?: ReplyAction[];
  actionColumns?: 1 | 2 | 3;
  note?: string;
}

const CARD_BYTES = 24_000;
const POST_BYTES = 24_000;
const WIRE_BYTES = 28_000;
const LONG_ANSWER = 900;
const pointSlice = (text: string, length: number) => Array.from(text).slice(0, length).join('');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** The API JSON-encodes content a second time; escapes count on both layers. */
function fitsEnvelope(msgType: 'interactive' | 'post', content: unknown): boolean {
  return bytes({msg_type: msgType, content: JSON.stringify(content), uuid: 'x'.repeat(50), reply_in_thread: true}) <= WIRE_BYTES;
}

/**
 * Apply at the final text-message boundary, including rich-to-text fallbacks.
 * Text messages understand native mentions even inside Markdown code fences.
 */
export function safePlainText(text: string): string {
  // Do not rely on the server's entity-decoding order. Nested named/numeric
  // angle entities become visible, non-HTML brackets rather than active tags.
  return text.replace(/&(?:(?:amp|#0*38|#x0*26);)*(lt|gt|#0*60|#0*62|#x0*3c|#x0*3e);?/gi,
    (_entity, angle: string) => /^(?:lt|#0*60|#x0*3c)$/i.test(angle) ? '‹' : '›')
    .replace(/<\/?\s*(?:at|person|img|image|a|button|interactive_container)\b[^>]*>/gi,
      tag => tag.replace(/</g, '‹').replace(/>/g, '›'))
    // A mixed or truncated closing delimiter must not leave an active opening.
    .replace(/<(?=\/?\s*(?:at|person|img|image|a|button|interactive_container)\b)/gi, '‹');
}

function externalUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\s<>\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/** Turn unsupported links into visible inert text; preserve ordinary web links. */
function safeLinks(text: string): string {
  let result = '', cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('](', cursor);
    if (start < 0) return result + text.slice(cursor);
    let end = start + 2, depth = 1;
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '(') depth++;
      if (text[end] === ')' && --depth === 0) break;
    }
    if (end >= text.length) return result + text.slice(cursor);
    const destination = text.slice(start + 2, end).trim();
    const url = destination.match(/^(<[^>]+>|\S+?)(?:\s+["'][\s\S]*["'])?$/)?.[1]?.replace(/^<|>$/g, '') ?? '';
    result += text.slice(cursor, start) + (externalUrl(url)
      ? text.slice(start, end + 1)
      : `]（${destination}）`);
    cursor = end + 1;
  }
  return result;
}

function prose(text: string): string {
  let output = text
    .replace(/<(https?:\/\/[^<>\s]+)>/gi, (_match, url: string) => externalUrl(url) ? `[${url}](${url})` : url)
    .replace(/!\[/g, '[');
  output = safeLinks(output);
  output = output.replace(/^( {0,3}\[[^\]\n]+\]):\s*(<?\S+>?)(.*)$/gm,
    (line, label: string, destination: string) => externalUrl(destination.replace(/^<|>$/g, '')) ? line : line.replace(`${label}:`, `${label}：`));
  // Escape entities too, so an encoded <at> cannot become an active tag after decoding.
  output = output.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return output.replace(/^[ \t]*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?[ \t]*$/gm, line => {
    const cells = line.trim().replace(/^\||\|$/g, '').split('|');
    return `| ${cells.map(() => ':---').join(' | ')} |`;
  });
}

function inline(text: string): string {
  let output = '', cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('`', cursor);
    if (start < 0) return output + prose(text.slice(cursor));
    let after = start;
    while (text[after] === '`') after++;
    const ticks = text.slice(start, after);
    let close = text.indexOf(ticks, after);
    while (close >= 0 && (text[close - 1] === '`' || text[close + ticks.length] === '`')) close = text.indexOf(ticks, close + 1);
    if (close < 0) return output + prose(text.slice(cursor));
    output += prose(text.slice(cursor, start)) + text.slice(start, close + ticks.length);
    cursor = close + ticks.length;
  }
  return output;
}

/** Keep fenced/inline code opaque while escaping executable platform extensions in prose. */
function markdown(text: string): {text: string; balanced: boolean; blocks: string[]} {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks: string[] = [];
  let output = '', outside = '', block = '';
  let fence: {character: string; length: number} | undefined;
  for (const line of lines) {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/);
    if (fence) {
      output += line; block += line;
      const close = line.trim();
      if (new RegExp(`^${fence.character}{${fence.length},}$`).test(close)) fence = undefined;
      continue;
    }
    if (opening && !(opening[1]!.startsWith('`') && opening[2]!.includes('`'))) {
      output += inline(outside); outside = '';
      fence = {character: opening[1]![0]!, length: opening[1]!.length};
      output += line; block += line;
      continue;
    }
    outside += line; block += line;
    if (!line.trim()) { blocks.push(block); block = ''; }
  }
  output += inline(outside);
  if (block) blocks.push(block);
  return {text: output, balanced: !fence, blocks};
}

/** Model text for a card markdown element, with platform extensions made inert. */
export function cardMarkdown(text: string): string {
  return markdown(text).text;
}

/** Top-level blocks split at blank lines outside code fences, for cutting long text without breaking Markdown. */
export function markdownBlocks(text: string): string[] {
  return markdown(text).blocks;
}

export function plainLabel(text: string, limit: number): string {
  return pointSlice(text.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/g, '$2').replace(/[`*#_~]/g, '').replace(/\s+/g, ' ').trim(), limit);
}

function cardSummary(panel: ReplyPanel): string {
  const summary = plainLabel(panel.summary, 60);
  if (Array.from(summary).length >= 8) return summary;
  return plainLabel([panel.title, panel.subtitle, summary,
    ...(panel.metrics ?? []).map(metric => `${metric.label} ${metric.value}`),
    ...panel.sections.map(section => section.text)].filter(Boolean).join(' · '), 60);
}

const md = (text: string) => ({tag: 'markdown', content: markdown(text).text, text_align: 'left', text_size: 'normal', margin: '0px'});
const title = (text: string) => ({tag: 'plain_text', content: text});
const muted = (text: string) => ({tag: 'div', text: {...title(safePlainText(text)), text_color: 'grey'}, text_size: 'notation', margin: '0px'});
const column = (elements: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  tag: 'column', width: 'weighted', weight: 1, direction: 'vertical',
  vertical_spacing: '4px', padding: '0px', margin: '0px', elements, ...extra,
});

/** Trusted application panels only. Model strings never choose components or callback values. */
export function renderPanel(panel: ReplyPanel): ReplyPayload {
  const metrics = (panel.metrics ?? []).filter(metric => metric.label.trim() || metric.value.trim());
  const fallbackText = safePlainText([panel.title, panel.subtitle,
    ...metrics.map(metric => [`${metric.label}：${metric.value}`, metric.note].filter(Boolean).join('\n')),
    ...panel.sections.map(section => [section.title, section.text].filter(Boolean).join('\n')), panel.note]
    .filter(Boolean).join('\n\n'));
  const elements: Record<string, unknown>[] = [];
  const actions = panel.actions ?? [];
  for (let start = 0; start < metrics.length; start += 2) {
    elements.push({tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', margin: '0px',
      columns: metrics.slice(start, start + 2).map(metric => column([
        muted(metric.label),
        {...md(`**${metric.value}**`), text_size: 'heading'},
        ...(metric.note?.trim() ? [muted(metric.note)] : []),
      ], {background_style: 'grey', padding: '10px 12px 10px 12px'})),
    });
  }
  for (const section of panel.sections) {
    if (!section.text.trim() && !section.title?.trim()) continue;
    if (section.collapsible && section.text.trim()) {
      elements.push({
        tag: 'collapsible_panel', expanded: false, margin: '0px', padding: '8px 0px 0px 0px', vertical_spacing: '4px',
        header: {
          title: title(plainLabel(section.title ?? '查看详细内容', 80)),
          padding: '6px 0px 6px 0px',
          icon: {tag: 'standard_icon', token: 'down_outlined', color: 'grey'},
          icon_position: 'right', icon_expanded_angle: -180,
        },
        elements: [md(section.text)],
      });
    } else {
      const content = [
        ...(section.title?.trim() ? [md(`**${plainLabel(section.title, 80)}**`)] : []),
        ...(section.text.trim() ? [md(section.text)] : []),
      ];
      // Component spacing replaces Markdown paragraph breaks, whose built-in
      // margins otherwise create a large gap below every section heading.
      elements.push({tag: 'column_set', flex_mode: 'none', margin: '0px', columns: [column(content)]});
    }
  }
  // Explicit option grids keep equal widths on mobile; ordinary action rows
  // retain the compact flow layout used by existing panels.
  const actionColumns = panel.actionColumns ?? 3;
  for (let start = 0; start < actions.length; start += actionColumns) {
    elements.push({tag: 'column_set', flex_mode: panel.actionColumns ? 'none' : 'flow', horizontal_spacing: '8px', margin: '0px', columns: actions.slice(start, start + actionColumns).map(action => column([
      {tag: 'button', text: title(plainLabel(action.label, panel.actionColumns === 1 ? 64 : 24)), type: action.primary ? 'primary' : 'default', width: 'fill', margin: '0px',
        behaviors: [{type: 'callback', value: {...action.value}}],
        ...(action.confirm ? {
          icon: {tag: 'standard_icon', token: 'warning_outlined'},
          confirm: {title: title(plainLabel(action.confirm.title, 80)), text: title(plainLabel(action.confirm.text, 300))},
        } : {}),
      },
    ], {vertical_spacing: '0px'}))});
  }
  if (panel.note?.trim()) elements.push(muted(panel.note));
  const summary = cardSummary(panel);
  // A card without enough actual content for a meaningful summary adds noise.
  if (Array.from(summary).length < 8) return {kind: 'text', text: fallbackText};
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: {compact_width: false, width_mode: 'default', enable_forward: false, enable_forward_interaction: false,
      enable_markdown_autolink: false, summary: {content: summary}},
    header: {template: 'blue', title: title(plainLabel(panel.title, 80)), padding: '10px 16px 10px 16px',
      ...(panel.subtitle?.trim() ? {subtitle: title(safePlainText(panel.subtitle)), vertical_spacing: '4px'} : {})},
    body: {direction: 'vertical', vertical_spacing: '8px', padding: '12px 16px 12px 16px', elements},
  };
  if (bytes(card) > CARD_BYTES || !fitsEnvelope('interactive', card)) return {kind: 'text', text: fallbackText};
  return {kind: 'card', card, fallbackText};
}

/** Keep a short report heading together with the first actual conclusion. */
function leadBlockCount(blocks: string[]): number | undefined {
  const headingOnly = (text: string) => text.trim().split('\n').filter(line => line.trim())
    .every(line => /^\s*(?:#{1,6}\s+[^\n]+|\*\*[^\n]+\*\*)\s*$/.test(line));
  let count = 1;
  while (count < blocks.length && headingOnly(blocks.slice(0, count).join(''))) count++;
  // Avoid cutting Markdown or code mid-block just to manufacture an excerpt.
  // A report without a compact lead stays a fully visible rich post instead.
  if (Array.from(blocks.slice(0, count).join('')).length > 600 || count === blocks.length) return;
  return count;
}

/** Select presentation without asking the model to generate arbitrary card JSON. */
export function renderAnswer(text: string, chunkBytes: number): ReplyPayload[] {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4) throw new Error('Reply byte limit must be an integer >= 4.');
  if (!text.trim()) return [];
  const asText = () => chunksByBytes(safePlainText(text), chunkBytes).map(part => ({kind: 'text' as const, text: part}));
  const formatted = /(^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(|\|[^\n]+\|/u.test(text);
  if (!formatted) return asText();
  const safe = markdown(text);
  if (!safe.balanced) return asText();
  const leadCount = leadBlockCount(safe.blocks);
  if (Array.from(text).length >= LONG_ANSWER && leadCount !== undefined) {
    const first = safe.blocks.slice(0, leadCount).join('');
    const rest = safe.blocks.slice(leadCount).join('');
    const panel = renderPanel({title: 'dsh · 回复', summary: plainLabel(text, 60), sections: [
      {text: first}, {title: '展开详细内容', text: rest, collapsible: true},
    ]});
    if (panel.kind === 'card') return [{...panel, fallbackText: safePlainText(text)}];
  }
  // One post preserves code fences, reference links and tables as a whole. For
  // oversized content use exact text chunks instead of corrupting Markdown.
  const post = {zh_cn: {content: [[{tag: 'md', text: safe.text}]]}};
  if (bytes(post) <= POST_BYTES && fitsEnvelope('post', post)) return [{kind: 'post', markdown: safe.text}];
  return asText();
}
