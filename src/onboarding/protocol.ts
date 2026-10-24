/** Owner-only UI contract. Credentials and raw platform errors never belong here. */
export type ConnectionPhase = 'idle' | 'creating' | 'waiting_scan' | 'configuring' | 'action_required'
  | 'pairing' | 'confirming_owner' | 'starting' | 'connected' | 'paused' | 'error';

export interface ConnectionSnapshot {
  phase: ConnectionPhase;
  message: string;
  busy: boolean;
  qr?: {url: string; image: string; expiresAt: number};
  bot?: {name: string; appId: string; url: string};
  pairing?: {code: string; expiresAt: number};
  confirmation?: {id: string; label: string};
  action?: {label: string; url: string};
  capabilities: {cards: boolean; loading: boolean; documents?: boolean};
  documentSetup?: {phase: 'preparing' | 'scanning' | 'error'; message: string; qr?: {url: string; image: string; expiresAt: number}};
  /** A newer published release of this plugin, with the installed version. */
  update?: {current: string; latest: string};
}

export interface ConnectionProfile {name: string; appId: string; label: string}
export type ConnectionEndpoint = 'status' | 'profiles' | 'create' | 'use-profile' | 'recheck'
  | 'cancel' | 'renew-pairing' | 'confirm-owner' | 'pause' | 'resume' | 'disconnect' | 'enable-documents' | 'cancel-documents';
export type ConnectionResult<T> = {ok: true; value: T}
  | {ok: false; error: {code: 'internal'; message: string; details: Record<string, never>}};
