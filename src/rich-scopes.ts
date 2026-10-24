/** Default document/board capabilities, authorized at registration. Bot-only; no broad drive access. */
export const DOCUMENT_SCOPES = ['application:application:self_manage', 'docx:document:create', 'docx:document:write_only', 'docx:document:readonly',
  'board:whiteboard:node:create', 'board:whiteboard:node:read', 'docs:permission.setting:write_only',
  'docs:permission.setting:read', 'docs:permission.member:create', 'docs:permission.member:retrieve', 'im:resource:upload'] as const;

/** Lets a harness-mode private chat stream its reply, reasoning and tool progress into one card. */
export const STREAMING_SCOPE = 'cardkit:card:write';

export function documentScopesReady(scopes: readonly string[], diagram = true): boolean {
  const granted = new Set(scopes);
  const groups = [
    ['docx:document:create', 'docx:document'], ['docx:document:write_only', 'docx:document'],
    ['docx:document:readonly', 'docx:document'], ['docs:permission.setting:write_only', 'docx:document'],
    ['docs:permission.setting:read', 'docx:document'], ['docs:permission.member:create'], ['docs:permission.member:retrieve'],
    ...(diagram ? [['board:whiteboard:node:create'], ['board:whiteboard:node:read'], ['im:resource:upload', 'im:resource']] : []),
  ];
  return groups.every(group => group.some(scope => granted.has(scope)));
}

/** Everything the owner-confirmed "default permissions" step grants: documents, boards and streaming replies. */
export function defaultScopesReady(scopes: readonly string[]): boolean {
  return documentScopesReady(scopes) && scopes.includes(STREAMING_SCOPE);
}
