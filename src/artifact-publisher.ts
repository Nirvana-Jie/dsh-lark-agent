import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {commandRunner, type PlatformRunner} from './onboarding/lark-platform.js';
import {diagramMermaid, plainRecord, presentationDraft, PresentationError, type DiagramContent} from './presentation.js';
import {publishedArtifact, type PublishedArtifact, type SavedArtifact} from './artifacts.js';
import {documentScopesReady} from './rich-scopes.js';

export interface ArtifactPublisher {
  preflight(diagram: boolean, signal: AbortSignal): Promise<void>;
  publish(artifact: SavedArtifact, ownerId: string, signal: AbortSignal, recordDocument: (id: string) => Promise<void>): Promise<PublishedArtifact>;
  verify(remote: PublishedArtifact, ownerId: string, signal: AbortSignal): Promise<void>;
}
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const PRIVATE_PERMISSIONS = {external_access_entity: 'closed', link_share_entity: 'closed',
  manage_collaborator_entity: 'collaborator_full_access', share_entity: 'same_tenant',
  security_entity: 'only_full_access', copy_entity: 'only_full_access', comment_entity: 'anyone_can_edit'};
const failed = () => new PresentationError('云端作品尚未确认完成，已保留本地内容。请勿重复创建；可在本机检查作品状态。');
function token(value: unknown): string {if (typeof value !== 'string' || !TOKEN.test(value)) throw failed(); return value;}
function elements(value: string) {return [{text_run: {content: value}}];}
function textBlock(value: string, heading = false) {return heading ? {block_type: 4, heading2: {elements: elements(value)}} : {block_type: 2, text: {elements: elements(value)}};}

/** Only controlled, private outputs are published. Neither model data nor public API callers choose an endpoint or an audience. */
export class LarkArtifactPublisher implements ArtifactPublisher {
  private readonly run: PlatformRunner;
  private brand: 'feishu' | 'lark' = 'feishu';
  private appId?: string;
  constructor(private readonly profile: string, private readonly botOpenId: string, options: {executable?: string; run?: PlatformRunner} = {}) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile) || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(botOpenId)) throw failed();
    // A bot lease cannot be released until cancelled publisher children actually close.
    this.run = options.run ?? commandRunner(options.executable ?? 'lark-cli', 30_000, 1_048_576, true);
  }
  private async json(args: string[], signal: AbortSignal, stdin?: string, cwd?: string): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    try {
      const result = plainRecord(JSON.parse(await this.run(['--profile', this.profile, ...args, '--as', 'bot', '--format', 'json'], {signal, stdin, cwd})));
      signal.throwIfAborted();
      if (result.ok !== true || result.identity !== 'bot' || result.dry_run === true) throw failed();
      return plainRecord(result.data);
    } catch {if (signal.aborted) signal.throwIfAborted(); throw failed();}
  }
  private api(method: string, path: string, signal: AbortSignal, data?: unknown, params?: object): Promise<Record<string, unknown>> {
    return this.json(['api', method, path, ...(params ? ['--params', JSON.stringify(params)] : []), ...(data ? ['--data', '-'] : [])], signal, data ? JSON.stringify(data) : undefined);
  }
  async preflight(diagram: boolean, signal: AbortSignal): Promise<void> {
    const scopes = await this.api('GET', '/open-apis/application/v6/scopes', signal);
    if (!Array.isArray(scopes.scopes) || scopes.scopes.length > 3000) throw failed();
    const granted = scopes.scopes.map(plainRecord).filter(scope => scope.grant_status === 1).map(scope => scope.scope_name).filter((name): name is string => typeof name === 'string');
    if (!documentScopesReady(granted, diagram)) throw new PresentationError('这个机器人的文档权限尚未就绪。请在 dsh 设置 → 飞书中点击“补充默认权限”，扫码确认后再点这张卡片。内容已保存在本地。');
    await this.loadIdentity(signal);
  }
  private async loadIdentity(signal: AbortSignal): Promise<void> {
    // This metadata command does not read secrets or change the default profile.
    const profiles: unknown = JSON.parse(await this.run(['profile', 'list'], {signal}));
    if (!Array.isArray(profiles)) throw failed();
    const selected = profiles.map(plainRecord).find(profile => profile.name === this.profile);
    if (!selected || !['feishu', 'lark'].includes(selected.brand as string)
      || typeof selected.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,128}$/.test(selected.appId)) throw failed();
    this.brand = selected.brand as 'feishu' | 'lark';
    this.appId = selected.appId;
  }
  private async access(documentId: string, ownerId: string | undefined, signal: AbortSignal, ownerMayBeMissing = false): Promise<boolean> {
    const permissions = await this.api('GET', `/open-apis/drive/v2/permissions/${token(documentId)}/public`, signal, undefined, {type: 'docx'});
    const settings = plainRecord(permissions.permission_public);
    if (Object.entries(PRIVATE_PERMISSIONS).some(([key, value]) => settings[key] !== value)) throw failed();
    const members = await this.api('GET', `/open-apis/drive/v1/permissions/${documentId}/members`, signal, undefined, {type: 'docx', fields: 'type'});
    if (!Array.isArray(members.items) || members.items.length > 2 || members.has_more === true) throw failed();
    let foundOwner = false;
    for (const value of members.items) {
      const member = plainRecord(value);
      // Bot-created root documents list their owning application by appid, not the IM bot's open_id.
      if (this.appId && member.member_type === 'appid' && member.member_id === this.appId && member.perm === 'full_access') continue;
      if (member.member_type !== 'openid') throw failed();
      if (member.member_id === this.botOpenId && member.perm === 'full_access') continue;
      if (ownerId && member.member_id === ownerId && member.perm === 'view' && member.type === 'user' && !foundOwner) {foundOwner = true; continue;}
      throw failed();
    }
    if (ownerId && !foundOwner && !ownerMayBeMissing) throw failed();
    return foundOwner;
  }
  async verify(remote: PublishedArtifact, ownerId: string, signal: AbortSignal): Promise<void> {
    if (!/^ou_[A-Za-z0-9_-]{1,128}$/.test(ownerId) || ownerId === this.botOpenId) throw failed();
    await this.loadIdentity(signal);
    await this.access(publishedArtifact(remote).documentId, ownerId, signal);
  }
  async publish(saved: SavedArtifact, ownerId: string, signal: AbortSignal, recordDocument: (id: string) => Promise<void>): Promise<PublishedArtifact> {
    if (!/^ou_[A-Za-z0-9_-]{1,128}$/.test(ownerId) || ownerId === this.botOpenId || saved.publication !== 'publishing') throw failed();
    const draft = presentationDraft(saved.draft);
    if (draft.kind !== 'report' && draft.kind !== 'diagram') throw failed();
    signal.throwIfAborted();
    if (!this.appId) await this.loadIdentity(signal);
    const children = [textBlock(draft.title, true), textBlock(draft.summary), ...(draft.kind === 'diagram'
      ? [{block_type: 43, board: {align: 2}}]
      : draft.content.sections.flatMap(section => [textBlock(section.heading, true), textBlock(section.body)]))];
    // No sensitive title or content leaves this machine before private ACLs have been verified.
    let documentId: string;
    let existingChildren: Record<string, unknown>[] | undefined;
    if (saved.pendingDocumentId) {
      documentId = token(saved.pendingDocumentId);
      // Reconcile only the exact controlled snapshot; never append to partially written or edited content.
      const blocks = await this.api('GET', `/open-apis/docx/v1/documents/${documentId}/blocks`, signal, undefined, {page_size: 50});
      if (blocks.has_more === true || !Array.isArray(blocks.items) || !blocks.items.length) throw failed();
      const root = plainRecord(blocks.items[0]);
      if (root.block_id !== documentId || root.block_type !== 1 || (root.children !== undefined && !Array.isArray(root.children))) throw failed();
      if (blocks.items.length > 1) {
        if (!Array.isArray(root.children) || root.children.length !== children.length || blocks.items.length !== children.length + 1) throw failed();
        existingChildren = root.children.map(id => plainRecord((blocks.items as unknown[]).find(value => plainRecord(value).block_id === id)));
        for (const [i, block] of existingChildren.entries()) {
          const expected = children[i]! as Record<string, unknown>;
          if (block.block_type !== expected.block_type || (Array.isArray(block.children) && block.children.length)) throw failed();
          if (block.block_type !== 43) {
            const field = block.block_type === 4 ? 'heading2' : 'text', elements = plainRecord(block[field]).elements;
            const expectedText = (plainRecord(expected[field]).elements as Array<{text_run: {content: string}}>)[0]!.text_run.content;
            if (!Array.isArray(elements) || elements.length !== 1 || plainRecord(plainRecord(elements[0]).text_run).content !== expectedText) throw failed();
          }
        }
      } else if (Array.isArray(root.children) && root.children.length) throw failed();
    } else {
      const created = await this.api('POST', '/open-apis/docx/v1/documents', signal, {title: 'dsh 的作品'});
      documentId = token(plainRecord(created.document).document_id);
      await recordDocument(documentId);
      await this.api('PATCH', `/open-apis/drive/v2/permissions/${documentId}/public`, signal, PRIVATE_PERMISSIONS, {type: 'docx'});
    }
    const alreadyGranted = await this.access(documentId, saved.pendingDocumentId ? ownerId : undefined, signal, true);
    const stable = (stage: string) => createHash('sha256').update(`${saved.id}:${stage}`).digest('hex').slice(0, 40);
    // Text runs are inert. Do not use DocxXML/Markdown importers that may fetch URLs or @files.
    const written = existingChildren ? {children: existingChildren} : await this.api('POST', `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, signal,
      {children, index: -1}, {client_token: stable('blocks'), document_revision_id: -1});
    if (!Array.isArray(written.children) || written.children.length !== children.length) throw failed();
    let boardId: string | undefined, imageKey: string | undefined;
    if (draft.kind === 'diagram') {
      const board = written.children.map(plainRecord).find(block => block.block_type === 43);
      boardId = token(plainRecord(board?.board).token);
      if (!existingChildren || !await this.existingDiagram(boardId, draft.content, signal)) {
        const imported = await this.json(['whiteboard', '+update', '--whiteboard-token', boardId,
          '--input_format', 'mermaid', '--source', '-', '--idempotent-token', stable('diagram')], signal, diagramMermaid(draft.content));
        // Whiteboard node IDs are coordinates such as "t1:2", unlike document/board resource tokens.
        if (typeof imported.created_node_id !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(imported.created_node_id)) throw failed();
      }
      // Preview is cosmetic; failure must not create a second document or block an otherwise verified link.
      try {imageKey = await this.preview(boardId, signal);} catch {signal.throwIfAborted();}
    }
    if (!alreadyGranted) await this.api('POST', `/open-apis/drive/v1/permissions/${documentId}/members`, signal,
      {member_type: 'openid', member_id: ownerId, perm: 'view', type: 'user'}, {type: 'docx'});
    await this.access(documentId, ownerId, signal);
    return publishedArtifact({documentId, url: `https://www.${this.brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/docx/${documentId}`,
      ...(boardId ? {boardId} : {}), ...(imageKey ? {imageKey} : {})});
  }
  private async existingDiagram(boardId: string, diagram: DiagramContent, signal: AbortSignal): Promise<boolean> {
    const data = await this.api('GET', `/open-apis/board/v1/whiteboards/${boardId}/nodes`, signal);
    if (!Array.isArray(data.nodes) || data.has_more === true) throw failed();
    if (!data.nodes.length) return false;
    const nodes = data.nodes.map(plainRecord), sections = nodes.filter(node => node.type === 'section');
    if (sections.length !== 1 || nodes.length !== 1 + diagram.nodes.length + diagram.edges.length) throw failed();
    const section = sections[0]!, syntax = plainRecord(section.syntax);
    if (syntax.syntax_type !== 2 || syntax.code !== diagramMermaid(diagram)) throw failed();
    const shapes = nodes.filter(node => node.type === 'composite_shape'), labels = new Map<unknown, string>();
    for (const shape of shapes) {
      const label = plainRecord(shape.text).text;
      if (typeof label !== 'string' || typeof shape.id !== 'string' || shape.parent_id !== section.id || labels.has(shape.id)) throw failed();
      labels.set(shape.id, label);
    }
    const same = (a: unknown[], b: unknown[]) => JSON.stringify(a.sort()) === JSON.stringify(b.sort());
    if (!same([...labels.values()], diagram.nodes.map(node => node.label))) throw failed();
    const edges = nodes.filter(node => node.type === 'connector').map(node => {
      if (node.parent_id !== section.id) throw failed();
      const connector = plainRecord(node.connector), from = labels.get(plainRecord(connector.start_object).id), to = labels.get(plainRecord(connector.end_object).id);
      const captions = connector.captions === undefined ? [] : plainRecord(connector.captions).data;
      if (!from || !to || !Array.isArray(captions) || captions.length > 1) throw failed();
      const label = captions.length ? plainRecord(captions[0]).text : '';
      if (typeof label !== 'string') throw failed();
      return JSON.stringify([from, to, label]);
    });
    if (!same(edges, diagram.edges.map(edge => JSON.stringify([diagram.nodes.find(node => node.id === edge.from)!.label, diagram.nodes.find(node => node.id === edge.to)!.label, edge.label ?? ''])))) throw failed();
    return true;
  }
  private async preview(boardId: string, signal: AbortSignal): Promise<string | undefined> {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-board-preview-'));
    try {
      await this.json(['api', 'GET', `/open-apis/board/v1/whiteboards/${boardId}/download_as_image`, '--output', 'preview.bin'], signal, undefined, directory);
      const file = join(directory, 'preview.bin'), info = await stat(file);
      if (!info.isFile() || info.size < 24 || info.size > 5 * 1024 * 1024) return;
      const image = await readFile(file);
      // Only accept PNG with bounded dimensions here. SVG is never evaluated, and other formats keep a link-only card.
      if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || image.toString('ascii', 12, 16) !== 'IHDR'
        || image.readUInt32BE(16) > 6000 || image.readUInt32BE(20) > 6000 || !image.readUInt32BE(16) || !image.readUInt32BE(20)) return;
      const uploaded = await this.json(['api', 'POST', '/open-apis/im/v1/images', '--data', '{"image_type":"message"}', '--file', 'image=preview.bin'], signal, undefined, directory);
      if (typeof uploaded.image_key !== 'string' || !/^img_[A-Za-z0-9_-]{1,200}$/.test(uploaded.image_key)) return;
      return uploaded.image_key;
    } finally {await rm(directory, {recursive: true, force: true});}
  }
}
