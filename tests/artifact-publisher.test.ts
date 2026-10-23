import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {LarkArtifactPublisher} from '../src/artifact-publisher.js';
import type {SavedArtifact} from '../src/artifacts.js';
import {diagramMermaid, presentationDraft} from '../src/presentation.js';
import {DOCUMENT_SCOPES} from '../src/rich-scopes.js';
import type {PlatformRunner} from '../src/onboarding/lark-platform.js';

const permissions = {external_access_entity: 'closed', link_share_entity: 'closed', manage_collaborator_entity: 'collaborator_full_access',
  share_entity: 'same_tenant', security_entity: 'only_full_access', copy_entity: 'only_full_access', comment_entity: 'anyone_can_edit'};
const saved = (kind: 'diagram' | 'report' = 'diagram'): SavedArtifact => ({id: 'a'.repeat(12), rootId: 'a'.repeat(12), ownerKey: 'b'.repeat(64), conversationKey: 'c'.repeat(64), sessionId: 'd'.repeat(12),
  createdAt: 1, publication: 'publishing', draft: presentationDraft({kind, title: 'PRIVATE_TITLE', summary: 'PRIVATE_SUMMARY', content: kind === 'diagram'
    ? {nodes: [{id: 'a', label: '用户'}, {id: 'b', label: '服务'}], edges: [{from: 'a', to: 'b'}]}
    : {sections: [{heading: 'PRIVATE_SECTION', body: '<img src="http://localhost/secret"> is inert text'}]}})});
function fixture() {
  let granted = false;
  const app = {member_type: 'appid', member_id: 'cli_fixture', perm: 'full_access'};
  const replies = {permissions: {...permissions}, initialMembers: [app] as unknown[], finalMembers: [app, {member_type: 'openid', member_id: 'ou_owner', perm: 'view', type: 'user'}] as unknown[], scopes: [...DOCUMENT_SCOPES] as string[],
    blocks: [{block_id: 'doc_fixture', block_type: 1}] as unknown[],
    nodes: [] as unknown[],
    image: Buffer.from('<svg>not a raster image</svg>')};
  const steps: string[] = [];
  const run = vi.fn<PlatformRunner>(async (args, options) => {
    if (args[0] === 'profile') return JSON.stringify([{name: 'dedicated', appId: 'cli_fixture', brand: 'feishu'}]);
    const at = args.indexOf('api'), path = args[at + 2], method = args[at + 1];
    const success = (data: unknown) => JSON.stringify({ok: true, identity: 'bot', data});
    if (args.includes('+update')) {steps.push('diagram'); return success({created_node_id: 't1:2'});}
    if (path === '/open-apis/application/v6/scopes') return success({scopes: replies.scopes.map(scope_name => ({scope_name, grant_status: 1}))});
    if (path === '/open-apis/docx/v1/documents') {steps.push('create'); return success({document: {document_id: 'doc_fixture'}});}
    if (path?.endsWith('/public')) {steps.push(`${method}:public`); return success({permission_public: replies.permissions});}
    if (path?.endsWith('/members')) {
      steps.push(`${method}:members`);
      if (method === 'POST') {granted = true; return success({member: replies.finalMembers[0]});}
      return success({items: granted ? replies.finalMembers : replies.initialMembers});
    }
    if (path?.endsWith('/children')) {
      steps.push('content');
      const input = JSON.parse(options.stdin!);
      return success({children: input.children.map((block: {block_type: number}) => block.block_type === 43 ? {...block, board: {token: 'board_fixture'}} : block)});
    }
    if (path?.endsWith('/blocks')) {steps.push('read-blocks'); return success({items: replies.blocks, has_more: false});}
    if (path?.endsWith('/nodes')) {steps.push('read-nodes'); return success({nodes: replies.nodes});}
    if (path?.endsWith('/download_as_image')) {
      await writeFile(join(options.cwd!, 'preview.bin'), replies.image); return success({file: 'preview.bin'});
    }
    if (path === '/open-apis/im/v1/images') {steps.push('image'); return success({image_key: 'img_fixture'});}
    throw new Error('Unexpected test call');
  });
  const publisher = new LarkArtifactPublisher('dedicated', 'ou_bot', {run});
  const signal = new AbortController().signal;
  return {publisher, run, replies, steps, signal};
}

describe('private cloud publication', () => {
  it('seals and verifies an empty document before content, and grants only the verified owner', async () => {
    const f = fixture(); await f.publisher.preflight(true, f.signal);
    const record = vi.fn(async () => {f.steps.push('record');});
    const result = await f.publisher.publish(saved(), 'ou_owner', f.signal, record);
    expect(result).toEqual({documentId: 'doc_fixture', boardId: 'board_fixture', url: 'https://www.feishu.cn/docx/doc_fixture'});
    expect(f.steps).toEqual(['create', 'record', 'PATCH:public', 'GET:public', 'GET:members', 'content', 'diagram', 'POST:members', 'GET:public', 'GET:members']);
    const create = f.run.mock.calls.find(([args]) => args.includes('/open-apis/docx/v1/documents'))!;
    expect(create[1].stdin).toBe('{"title":"dsh 的作品"}');
    const grant = f.run.mock.calls.find(([args]) => args.includes('POST') && args.some(arg => arg.endsWith('/members')))!;
    expect(JSON.parse(grant[1].stdin!)).toEqual({member_type: 'openid', member_id: 'ou_owner', perm: 'view', type: 'user'});
    for (const [args] of f.run.mock.calls.filter(([args]) => args[0] !== 'profile')) {
      expect(args.slice(0, 2)).toEqual(['--profile', 'dedicated']); expect(args).toContain('bot'); expect(args).not.toContain('user');
    }
    expect(f.run.mock.calls.some(([args]) => args.includes('+create'))).toBe(false);
    expect(f.steps).not.toContain('image'); // SVG never goes to the IM upload endpoint.
  });
  it.each(['public', 'member'])('stops before private content when %s authorization is broader than expected', async failure => {
    const f = fixture();
    if (failure === 'public') f.replies.permissions.link_share_entity = 'anyone_readable';
    else f.replies.initialMembers = [{member_type: 'openid', member_id: 'ou_unexpected', perm: 'full_access', type: 'user'}];
    await expect(f.publisher.publish(saved(), 'ou_owner', f.signal, async () => undefined)).rejects.toThrow();
    expect(f.steps).not.toContain('content'); expect(f.steps).not.toContain('POST:members');
    expect(f.run.mock.calls.some(([, options]) => options.stdin?.includes('PRIVATE'))).toBe(false);
  });
  it('treats arbitrary HTML in a report as inert text runs', async () => {
    const f = fixture(); await f.publisher.preflight(false, f.signal);
    await f.publisher.publish(saved('report'), 'ou_owner', f.signal, async () => undefined);
    const call = f.run.mock.calls.find(([args]) => args.some(arg => arg.endsWith('/children')))!;
    expect(JSON.parse(call[1].stdin!).children.at(-1)).toEqual({block_type: 2, text: {elements: [{text_run: {content: '<img src="http://localhost/secret"> is inert text'}}]}});
    expect(f.steps).not.toContain('diagram'); expect(f.steps).not.toContain('image');
  });
  it('does not upload before scope preflight succeeds, without falling back to a user login', async () => {
    const f = fixture(); f.replies.scopes = [];
    await expect(f.publisher.preflight(true, f.signal)).rejects.toThrow('扫码');
    expect(f.steps).toEqual([]); expect(f.run).toHaveBeenCalledOnce();
  });
  it('does not retry a create whose result is unknown', async () => {
    const f = fixture(); await f.publisher.preflight(true, f.signal); f.run.mockClear(); f.run.mockRejectedValue(new Error('network failure with private diagnostics'));
    await expect(f.publisher.publish(saved(), 'ou_owner', f.signal, async () => undefined)).rejects.toThrow('尚未确认');
    expect(f.run).toHaveBeenCalledOnce();
  });
  it('continues only a known empty private document, without issuing another create', async () => {
    const f = fixture();
    await f.publisher.publish({...saved(), pendingDocumentId: 'doc_fixture'}, 'ou_owner', f.signal, async () => {throw new Error('must not create');});
    expect(f.steps).toContain('read-blocks'); expect(f.steps).toContain('content'); expect(f.steps).not.toContain('create'); expect(f.steps).not.toContain('PATCH:public');
    const memberRead = f.run.mock.calls.find(([args]) => args.includes('GET') && args.some(arg => arg.endsWith('/members')))!;
    expect(memberRead[0]).toContain('{"type":"docx","fields":"type"}');
    const partial = fixture(); partial.replies.blocks.push({block_type: 2});
    await expect(partial.publisher.publish({...saved(), pendingDocumentId: 'doc_fixture'}, 'ou_owner', partial.signal, async () => undefined)).rejects.toThrow();
    expect(partial.steps).not.toContain('content'); expect(partial.steps).not.toContain('create');
  });
  it('does not accept another app or an owner with absent/wrong collaborator type', async () => {
    const f = fixture(); f.replies.initialMembers = [{member_type: 'appid', member_id: 'cli_other', perm: 'full_access'}];
    await expect(f.publisher.publish(saved(), 'ou_owner', f.signal, async () => undefined)).rejects.toThrow();
    expect(f.steps).not.toContain('content');
    const missing = fixture(); missing.replies.finalMembers = [{member_type: 'openid', member_id: 'ou_owner', perm: 'view'}];
    await expect(missing.publisher.publish(saved(), 'ou_owner', missing.signal, async () => undefined)).rejects.toThrow();
  });
  it('reconciles already imported content by checking the entire controlled graph, without creating or importing again', async () => {
    const f = fixture(), artifact = saved();
    if (artifact.draft.kind !== 'diagram') throw new Error('fixture');
    f.replies.blocks = [
      {block_id: 'doc_fixture', block_type: 1, children: ['title', 'summary', 'board']},
      {block_id: 'title', block_type: 4, heading2: {elements: [{text_run: {content: artifact.draft.title}}]}},
      {block_id: 'summary', block_type: 2, text: {elements: [{text_run: {content: artifact.draft.summary}}]}},
      {block_id: 'board', block_type: 43, board: {token: 'board_fixture'}},
    ];
    f.replies.nodes = [
      {id: 't1:1', type: 'section', syntax: {syntax_type: 2, code: diagramMermaid(artifact.draft.content)}},
      {id: 'o1:1', parent_id: 't1:1', type: 'composite_shape', text: {text: '用户'}},
      {id: 'o1:2', parent_id: 't1:1', type: 'composite_shape', text: {text: '服务'}},
      {id: 'c1:1', parent_id: 't1:1', type: 'connector', connector: {start_object: {id: 'o1:1'}, end_object: {id: 'o1:2'}}},
    ];
    expect((await f.publisher.publish({...artifact, pendingDocumentId: 'doc_fixture'}, 'ou_owner', f.signal, async () => undefined)).boardId).toBe('board_fixture');
    expect(f.steps).toContain('read-nodes'); expect(f.steps).not.toContain('create'); expect(f.steps).not.toContain('content'); expect(f.steps).not.toContain('diagram');
    f.replies.initialMembers = f.replies.finalMembers;
    f.steps.length = 0;
    await f.publisher.publish({...artifact, pendingDocumentId: 'doc_fixture'}, 'ou_owner', f.signal, async () => undefined);
    expect(f.steps).not.toContain('POST:members');
    (f.replies.nodes[1] as {text: {text: string}}).text.text = 'changed by user';
    f.steps.length = 0;
    await expect(f.publisher.publish({...artifact, pendingDocumentId: 'doc_fixture'}, 'ou_owner', f.signal, async () => undefined)).rejects.toThrow();
    expect(f.steps).not.toContain('diagram'); expect(f.steps).not.toContain('POST:members');
  });
  it('does not return a link when the final collaborator check fails', async () => {
    const f = fixture(); f.replies.finalMembers.push({member_type: 'openchat', member_id: 'oc_unexpected', perm: 'view', type: 'chat'});
    await expect(f.publisher.publish(saved(), 'ou_owner', f.signal, async () => undefined)).rejects.toThrow();
    expect(f.steps).toContain('POST:members');
  });
  it('uploads a bounded PNG and retains the platform image key', async () => {
    const f = fixture();
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write('IHDR', 12); png.writeUInt32BE(100, 16); png.writeUInt32BE(100, 20); f.replies.image = png;
    const result = await f.publisher.publish(saved(), 'ou_owner', f.signal, async () => undefined);
    expect(result.imageKey).toBe('img_fixture'); expect(f.steps).toContain('image');
    const oversized = fixture(); png.writeUInt32BE(7000, 16); oversized.replies.image = png;
    expect((await oversized.publisher.publish(saved(), 'ou_owner', oversized.signal, async () => undefined)).imageKey).toBeUndefined();
    expect(oversized.steps).not.toContain('image');
  });
  it('rejects a forged local state and cancelled work before any network write', async () => {
    const f = fixture();
    await expect(f.publisher.publish({...saved(), publication: 'local'}, 'ou_owner', f.signal, async () => undefined)).rejects.toThrow();
    const aborter = new AbortController(); aborter.abort();
    await expect(f.publisher.publish(saved(), 'ou_owner', aborter.signal, async () => undefined)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
});
