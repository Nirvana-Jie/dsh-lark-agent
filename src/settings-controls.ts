import {randomBytes} from 'node:crypto';
import type {ModelCatalog, ModelSelection} from './dsh-runtime.js';
import {modelChoiceKey, sameSelection, thinkingChoiceKey} from './model-controls.js';
import {unattended, type PermissionView} from './permission-controls.js';
import {plainLabel, type ReplyAction, type ReplyPanel} from './replies.js';

export interface SettingsDraft {
  id: string;
  key: string;
  version: number;
  expires: number;
  defaults: boolean;
  shared: boolean;
  title: string;
  selection: ModelSelection;
  permission?: string;
  original: ModelSelection;
  originalPermission?: string;
  revision: string;
  sessionId: string | null;
  catalog: ModelCatalog;
  permissions?: PermissionView;
  modelPage: number;
  saved?: boolean;
}

/** Ephemeral edits contain no authority: every access also requires the signed owner/chat/topic binding. */
export class SettingsDrafts {
  private readonly drafts = new Map<string, SettingsDraft>();
  create(input: Omit<SettingsDraft, 'id' | 'expires' | 'version' | 'original' | 'originalPermission' | 'modelPage'>): SettingsDraft {
    this.sweep();
    if (this.drafts.size >= 500 || [...this.drafts.values()].filter(draft => draft.key === input.key).length >= 20) {
      throw new Error('设置草稿数量已达到上限，请稍后重新打开。');
    }
    const draft: SettingsDraft = {...input, id: randomBytes(6).toString('hex'), version: 0, expires: Date.now() + 10 * 60_000,
      original: {...input.selection}, originalPermission: input.permission,
      modelPage: Math.max(0, Math.floor(input.catalog.models.findIndex(model => modelChoiceKey(model) === modelChoiceKey(input.selection)) / 20))};
    this.drafts.set(draft.id, draft);
    return draft;
  }
  get(id: string, key: string): SettingsDraft | undefined {
    this.sweep();
    const draft = this.drafts.get(id);
    return draft?.key === key ? draft : undefined;
  }
  remove(id: string): void {this.drafts.delete(id);}
  private sweep(): void {for (const [id, draft] of this.drafts) if (draft.expires <= Date.now()) this.drafts.delete(id);}
}

export const settingsDraftCommand = (draft: SettingsDraft, operation: string): string => `/settings draft ${draft.id} ${draft.version} ${operation}`;
export const settingsDraftChanged = (draft: SettingsDraft): boolean => !sameSelection(draft.original, draft.selection) || draft.originalPermission !== draft.permission;

/** One editor for both scopes; selectors only edit a draft and the Save button commits it. */
export function settingsPanel(draft: SettingsDraft, issue: (label: string, command: string, confirm?: ReplyAction['confirm']) => ReplyAction | undefined,
  state: {pending?: boolean; error?: string; notice?: string; workspace?: string; preset?: string} = {}): ReplyPanel {
  const target = draft.defaults ? '新话题默认' : `话题「${plainLabel(draft.title, 40)}」`;
  const status: ReplyPanel['status'] = state.error ? {text: state.error, tone: 'error'} : state.pending ? {text: '正在保存设置…', tone: 'pending'}
    : state.notice ? {text: state.notice} : draft.saved ? {text: draft.defaults ? '已保存新话题默认，之后创建的话题使用这组设置。' : `已保存到${target}，下一轮生效。`, tone: 'success'} : undefined;
  const options = draft.catalog.models.slice(draft.modelPage * 20, (draft.modelPage + 1) * 20);
  const model = draft.catalog.models.find(item => modelChoiceKey(item) === modelChoiceKey(draft.selection));
  const selects: NonNullable<ReplyPanel['selects']> = [];
  const add = (name: string, label: string, initialOption: string | undefined, options: {label: string; value: string}[]) => {
    const action = issue(label, settingsDraftCommand(draft, name));
    if (action && options.length) selects.push({name: `dsh_settings_${name}`, label, placeholder: label,
      value: action.value, initialOption, options, disabled: state.pending});
  };
  add('model', draft.defaults && draft.shared ? '模型 · 与 App 新会话共用' : '模型', modelChoiceKey(draft.selection), options.map(item => ({value: modelChoiceKey(item), label: plainLabel(`${item.providerName || item.provider} · ${item.name || item.model}`, 70)})));
  add('thinking', '思考深度', draft.selection.reasoningEffort ? thinkingChoiceKey(draft.selection.reasoningEffort) : 'default',
    [{value: 'default', label: '模型默认'}, ...(model?.reasoning?.efforts ?? []).map(item => ({value: thinkingChoiceKey(item.id), label: plainLabel(item.name || item.id, 40)}))]);
  if (draft.permissions) add('permission', draft.defaults ? '权限模式 · 此私聊的新话题' : '权限模式', draft.permission,
    draft.permissions.options.map(item => ({value: item.id, label: plainLabel(item.name, 60)})));
  const actions: ReplyAction[] = [];
  const action = (label: string, op: string, primary = false, confirm?: ReplyAction['confirm']) => {
    const value = issue(label, settingsDraftCommand(draft, op), confirm);
    if (value) actions.push({...value, primary, ...(state.pending ? {disabled: true} : {})});
  };
  if (draft.modelPage) action('上一页模型', `models ${draft.modelPage - 1}`);
  if ((draft.modelPage + 1) * 20 < draft.catalog.models.length) action('下一页模型', `models ${draft.modelPage + 1}`);
  const permission = draft.permissions?.options.find(item => item.id === draft.permission);
  const confirm = permission && permission.id !== draft.originalPermission && unattended(permission.id)
    ? {title: `切换${target}到「${permission.name}」？`, text: `${draft.defaults ? '之后创建的话题' : target}中的助手执行命令和修改文件将不再询问。已有其他话题保留原权限。`} : undefined;
  action(draft.defaults ? '保存新话题默认' : '保存到本话题', 'save', true, confirm);
  const save = actions.at(-1);
  if (save && !settingsDraftChanged(draft)) save.disabled = true;
  if (!draft.defaults) action('使用当前默认值', 'copy');
  action('取消', 'cancel');
  return {title: draft.defaults ? '新话题默认' : `话题设置 · ${plainLabel(draft.title, 40)}`, summary: `${target}的模型、思考深度和权限设置`,
    subtitle: draft.defaults ? '仅用于之后创建的话题；已有话题保留原设置' : `只修改${target}`, tone: status?.tone, status, selects, actions,
    sections: selects.length ? (!draft.defaults ? [{title: '会话环境', text: `Agent：${state.preset || '宿主默认预设'}\n工作区：${state.workspace || '创建话题时确定'}`}]: [])
      : [{text: '卡片交互暂不可用。话题内用 /model、/thinking、/permission 查看和修改；主聊天中的命令修改新话题默认。'}],
    note: draft.defaults ? `${draft.shared ? '模型与思考深度默认与 App 新会话共用；' : ''}权限默认仅用于这个私聊。选择后需点保存。`
      : '下一轮生效，恢复和重启后保留。使用当前默认值只复制一次，之后独立保存。选择后需点保存。'};
}
