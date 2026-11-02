import {fromMarkdown} from 'mdast-util-from-markdown';

type Node = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];
export interface MarkdownImage {source: string; alt: string; start: number; end: number; definition?: {start: number; end: number}}
export type ReplyImage = {imageKey: string} | {reason: string};
/** Only the application may populate this map, after validating/uploading an image. */
export type ReplyImages = ReadonlyMap<string, ReplyImage>;

export const isImageKey = (value: unknown): value is string => typeof value === 'string' && /^img_[A-Za-z0-9_-]{1,256}$/.test(value);

/** CommonMark parsing keeps code, escaped syntax and HTML out of the upload path. */
export function markdownImages(text: string): MarkdownImage[] {
  if (!text.includes('![')) return [];
  const root = fromMarkdown(text);
  const definitions = new Map<string, Extract<Node, {type: 'definition'}>>();
  const linked = new Set<string>();
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === 'linkReference') linked.add(node.identifier);
    if (node.type === 'image' || node.type === 'imageReference') nodes.push(node);
    if ('children' in node) node.children.forEach(visit);
  };
  visit(root);
  return nodes.flatMap(node => {
    const definition = node.type === 'imageReference' ? definitions.get(node.identifier) : undefined;
    const source = node.type === 'image' ? node.url : definition?.url;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    const defStart = definition?.position?.start.offset, defEnd = definition?.position?.end.offset;
    return source && start !== undefined && end !== undefined && 'alt' in node
      ? [{source, alt: node.alt ?? '', start, end,
        ...(definition && !linked.has(definition.identifier) && defStart !== undefined && defEnd !== undefined
          ? {definition: {start: defStart, end: defEnd}} : {})}] : [];
  });
}

/**
 * Protect server-confirmed image syntax while the normal sanitizer makes all
 * model-supplied platform tags and image keys inert. Markers cannot occur in
 * the original answer, and only parsed image nodes can introduce one.
 */
export function withReplyImages(text: string, images: ReplyImages | undefined, sanitize: (text: string) => string): string {
  if (!images?.size) return sanitize(text);
  let prefix = 'DSHLARKIMAGE';
  while (text.includes(prefix)) prefix += 'X';
  const replacements: Array<[string, string]> = [];
  const edits = new Map<number, {end: number; text: string}>();
  for (const image of markdownImages(text)) {
    const prepared = images.get(image.source);
    if (!prepared) continue;
    let content: string;
    if ('imageKey' in prepared) {
      if (!isImageKey(prepared.imageKey)) continue;
      // Labels cannot close the image or introduce platform markup.
      const alt = Array.from(image.alt.replace(/[\[\]<>`!\\\r\n]/g, ' ')).slice(0, 200).join('').replace(/&/g, '&amp;') || '图片';
      content = `![${alt}](${prepared.imageKey})`;
    } else {
      content = sanitize(`（图片未显示：${prepared.reason}；电脑上的位置：${image.source}）`);
    }
    const marker = `${prefix}${replacements.length}END`;
    replacements.push([marker, content]);
    edits.set(image.start, {end: image.end, text: marker});
    // Image-only definitions are no longer needed after resolving the image.
    if (image.definition) edits.set(image.definition.start, {end: image.definition.end, text: ''});
  }
  let masked = '', cursor = 0;
  for (const [start, edit] of [...edits].sort(([left], [right]) => left - right)) {
    masked += text.slice(cursor, start) + edit.text;
    cursor = edit.end;
  }
  masked += text.slice(cursor);
  let rendered = sanitize(masked);
  for (const [marker, content] of replacements) rendered = rendered.split(marker).join(content);
  return rendered;
}
