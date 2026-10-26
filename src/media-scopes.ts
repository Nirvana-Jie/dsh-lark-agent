/** Fixed bot scopes. UI callers choose a feature, never supply arbitrary permissions. */
export type MediaInputKind = 'images' | 'voice';
export const MEDIA_RESOURCE_SCOPE = 'im:message:readonly';
export const SPEECH_SCOPE = 'speech_to_text:speech';
export function mediaScopes(kind: MediaInputKind): readonly string[] {
  return kind === 'voice' ? [MEDIA_RESOURCE_SCOPE, SPEECH_SCOPE] : [MEDIA_RESOURCE_SCOPE];
}
