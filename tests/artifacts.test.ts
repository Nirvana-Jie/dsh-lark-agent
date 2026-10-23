import {mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ArtifactStore, publishedArtifact} from '../src/artifacts.js';
import {presentationDraft} from '../src/presentation.js';

const paths: string[] = [];
const ctx = {ownerKey: 'a'.repeat(64), conversationKey: 'b'.repeat(64), sessionId: 'c'.repeat(12)};
const draft = presentationDraft({kind: 'report', title: '隔离测试', summary: '只用于离线测试的示例内容。', content: {sections: [{heading: '示例', body: 'private fixture'}]}});
const remote = {documentId: 'doc_fixture', url: 'https://www.feishu.cn/docx/doc_fixture'};
async function fixture() {const dir = await mkdtemp(join(tmpdir(), 'dsh-artifacts-')); paths.push(dir); return {dir, store: await ArtifactStore.open(dir)};}
afterEach(async () => {await Promise.all(paths.splice(0).map(path => rm(path, {recursive: true, force: true})));});

describe('persistent chat-owned artifacts', () => {
  it('persists detached snapshots with private modes, stable request IDs and owner/chat/topic isolation', async () => {
    const {store, dir} = await fixture();
    const row = await store.add(ctx, 'message:1', draft);
    row.draft.title = 'mutated';
    expect((await store.add(ctx, 'message:1', draft)).draft.title).toBe('隔离测试');
    const restored = await ArtifactStore.open(dir);
    expect(await restored.list(ctx)).toHaveLength(1);
    for (const other of [{...ctx, ownerKey: 'd'.repeat(64)}, {...ctx, conversationKey: 'd'.repeat(64)}, {...ctx, sessionId: 'd'.repeat(12)}]) {
      expect(await restored.get(other, row.id)).toBeUndefined(); expect(await restored.list(other)).toEqual([]);
    }
    expect((await stat(join(dir, 'artifacts.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
  it('keeps old versions and rejects stale or cross-user replacement', async () => {
    const {store} = await fixture(), first = await store.add(ctx, '1', draft);
    const second = await store.add(ctx, '2', {...draft, replaces: first.id, title: '更新'});
    expect((await store.list(ctx)).map(row => row.id)).toEqual([second.id]);
    expect((await store.get(ctx, first.id))?.draft.title).toBe('隔离测试');
    await expect(store.add(ctx, '3', {...draft, replaces: first.id})).rejects.toThrow('版本');
    await expect(store.add({...ctx, ownerKey: 'd'.repeat(64)}, '4', {...draft, replaces: second.id})).rejects.toThrow();
  });
  it('keeps active claims exclusive and only permits reconciliation when the document ID is known', async () => {
    const {store, dir} = await fixture(), row = await store.add(ctx, '1', draft);
    await store.claimPublish(ctx, row.id);
    await store.publication(ctx, row.id, {documentId: remote.documentId});
    const restored = await ArtifactStore.open(dir);
    await expect(restored.claimPublish(ctx, row.id)).rejects.toThrow();
    expect((await restored.get(ctx, row.id))?.pendingDocumentId).toBe(remote.documentId);
    await restored.publication(ctx, row.id, {uncertain: true});
    expect((await restored.claimPublish(ctx, row.id)).pendingDocumentId).toBe(remote.documentId);
    const unknown = await restored.add(ctx, '2', draft);
    await restored.claimPublish(ctx, unknown.id); await restored.publication(ctx, unknown.id, {uncertain: true});
    await expect(restored.claimPublish(ctx, unknown.id)).rejects.toThrow();
  });
  it('restores a verified remote reference, rejecting cross-owner updates and untrusted links', async () => {
    const {store, dir} = await fixture(), row = await store.add(ctx, '1', draft);
    await store.claimPublish(ctx, row.id);
    await expect(store.publication({...ctx, ownerKey: 'd'.repeat(64)}, row.id, {remote})).rejects.toThrow();
    await store.publication(ctx, row.id, {remote});
    expect((await (await ArtifactStore.open(dir)).get(ctx, row.id))?.remote).toEqual(remote);
    for (const url of ['http://www.feishu.cn/docx/doc_fixture', 'https://www.feishu.cn.evil/docx/doc_fixture', 'https://www.feishu.cn/docx/another', 'https://www.feishu.cn/docx/doc_fixture?token=private']) expect(() => publishedArtifact({...remote, url})).toThrow();
  });
  it('validates form data before consuming it and prevents repeated submission across restarts', async () => {
    const {store, dir} = await fixture();
    const row = await store.add(ctx, '1', presentationDraft({kind: 'form', title: '测试表单', summary: '离线测试表单，选择语言。', content: {fields: [{id: 'language', label: '语言', type: 'select', options: [{value: 'zh', label: '中文'}]}]}}));
    await expect(store.submit(ctx, row.id, {language: 'forged'})).rejects.toThrow();
    const prompt = await store.submit(ctx, row.id, {language: 'zh'});
    expect(prompt).toContain('中文'); expect(prompt).toContain('用户提供的数据');
    await expect((await ArtifactStore.open(dir)).submit(ctx, row.id, {language: 'zh'})).rejects.toThrow('已提交');
  });
  it('fails closed on corrupted or linked state instead of resetting stored content', async () => {
    const {dir, store} = await fixture(); await store.add(ctx, '1', draft);
    const source = await readFile(join(dir, 'artifacts.json'), 'utf8');
    await writeFile(join(dir, 'artifacts.json'), source.replace('"version":1', '"version":2'));
    await expect(ArtifactStore.open(dir)).rejects.toThrow();
    await rm(join(dir, 'artifacts.json')); await writeFile(join(dir, 'linked.json'), source);
    await symlink(join(dir, 'linked.json'), join(dir, 'artifacts.json'));
    await expect(ArtifactStore.open(dir)).rejects.toThrow();
  });
});
