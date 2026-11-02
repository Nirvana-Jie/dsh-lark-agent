import {mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {markdownImages} from '../src/markdown-images.js';
import {prepareReplyImages} from '../src/outgoing-files.js';

const directories: string[] = [];
afterEach(async () => {await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'lark-reply-images-')); directories.push(directory);
  const workspace = join(await realpath(directory), 'workspace'); await mkdir(workspace);
  const upload = vi.fn(async (_path: string) => 'img_v3_fixture');
  const controller = new AbortController();
  const file = async (name: string, size = 10) => {
    const path = join(workspace, name); await writeFile(path, 'image'); await truncate(path, size); return path;
  };
  return {workspace, upload, controller, file,
    prepare: (text: string) => prepareReplyImages(text, workspace, upload, controller.signal)};
}

describe('final answer image discovery', () => {
  it('parses relative paths, spaces, balanced/escaped parentheses, titles and references', () => {
    const text = '![图](review/chart_(one).png "标题")\n![空格](<review/chart two.png>)\n![转义](chart\\(two\\).png)\n![引用][ CHART ]\n\n[chart]: review/chart%20three.png';
    expect(markdownImages(text).map(image => [image.alt, image.source, text.slice(image.start, image.end)])).toEqual([
      ['图', 'review/chart_(one).png', '![图](review/chart_(one).png "标题")'],
      ['空格', 'review/chart two.png', '![空格](<review/chart two.png>)'],
      ['转义', 'chart(two).png', '![转义](chart\\(two\\).png)'],
      ['引用', 'review/chart%20three.png', '![引用][ CHART ]'],
    ]);
  });

  it('ignores ordinary links, escaped images, fenced/inline/indented code and HTML', () => {
    const text = '[download](file.png)\n\\![escaped](file.png)\n`![code](file.png)`\n\n~~~md\n![code](file.png)\n~~~\n\n    ![code](file.png)\n\n<!-- ![comment](file.png) -->\n<img src="file.png">';
    expect(markdownImages(text)).toEqual([]);
  });
});

describe('workspace image uploads', () => {
  it('resolves paths against the saved workspace and uploads aliases only once', async () => {
    const h = await setup(), path = await h.file('chart one.png');
    await symlink(path, join(h.workspace, 'alias.png'));
    const refs = ['chart%20one.png', './chart%20one.png', 'alias.png', pathToFileURL(path).href, path];
    const result = await h.prepare(refs.map(ref => `![图](<${ref}>)`).join('\n'));
    expect(h.upload).toHaveBeenCalledExactlyOnceWith(path);
    expect([...result.images.values()]).toEqual(refs.map(() => ({imageKey: 'img_v3_fixture'})));
    expect([...result.attemptedPaths]).toEqual([path]);
  });

  it('rejects traversal, sibling-prefix paths, symlink escapes, directories, missing and empty files', async () => {
    const h = await setup();
    const outside = join(h.workspace, '..', 'private.png'); await writeFile(outside, 'private');
    await mkdir(h.workspace + '-other'); await writeFile(join(h.workspace + '-other', 'private.png'), 'private');
    await symlink(outside, join(h.workspace, 'escape.png')); await h.file('empty.png', 0); await mkdir(join(h.workspace, 'folder.png'));
    const sources = ['../private.png', '../workspace-other/private.png', 'escape.png', 'folder.png', 'missing.png', 'empty.png'];
    const result = await h.prepare(sources.map(source => `![图](${source})`).join('\n'));
    expect(h.upload).not.toHaveBeenCalled();
    expect([...result.images.values()]).toEqual([
      {reason: '不在这个私聊的工作区内，没有上传'}, {reason: '不在这个私聊的工作区内，没有上传'}, {reason: '不在这个私聊的工作区内，没有上传'},
      {reason: '不是普通文件'}, {reason: '找不到这个文件'}, {reason: '是空文件'},
    ]);
  });

  it('does not download URLs, accept model-supplied image keys or upload code examples', async () => {
    const h = await setup(); await h.file('chart.png');
    const sources = ['https://images.example/chart.png', '//images.example/chart.png', 'data:image/png;base64,abc', 'file://other-host/private.png', 'img_v3_forged'];
    const result = await h.prepare(sources.map(source => `![图](${source})`).join('\n') + '\n`![example](chart.png)`');
    expect(result.images.size).toBe(0); expect(h.upload).not.toHaveBeenCalled();
  });

  it('bounds each image, aggregate bytes and count, and names unsupported formats', async () => {
    const h = await setup();
    await h.file('big.png', 10 * 1024 * 1024 + 1); await h.file('vector.svg');
    for (const name of ['a.png', 'b.png', 'c.png']) await h.file(name, 10 * 1024 * 1024);
    const result = await h.prepare(['big.png', 'vector.svg', 'a.png', 'b.png', 'c.png'].map(name => `![](${name})`).join('\n'));
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(result.images.get('big.png')).toEqual({reason: '超过飞书 10 MB 的图片上限'});
    expect(result.images.get('vector.svg')).toMatchObject({reason: expect.stringContaining('PNG')});
    expect(result.images.get('c.png')).toMatchObject({reason: expect.stringContaining('20 MB')});
    for (let index = 0; index < 5; index++) await h.file(`${index}.png`);
    h.upload.mockClear();
    await h.prepare(Array.from({length: 5}, (_, index) => `![](${index}.png)`).join('\n'));
    expect(h.upload).toHaveBeenCalledTimes(4);
  });

  it.each(['timeout', 'invalid key'])('remembers an unconfirmed upload without retrying aliases: %s', async mode => {
    const h = await setup(), path = await h.file('chart.png');
    if (mode === 'timeout') h.upload.mockRejectedValue(new Error('timeout'));
    else h.upload.mockResolvedValue('https://untrusted.example/image');
    const result = await h.prepare('![a](chart.png)\n![b](./chart.png)');
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(result.images.get('chart.png')).toEqual(result.images.get('./chart.png'));
    expect(result.images.get('chart.png')).toMatchObject({reason: expect.stringContaining('未自动重试')});
    expect(result.attemptedPaths.has(path)).toBe(true);
  });

  it('stops preparing images when cancelled before or during an upload', async () => {
    const h = await setup(); await h.file('a.png'); await h.file('b.png');
    h.upload.mockImplementation(async () => {h.controller.abort(); return 'img_v3_fixture';});
    await h.prepare('![a](a.png)\n![b](b.png)');
    expect(h.upload).toHaveBeenCalledTimes(1);
    await h.prepare('![a](a.png)'); expect(h.upload).toHaveBeenCalledTimes(1);
  });
});
