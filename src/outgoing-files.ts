import {realpath, stat} from 'node:fs/promises';
import {basename, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isImageKey, markdownImages, type ReplyImage} from './markdown-images.js';

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REPLY_IMAGES = 4;
const MAX_REPLY_IMAGE_BYTES = 20 * 1024 * 1024;

/** The caller supplies the canonical workspace belonging to this private session. */
export async function uploadable(workspace: string, path: string): Promise<{path: string; image: boolean; size: number} | {reason: string}> {
  let real: string;
  try { real = await realpath(path); } catch { return {reason: '找不到这个文件'}; }
  const inside = relative(workspace, real);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) return {reason: '不在这个私聊的工作区内，没有上传'};
  let info;
  try { info = await stat(real); } catch { return {reason: '无法读取'}; }
  if (!info.isFile()) return {reason: '不是普通文件'};
  if (info.size === 0) return {reason: '是空文件'};
  if (info.size > MAX_FILE_BYTES) return {reason: '超过飞书 30 MB 的文件上限'};
  if (/[\u0000-\u001f\u007f]/.test(basename(real))) return {reason: '文件名含有无法发送的字符'};
  return {path: real, size: info.size, image: /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|heic)$/i.test(real) && info.size <= MAX_IMAGE_BYTES};
}

function localImagePath(workspace: string, source: string): string | undefined {
  if (/^file:/i.test(source)) {
    try { return fileURLToPath(source); } catch { return; }
  }
  // Do not download remote images, decode data URLs, expand ~ or accept platform keys.
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(source) || isImageKey(source)) return;
  try {
    const path = decodeURIComponent(source);
    if (/[\u0000-\u001f\u007f]/.test(path)) return;
    return resolve(workspace, path);
  } catch { return; }
}

/** Prepare only final-answer images, after the native checkpoint, never stream drafts. */
export async function prepareReplyImages(text: string, cwd: string, upload: (path: string) => Promise<string>, signal: AbortSignal) {
  const images = new Map<string, ReplyImage>();
  // Attempted uploads must not be retried by the separate host-file delivery path.
  const attemptedPaths = new Set<string>();
  const cached = new Map<string, ReplyImage>();
  const references = markdownImages(text);
  if (!references.length || signal.aborted) return {images, attemptedPaths};
  const workspace = await realpath(cwd).catch(() => undefined);
  if (!workspace || signal.aborted) return {images, attemptedPaths};
  let totalBytes = 0;
  for (const image of references) {
    if (signal.aborted) break;
    if (images.has(image.source)) continue;
    const path = localImagePath(workspace, image.source);
    if (!path) continue;
    const checked = await uploadable(workspace, path);
    if ('reason' in checked) {images.set(image.source, checked); continue;}
    const previous = cached.get(checked.path);
    if (previous) {images.set(image.source, previous); continue;}
    let prepared: ReplyImage;
    if (!checked.image) prepared = {reason: checked.size > MAX_IMAGE_BYTES ? '超过飞书 10 MB 的图片上限' : '飞书不支持这种图片格式，请导出为 PNG 后再展示'};
    else if (attemptedPaths.size >= MAX_REPLY_IMAGES || totalBytes + checked.size > MAX_REPLY_IMAGE_BYTES) prepared = {reason: '每次回复最多展示 4 张图片、合计 20 MB'};
    else {
      if (signal.aborted) break;
      attemptedPaths.add(checked.path);
      totalBytes += checked.size;
      try {
        const imageKey = await upload(checked.path);
        if (!isImageKey(imageKey)) throw new Error('Unconfirmed image upload');
        prepared = {imageKey};
      } catch { prepared = {reason: '图片上传未确认，未自动重试，请在电脑上查看'}; }
    }
    cached.set(checked.path, prepared);
    images.set(image.source, prepared);
  }
  return {images, attemptedPaths};
}
