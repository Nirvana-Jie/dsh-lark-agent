import {spawn} from 'node:child_process';
import type {IncomingMessage, IncomingResource} from './message.js';

export interface ImageInput {data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'}
export interface MediaTransport {
  readResource?(resource: IncomingResource, signal: AbortSignal): Promise<Uint8Array>;
  recognizeSpeech?(pcm: Uint8Array, signal: AbortSignal): Promise<string>;
}
export class MediaInputError extends Error {}
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_AUDIO_BYTES = 5 * 1024 * 1024;
export const MAX_INPUT_IMAGES = 4;
export const MAX_INPUT_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_PCM_BYTES = 60 * 16_000 * 2;

/** Fixed local codec invocation; no user/model arguments, URLs, paths or stderr reach the process. */
export function decodeVoice(data: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0',
      '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], {shell: false, windowsHide: true, stdio: 'pipe'});
    let failure: Error | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    let kill: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGTERM');
      kill ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const abort = () => stop(new MediaInputError('语音处理已取消。'));
    signal.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(() => stop(new MediaInputError('语音转码超时，请改发文字。')), 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PCM_BYTES) {stop(new MediaInputError('语音最长支持 60 秒，请分段发送。')); return;}
      if (!failure) chunks.push(Buffer.from(chunk));
    });
    child.stderr.resume();
    child.stdin.on('error', () => stop(new MediaInputError('语音格式无法读取，请改发文字。')));
    child.on('error', () => {failure = new MediaInputError('语音输入需要宿主设备安装 FFmpeg。');});
    child.on('close', code => {
      clearTimeout(timeout); clearTimeout(kill); signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || !size) reject(new MediaInputError('这段语音无法读取，请改发文字。'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(data);
  });
}

/** Only binary discovery, never a download or installation. */
export function ffmpegAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('ffmpeg', ['-version'], {shell: false, windowsHide: true, stdio: 'ignore'});
    const timer = setTimeout(() => {child.kill('SIGKILL'); resolve(false);}, 3000);
    child.on('error', () => {clearTimeout(timer); resolve(false);});
    child.on('close', code => {clearTimeout(timer); resolve(code === 0);});
  });
}

function imageType(data: Uint8Array): ImageInput['mediaType'] {
  const bytes = Buffer.from(data);
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new MediaInputError('图片格式不支持，请发送 PNG、JPEG、WebP 或 GIF。');
}

/** Called inside an admitted lane, after identity, durable claim and current chat access checks. */
export async function prepareMedia(message: IncomingMessage, transport: MediaTransport, signal: AbortSignal,
  options: {images: boolean; voice: boolean; maxText: number}, decode = decodeVoice): Promise<{text: string; images?: ImageInput[]}> {
  const resources = message.resources ?? [];
  if (!resources.length) return {text: message.text};
  if (message.chatType !== 'p2p') throw new MediaInputError('图片和语音输入仅用于本人私聊，请改发文字。');
  if (resources.length > MAX_INPUT_IMAGES) throw new MediaInputError(`每条消息最多支持 ${MAX_INPUT_IMAGES} 张图片，请分开发送。`);
  if (resources.some(resource => resource.kind === 'image') && !options.images) throw new MediaInputError('这个机器人的图片输入已关闭，请在设置中开启。');
  if (resources.some(resource => resource.kind === 'audio') && !options.voice) throw new MediaInputError('这个机器人的语音输入未启用，请在设置中检查 FFmpeg 和飞书语音识别权限，或改发文字。');
  if (!transport.readResource) throw new MediaInputError('当前消息通道无法下载附件，请更新插件。');
  const images: ImageInput[] = [];
  let total = 0, text = message.text;
  for (const resource of resources) {
    signal.throwIfAborted();
    if (resource.kind === 'audio' && resource.duration !== undefined && resource.duration > 60) throw new MediaInputError('语音最长支持 60 秒，请分段发送。');
    let data: Uint8Array;
    try {data = await transport.readResource(resource, signal);} catch {throw new MediaInputError('附件未能下载，请检查机器人的 im:message:readonly 权限和消息是否仍可访问。');}
    signal.throwIfAborted();
    total += data.byteLength;
    if (!data.byteLength || total > MAX_INPUT_TOTAL_BYTES || data.byteLength > (resource.kind === 'image' ? MAX_INPUT_IMAGE_BYTES : MAX_INPUT_AUDIO_BYTES)) {
      throw new MediaInputError('附件超出大小限制：单张图片 10 MB、单段语音 5 MB，每条消息合计 20 MB。');
    }
    if (resource.kind === 'image') images.push({data, mediaType: imageType(data)});
    else {
      if (!transport.recognizeSpeech) throw new MediaInputError('当前消息通道没有语音识别能力，请改发文字。');
      const pcm = await decode(data, signal);
      try {text = (await transport.recognizeSpeech(pcm, signal)).trim();}
      catch {throw new MediaInputError('语音识别失败，请检查 speech_to_text:speech 权限及租户套餐，或改发文字。');}
      if (!text || text.length > options.maxText) throw new MediaInputError('没有得到可用的语音文字，请缩短语音后重试。');
      // A transcript is conversation input. It must never become a slash command or card action.
      text = `用户发来的语音转写（可能有识别误差）：\n${text}`;
    }
  }
  return {text, ...(images.length ? {images} : {})};
}
