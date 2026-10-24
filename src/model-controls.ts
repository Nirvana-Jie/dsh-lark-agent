import {createHash} from 'node:crypto';
import type {ModelCatalog, ModelSelection} from './dsh-runtime.js';
import type {ReplyAction, ReplyPanel} from './replies.js';

const label = (text: string, max = 60) => Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim()).slice(0, max).join('');
export const modelChoiceKey = (selection: Pick<ModelSelection, 'provider' | 'model'>): string =>
  createHash('sha256').update(JSON.stringify([selection.provider, selection.model])).digest('hex').slice(0, 16);
export const thinkingChoiceKey = (effort: string): string => createHash('sha256').update(effort).digest('hex').slice(0, 16);
export const sameSelection = (a: ModelSelection, b: ModelSelection): boolean =>
  a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;

export function modelStateText(selection: ModelSelection, catalog: ModelCatalog): string {
  const model = catalog.models.find(item => item.provider === selection.provider && item.model === selection.model);
  const effort = model?.reasoning?.efforts.find(item => item.id === selection.reasoningEffort);
  return `当前模型：${label(model?.name || selection.model)}\n思考深度：${selection.reasoningEffort
    ? label(effort?.name || selection.reasoningEffort) : model?.reasoning?.efforts.length ? '模型默认' : '该模型未提供可调档位'}。`;
}

export function isModelQuestion(text: string): boolean {
  return /^(?:你(?:现在|目前)?(?:使用的|用的)?模型是(?:什么)?|你(?:现在|目前)?(?:是|用的是|使用的是)(?:什么|哪个)模型|当前模型(?:是(?:什么)?)?|现在(?:用的|使用的)模型(?:是(?:什么)?)?)[？?。!！\s]*$/u.test(text);
}

export function modelChoice(catalog: ModelCatalog, key: string): ModelSelection | undefined {
  const found = catalog.models.filter(item => modelChoiceKey(item) === key);
  return found.length === 1 ? {provider: found[0]!.provider, model: found[0]!.model} : undefined;
}

export function thinkingChoice(catalog: ModelCatalog, selection: ModelSelection, key: string): ModelSelection | undefined {
  const model = catalog.models.find(item => item.provider === selection.provider && item.model === selection.model);
  const found = model?.reasoning?.efforts.filter(item => thinkingChoiceKey(item.id) === key);
  return found?.length === 1 ? {...selection, reasoningEffort: found[0]!.id} : undefined;
}

/** The card's state: a page, a switch in flight (its choice key), a confirmed switch, a refusal, or a refresh notice. */
export interface ModelPanelState {page?: number; changed?: boolean; pending?: string; error?: string; notice?: string}

type Issue = (label: string, command: string, mutation: boolean, primary?: boolean) => ReplyAction | undefined;
export function modelControlPanel(kind: 'model' | 'thinking', catalog: ModelCatalog, selection: ModelSelection,
  issue: Issue, state: ModelPanelState = {}): ReplyPanel {
  const model = catalog.models.find(item => item.provider === selection.provider && item.model === selection.model);
  const actions: ReplyAction[] = [];
  const sections: ReplyPanel['sections'] = [];
  // While a switch runs nothing is clickable; otherwise the current choice is shown, not offered.
  const add = (text: string, command: string, mutation: boolean, current = false, key?: string) => {
    if (state.pending || current) {
      actions.push({label: `${key !== undefined && key === state.pending ? '⏳ ' : current ? '✓ ' : ''}${text}`, value: {}, disabled: true});
      return true;
    }
    const value = issue(text, command, mutation);
    if (value) actions.push(value);
    return Boolean(value);
  };
  let pendingName: string | undefined;
  const size = kind === 'model' ? 5 : 6;
  if (kind === 'model') {
    // Open on the page that holds the current (or pending) model unless a page was asked for.
    const index = catalog.models.findIndex(item => state.pending ? modelChoiceKey(item) === state.pending
      : item.provider === selection.provider && item.model === selection.model);
    const pages = Math.max(1, Math.ceil(catalog.models.length / size));
    const currentPage = Math.min(Math.max(0, state.page ?? Math.max(0, Math.floor(index / size))), pages - 1);
    for (const item of catalog.models.slice(currentPage * size, currentPage * size + size)) {
      const current = item.provider === selection.provider && item.model === selection.model;
      const key = modelChoiceKey(item);
      if (key === state.pending) pendingName = label(item.name || item.model);
      // Feishu keeps button text on one line on mobile. Put the provider first
      // so the distinguishing route remains visible when a long name truncates.
      const text = `${label(item.providerName || item.provider, 20)} · ${label(item.name || item.model, 32)}`;
      if (!add(text, `/model use ${key}`, true, current, key)) {
        sections.push({title: label(item.name || item.model), text: `/model use ${key}`});
      }
    }
    if (!catalog.models.length) sections.push({text: '宿主暂未提供可选模型列表，请先在 Harness 中配置模型。'});
    if (currentPage > 0) add('上一页', `/model page ${currentPage - 1}`, false);
    if (currentPage + 1 < pages) add('下一页', `/model page ${currentPage + 1}`, false);
    add('思考深度', '/thinking', false);
  } else {
    const efforts = model?.reasoning?.efforts ?? [];
    const index = efforts.findIndex(effort => state.pending ? thinkingChoiceKey(effort.id) === state.pending : effort.id === selection.reasoningEffort);
    const currentPage = Math.min(Math.max(0, state.page ?? Math.max(0, Math.floor(index / size))), Math.max(0, Math.ceil(efforts.length / size) - 1));
    for (const effort of efforts.slice(currentPage * size, currentPage * size + size)) {
      const key = thinkingChoiceKey(effort.id);
      if (key === state.pending) pendingName = label(effort.name || effort.id);
      if (!add(label(effort.name || effort.id, 32), `/thinking use ${key}`, true, effort.id === selection.reasoningEffort, key)) {
        sections.push({title: label(effort.name || effort.id), text: `/thinking use ${key}`});
      }
    }
    if (!model?.reasoning?.efforts.length) sections.push({text: '这个模型没有提供可切换的思考档位，可以保留当前配置或选择其他模型。'});
    if (currentPage > 0) add('上一页', `/thinking page ${currentPage - 1}`, false);
    if ((currentPage + 1) * size < efforts.length) add('下一页', `/thinking page ${currentPage + 1}`, false);
    add('选择模型', '/model', false);
  }
  const current = modelStateText(selection, catalog);
  const status: NonNullable<ReplyPanel['status']> = state.error ? {text: state.error, tone: 'error'}
    : state.pending ? {text: `正在切换到「${pendingName ?? '所选配置'}」…`, tone: 'pending'}
    : state.changed ? {text: `已切换。${current}`, tone: 'success'}
    : {text: state.notice ? `${state.notice}\n${current}` : current};
  return {title: state.changed && !state.error ? '设置已更新' : kind === 'model' ? '选择模型' : '思考深度',
    subtitle: '仅用于你在当前聊天中的对话', tone: status.tone ?? 'normal', status, summary: status.text,
    sections, actions, actionColumns: kind === 'model' ? 1 : 3,
    note: state.pending ? '完成后会在这张卡片上更新，无需重复点击。' : '下一条回复使用所选配置，已有对话保留。更换模型会使用新模型自身的默认思考档位。'};
}
