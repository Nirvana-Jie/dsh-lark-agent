import type {MediaInputKind} from '../media-scopes.js';
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
  capabilities: {cards: boolean; loading: boolean; documents?: boolean; images?: boolean; voice?: boolean};
  documentSetup?: {phase: 'preparing' | 'scanning' | 'error'; message: string; qr?: {url: string; image: string; expiresAt: number}};
  inputSetup?: {kind: MediaInputKind; phase: 'preparing' | 'scanning' | 'error'; message: string; qr?: {url: string; image: string; expiresAt: number}};
  /** Bottom-menu entries the published app lacks, and where its owner adds them. */
  menu?: {missing: Array<{label: string; eventKey: string; parent?: string}>; url: string};
  /** A newer published release of this plugin, with the installed version. */
  update?: {current: string; latest: string};
  agent?: AgentSettings & {workspaceDisplay: string; editable: boolean};
}

/** Per-robot choices. Empty preset/workspace follows the host/default workspace. */
export interface AgentSettings {
  label: string;
  agentPreset: string;
  workspace: string;
  imageInput: boolean;
  voiceInput: boolean;
}
export interface AgentCatalog {
  presets: Array<{id: string; name: string; description?: string; available: boolean}>;
  presetsAvailable: boolean;
  defaultPreset?: string;
  model: string;
  imagesAvailable: boolean;
  voiceAvailable: boolean;
  modelImages?: 'supported' | 'unsupported' | 'unknown';
}
export interface ConnectionList {
  connections: Array<{id: string; label: string; phase: ConnectionPhase; busy: boolean; agentPreset: string}>;
  limit: number;
}
export type ManagerEndpoint = 'connections' | 'add-connection' | 'remove-connection' | 'agent-catalog';

export interface ConnectionProfile {name: string; appId: string; label: string}
export type ConnectionEndpoint = 'status' | 'profiles' | 'create' | 'use-profile' | 'recheck'
  | 'cancel' | 'renew-pairing' | 'confirm-owner' | 'pause' | 'resume' | 'disconnect' | 'enable-documents' | 'cancel-documents' | 'enable-input' | 'cancel-input' | 'update-agent';
export type ConnectionResult<T> = {ok: true; value: T}
  | {ok: false; error: {code: 'internal'; message: string; details: Record<string, never>}};
