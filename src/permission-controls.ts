import type {PermissionOption} from './dsh-runtime.js';
import type {ReplyAction, ReplyPanel} from './replies.js';

/** What the chat shows: the effective preset when a session is live, else the chat's saved choice. */
export interface PermissionView {options: PermissionOption[]; current?: string}

/** Presets that let Harness act without asking get a second confirmation. */
export const unattended = (id: string): boolean => /full|danger|auto/.test(id);

function currentName(view: PermissionView): string {
  if (!view.current) return '跟随电脑上的默认设置';
  return view.options.find(option => option.id === view.current)?.name ?? '自定义（在电脑上调整过）';
}

export function permissionStateText(view: PermissionView): string {
  return `当前权限模式：${currentName(view)}。\n可选：${view.options.map(option => option.name).join('、')}。只影响这个私聊里的对话。`;
}

type Issue = (label: string, command: string, primary: boolean, confirm?: ReplyAction['confirm']) => ReplyAction | undefined;
export function permissionPanel(view: PermissionView, issue: Issue, changed = false): ReplyPanel {
  const actions: ReplyAction[] = [];
  for (const option of view.options) {
    const current = option.id === view.current;
    const action = issue(`${current ? '✓ ' : ''}${option.name}`, `/permission use ${option.id}`, current,
      !current && unattended(option.id) ? {title: `切换到「${option.name}」？`,
        text: '之后 Harness 执行命令、修改文件都不再询问，在飞书发一句话就能直接操作这台电脑。随时可以切回。'} : undefined);
    if (action) actions.push(action);
  }
  const summary = `当前：${currentName(view)}`;
  return {title: changed ? '权限模式已更新' : '权限模式', subtitle: '只影响这个私聊里的对话', summary,
    sections: [{text: summary}, ...view.options.filter(option => option.description).map(option => ({title: option.name, text: option.description!}))],
    actions, actionColumns: 1,
    note: '需要确认的操作由这里的模式决定；电脑上其他会话和默认设置不受影响。'};
}
