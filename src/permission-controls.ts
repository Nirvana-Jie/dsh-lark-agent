import type {PermissionOption} from './dsh-runtime.js';
import type {ReplyAction, ReplyPanel} from './replies.js';

/** What the chat shows: the effective preset when a session is live, else the chat's saved choice. */
export interface PermissionView {options: PermissionOption[]; current?: string}

/** Where the card is: idle, switching to an option, switched, refused with a reason, or refreshed with a notice. */
export interface PanelState {changed?: boolean; pending?: string; error?: string; notice?: string}

/** Presets that let Harness act without asking get a second confirmation. */
export const unattended = (id: string): boolean => /full|danger|auto/.test(id);

function currentName(view: PermissionView): string {
  if (!view.current) return '跟随电脑上的默认设置';
  return optionName(view, view.current) ?? '自定义（在电脑上调整过）';
}
const optionName = (view: PermissionView, id: string) => view.options.find(option => option.id === id)?.name;

export function permissionStateText(view: PermissionView): string {
  return `当前权限模式：${currentName(view)}。\n可选：${view.options.map(option => option.name).join('、')}。只影响这个私聊里的对话。`;
}

type Issue = (label: string, command: string, primary: boolean, confirm?: ReplyAction['confirm']) => ReplyAction | undefined;
export function permissionPanel(view: PermissionView, issue: Issue, state: PanelState = {}): ReplyPanel {
  const actions: ReplyAction[] = [];
  for (const option of view.options) {
    const current = option.id === view.current;
    // While a switch runs nothing is clickable; afterwards the current option is shown, not offered.
    if (state.pending || current) {
      actions.push({label: `${option.id === state.pending ? '⏳ ' : current ? '✓ ' : ''}${option.name}`, value: {}, disabled: true});
      continue;
    }
    const action = issue(option.name, `/permission use ${option.id}`, false,
      unattended(option.id) ? {title: `切换到「${option.name}」？`,
        text: '之后 Harness 执行命令、修改文件都不再询问，在飞书发一句话就能直接操作这台电脑。随时可以切回。'} : undefined);
    if (action) actions.push(action);
  }
  const pendingName = state.pending ? optionName(view, state.pending) ?? state.pending : undefined;
  const status: NonNullable<ReplyPanel['status']> = state.error ? {text: state.error, tone: 'error'}
    : pendingName ? {text: `正在切换到「${pendingName}」…`, tone: 'pending'}
    : state.changed ? {text: `已切换到「${currentName(view)}」`, tone: 'success'}
    : {text: state.notice ? `${state.notice}\n当前：${currentName(view)}` : `当前：${currentName(view)}`};
  return {title: state.changed && !state.error ? '权限模式已更新' : '权限模式', subtitle: '只影响这个私聊里的对话',
    tone: status.tone ?? 'normal', status, summary: status.text,
    sections: view.options.filter(option => option.description).map(option => ({title: option.name, text: option.description!})),
    actions, actionColumns: 1,
    note: state.pending ? '完成后会在这张卡片上更新，无需重复点击。' : '需要确认的操作由这里的模式决定；电脑上其他会话和默认设置不受影响。'};
}
