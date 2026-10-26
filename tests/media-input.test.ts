import {describe, expect, it, vi} from 'vitest';
import {parseMessage, type IncomingMessage} from '../src/message.js';
import {decodeVoice, ffmpegAvailable, MAX_INPUT_IMAGE_BYTES, prepareMedia} from '../src/media-input.js';
import {execFileSync} from 'node:child_process';

const event = (message_type: string, content: string, extra = {}) => ({type: 'im.message.receive_v1', sender_type: 'user',
  sender_id: 'ou_owner', chat_id: 'oc_private', message_id: 'om_source', chat_type: 'p2p', message_type, content, ...extra});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3GAAAAAASUVORK5CYII=', 'base64');
const signal = () => new AbortController().signal;
const options = {images: true, voice: true, maxText: 16000};

describe('compact incoming media', () => {
  it('reads image events and inline post images using the official CLI renderings', () => {
    const image = parseMessage(event('image', '[Image: img_fixture]'), 'ou_bot')!;
    expect(image.resources).toEqual([{kind: 'image', key: 'img_fixture', messageId: 'om_source'}]);
    expect(image.text).toContain('图片');
    const post = parseMessage(event('post', '请比较\n![Image](img_first)\n![Image](img_second)\n![Image](img_first)'), 'ou_bot')!;
    expect(post.resources?.map(row => row.key)).toEqual(['img_first', 'img_second']);
    expect(post.text).toBe('请比较');
    expect(parseMessage(event('text', '![Image](img_fake)'), 'ou_bot')?.resources).toBeUndefined();
  });
  it('keeps sender, bot mention and source-message checks before attachment handling', () => {
    expect(parseMessage(event('image', '[Image: img_fixture]', {sender_type: 'bot'}), 'ou_bot')).toBeUndefined();
    expect(parseMessage(event('image', '[Image: img_fixture]', {chat_type: 'group'}), 'ou_bot')).toBeUndefined();
    expect(parseMessage(event('image', '[Image: ../../secret]'), 'ou_bot')).toBeUndefined();
    expect(parseMessage(event('image', '{"image_key":"img_fixture"}'), 'ou_bot')).toBeUndefined();
    expect(parseMessage(event('audio', '<audio key="file_voice" duration="42s"/>'), 'ou_bot')?.resources)
      .toEqual([{kind: 'audio', key: 'file_voice', messageId: 'om_source', duration: 42}]);
    expect(parseMessage(event('audio', '<audio key="https://evil.test/audio"/>'), 'ou_bot')).toBeUndefined();
  });
});

describe('private media admission', () => {
  it('decodes an actual local Opus clip into bounded 16 kHz mono PCM', async context => {
    if (!await ffmpegAvailable()) {context.skip(); return;}
    const opus = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-c:a', 'libopus', '-f', 'opus', 'pipe:1'], {timeout: 5000});
    const pcm = await decodeVoice(opus, signal());
    expect(pcm.byteLength).toBeGreaterThan(0); expect(pcm.byteLength).toBeLessThanOrEqual(0.12 * 16000 * 2);
  });
  const message = (kind: 'image' | 'audio' = 'image'): IncomingMessage => ({messageId: 'om_reply_root', chatId: 'oc_private',
    senderId: 'ou_owner', chatType: 'p2p', threadId: 'omt_topic', text: '请分析', resources: [{kind, key: kind === 'image' ? 'img_fixture' : 'file_voice', messageId: 'om_source'}]});
  it('downloads the original source resource and preserves its bytes and caption', async () => {
    const readResource = vi.fn(async () => png);
    const result = await prepareMedia(message(), {readResource}, signal(), options);
    expect(readResource).toHaveBeenCalledWith({kind: 'image', key: 'img_fixture', messageId: 'om_source'}, expect.any(AbortSignal));
    expect(result).toEqual({text: '请分析', images: [{mediaType: 'image/png', data: png}]});
  });
  it('rejects groups, disabled input and excess count before any download', async () => {
    const readResource = vi.fn(async () => png);
    await expect(prepareMedia({...message(), chatType: 'group'}, {readResource}, signal(), options)).rejects.toThrow('本人私聊');
    await expect(prepareMedia(message(), {readResource}, signal(), {...options, images: false})).rejects.toThrow('已关闭');
    await expect(prepareMedia({...message(), resources: Array(5).fill(message().resources![0])}, {readResource}, signal(), options)).rejects.toThrow('4 张');
    await expect(prepareMedia(message('audio'), {readResource}, signal(), {...options, voice: false})).rejects.toThrow('未启用');
    expect(readResource).not.toHaveBeenCalled();
  });
  it('refuses empty, oversized and non-raster resources without passing partial images', async () => {
    for (const data of [Buffer.alloc(0), Buffer.alloc(MAX_INPUT_IMAGE_BYTES + 1), Buffer.from('<svg><script/></svg>')]) {
      await expect(prepareMedia(message(), {readResource: async () => data}, signal(), options)).rejects.toThrow();
    }
    const m = message(); m.resources!.push({...m.resources![0]!, key: 'img_second'});
    const readResource = vi.fn().mockResolvedValueOnce(png).mockRejectedValueOnce(new Error('PRIVATE_PLATFORM_BODY'));
    await expect(prepareMedia(m, {readResource}, signal(), options)).rejects.toThrow('附件未能下载');
  });
  it('transcribes bounded voice as conversation text, including a transcript that resembles a command', async () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const decode = vi.fn(async () => pcm);
    const recognizeSpeech = vi.fn(async () => '/new');
    const result = await prepareMedia(message('audio'), {readResource: async () => Buffer.from('voice'), recognizeSpeech}, signal(), options, decode);
    expect(recognizeSpeech).toHaveBeenCalledWith(pcm, expect.any(AbortSignal));
    expect(result.text).toContain('/new'); expect(result.text.startsWith('/')).toBe(false);
    expect(result.text).toContain('可能有识别误差');
  });
  it('rejects long voice before decoding and sanitizes recognition failures', async () => {
    const long = message('audio'); long.resources![0]!.duration = 61;
    const readResource = vi.fn(async () => Buffer.from('voice'));
    const decode = vi.fn(async () => Buffer.from([1, 2]));
    await expect(prepareMedia(long, {readResource}, signal(), options, decode)).rejects.toThrow('60 秒');
    expect(readResource).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
    await expect(prepareMedia(message('audio'), {readResource, recognizeSpeech: async () => {throw new Error('PRIVATE_TOKEN');}}, signal(), options, decode)).rejects.toThrow('租户套餐');
    await expect(prepareMedia(message('audio'), {readResource, recognizeSpeech: async () => ''}, signal(), options, decode)).rejects.toThrow('没有得到');
  });
  it('does not admit downloaded media after cancellation', async () => {
    const aborter = new AbortController();
    const readResource = vi.fn(async () => {aborter.abort(); return png;});
    await expect(prepareMedia(message(), {readResource}, aborter.signal, options)).rejects.toThrow();
  });
});
