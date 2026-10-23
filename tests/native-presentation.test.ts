import {mkdtemp, readFile, rm, stat, symlink, mkdir, chmod, writeFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it} from 'vitest';
import {nativePresentationHtml, saveNativePresentation} from '../src/native-presentation.js';
import {presentationDraft} from '../src/presentation.js';

const roots: string[] = [], session = '11111111-1111-4111-8111-111111111111';
const chart = presentationDraft({kind: 'chart', title: '方案得分', summary: '依据用户提供的数据。', content: {type: 'bar', series: ['得分'], data: [{label: 'A', values: [65]}, {label: 'B', values: [82]}, {label: 'C', values: [93]}]}});
async function root() {const dir = await mkdtemp(join(tmpdir(), 'dsh-native-presentation-')); roots.push(dir); return dir;}
afterEach(async () => {await Promise.all(roots.splice(0).map(dir => rm(dir, {recursive: true, force: true})));});

describe('native static presentations', () => {
  it('renders the same data visibly with an accessible table and no external dependencies', () => {
    const html = nativePresentationHtml(chart);
    expect(html).toContain('方案得分'); expect(html).toContain('<svg'); expect(html).toContain('<td>93</td>');
    expect(html).toContain("default-src 'none'"); expect(html).not.toMatch(/<(?:script|iframe|link|form)\b|\bsrc=/i);
  });
  it('renders negative, zero and single-value series without NaN or Infinity', () => {
    for (const type of ['bar', 'line', 'pie'] as const) {
      const html = nativePresentationHtml(presentationDraft({...chart, content: {type, series: ['系列'], data: [{label: '类别', values: [type === 'pie' ? 1 : -2]}]}}));
      expect(html).not.toMatch(/NaN|Infinity/); expect(html).toContain('<svg');
    }
  });
  it('keeps hostile markup inert in titles, SVG labels, sections and forms', () => {
    const hostile = '<script>alert(1)</script><img src="https://evil.test">';
    const drafts = [
      presentationDraft({...chart, title: hostile}),
      presentationDraft({kind: 'diagram', title: '图示', summary: hostile, content: {nodes: [{id: 'a', label: hostile}], edges: [{from: 'a', to: 'a', label: '<iframe>'}]}}),
      presentationDraft({kind: 'report', title: '报告', summary: '说明', content: {sections: [{heading: hostile, body: hostile}]}}),
      presentationDraft({kind: 'form', title: '选择', summary: '说明', content: {fields: [{id: 'choice', label: hostile, type: 'text'}]}}),
    ];
    for (const draft of drafts) {
      const html = nativePresentationHtml(draft);
      expect(html).toContain('&lt;script&gt;'); expect(html).not.toMatch(/<script\b|<img\b|<iframe\b/);
      expect(html).not.toMatch(/NaN|Infinity/);
    }
    expect(nativePresentationHtml(drafts[3]!)).toContain('请在飞书卡片中填写并提交');
  });
  it('writes immutable session-scoped snapshots and never overwrites changed content', async () => {
    const cwd = await root(), path = await saveNativePresentation(cwd, session, chart);
    expect(path.startsWith(join(await realpath(cwd), '.dsh-lark-results', session))).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    expect(await saveNativePresentation(cwd, session, chart)).toBe(path);
    const another = await saveNativePresentation(cwd, '22222222-2222-4222-8222-222222222222', chart);
    expect(another).not.toBe(path); expect(await readFile(another, 'utf8')).toBe(await readFile(path, 'utf8'));
    await chmod(path, 0o600); await writeFile(path, 'tampered');
    await expect(saveNativePresentation(cwd, session, chart)).rejects.toThrow();
  });
  it('rejects symlinked output roots and model-controlled path coordinates', async () => {
    const cwd = await root(), outside = await root();
    await symlink(outside, join(cwd, '.dsh-lark-results'));
    await expect(saveNativePresentation(cwd, session, chart)).rejects.toThrow();
    await expect(saveNativePresentation(cwd, '../outside', chart)).rejects.toThrow();
    await expect(saveNativePresentation('relative', session, chart)).rejects.toThrow();
    const insecure = await root(); await mkdir(join(insecure, '.dsh-lark-results'), {mode: 0o755});
    await expect(saveNativePresentation(insecure, session, chart)).rejects.toThrow();
  });
});
