import type {ApprovalPrompt, QuestionAnswer, UserQuestion} from './dsh-runtime.js';
import {cardMarkdown, renderPanel, safePlainText, type ReplyPayload} from './replies.js';

/** A verified card click on a pending approval or question. */
export interface InteractionAnswer {verb: 'approve' | 'deny' | 'choose' | 'reply'; index?: number; formValues?: unknown}

const code = (value: string) => '`' + value.replace(/`/g, 'ˋ') + '`';
/** A fence longer than any backtick run inside keeps the arguments one code block. */
function fenced(text: string): string {
  const marks = '`'.repeat(Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length)) + 1);
  return `${marks}\n${text}\n${marks}`;
}

/** Buttons answer one short single-choice question in one tap; anything else uses a form. */
export function simpleQuestion(questions: readonly UserQuestion[]): boolean {
  const only = questions[0];
  return questions.length === 1 && !only!.multiSelect && only!.options.length >= 1 && only!.options.length <= 6;
}

/** The decision card. Without tokens it shows the settled outcome and no buttons. */
export function approvalCard(prompt: ApprovalPrompt, tokens?: {allow: string; deny: string}, outcome?: string): ReplyPayload {
  return renderPanel({
    title: tokens ? '需要你确认' : '确认结果',
    summary: `是否允许使用工具 ${prompt.toolName}`,
    sections: [
      {title: '工具', text: code(prompt.toolName)},
      ...(prompt.reason ? [{title: '原因', text: prompt.reason}] : []),
      ...(prompt.detail ? [{title: '参数', text: fenced(prompt.detail)}] : []),
      ...(outcome ? [{text: `**${outcome}**`}] : []),
    ],
    ...(tokens ? {actions: [{label: '允许一次', value: {token: tokens.allow}, primary: true}, {label: '拒绝', value: {token: tokens.deny}}],
      actionColumns: 2 as const, note: '只允许这一次，不改变电脑上的权限设置。5 分钟内没有确认会按拒绝处理。'} : {}),
  });
}

function questionText(question: UserQuestion): string {
  return [`**${question.question}**`,
    ...question.options.filter(option => option.description).map(option => `- ${option.label}：${option.description}`),
    ...(question.detail ? [question.detail] : [])].join('\n');
}

/** A question card: buttons for one short choice, otherwise a form. Without tokens it shows the outcome. */
export function questionCard(questions: readonly UserQuestion[], tokens?: {choose?: string[]; reply?: string}, outcome?: string): ReplyPayload {
  const first = questions[0]!;
  const title = questions.length === 1 && first.header ? first.header : '需要你选择';
  const form = Boolean(tokens?.reply);
  const base = renderPanel({
    title, summary: `${title}：${first.question}`,
    sections: [
      ...(form ? [{text: questions.length > 1 ? `请回答下面 ${questions.length} 个问题，然后提交。` : '请选择或填写后提交。'}]
        : questions.map(question => ({text: questionText(question)}))),
      ...(outcome ? [{text: `**${outcome}**`}] : []),
    ],
    ...(tokens?.choose ? {actions: [...first.options.map((option, index) => ({label: option.label, value: {token: tokens.choose![index]!}, primary: index === 0})),
      {label: '跳过', value: {token: tokens.choose[first.options.length]!}}], actionColumns: 1 as const} : {}),
    ...(tokens ? {note: '10 分钟内没有回答，Harness 会按未回答继续。'} : {}),
  });
  if (!form || base.kind !== 'card') return base;
  const plain = (content: string) => ({tag: 'plain_text', content: safePlainText(content)});
  (base.card.body as {elements: Record<string, unknown>[]}).elements.push({tag: 'form', name: 'dsh_result_form', elements: [
    // Field names come from positions, never from the model-chosen question IDs.
    ...questions.flatMap((question, index) => [
      {tag: 'markdown', content: cardMarkdown(questionText(question))},
      ...(question.options.length ? [{tag: question.multiSelect ? 'multi_select_static' : 'select_static', name: `q${index}`,
        placeholder: plain(question.multiSelect ? '可多选' : '请选择'), required: false, width: 'fill',
        options: question.options.map((option, choice) => ({text: plain(option.label), value: `o${choice}`}))}] : []),
      {tag: 'input', name: `c${index}`, placeholder: plain(question.options.length ? '其他想法（可选）' : '在这里输入'),
        input_type: 'text', max_length: 1000, required: false, width: 'fill'},
    ]),
    {tag: 'button', name: 'dsh_submit', form_name: 'dsh_result_form', text: plain('提交'), type: 'primary', action_type: 'form_submit',
      form_action_type: 'submit', behaviors: [{type: 'callback', value: {token: tokens!.reply!}}]},
  ]});
  // An oversized question cannot be asked by card; the caller then lets the model ask in text.
  if (Buffer.byteLength(JSON.stringify({msg_type: 'interactive', content: JSON.stringify(base.card)})) > 27_000) return {kind: 'text', text: base.fallbackText};
  return base;
}

/** Map a click or form back to the host's answer shape, echoing the original option labels. */
export function questionAnswers(questions: readonly UserQuestion[], answer: InteractionAnswer): QuestionAnswer[] | undefined {
  if (answer.verb === 'choose') {
    if (!simpleQuestion(questions) || answer.index === undefined) return;
    const question = questions[0]!;
    if (answer.index === question.options.length) return [{id: question.id, selected: []}];
    const option = question.options[answer.index];
    return option ? [{id: question.id, selected: [option.label]}] : undefined;
  }
  if (answer.verb !== 'reply' || !answer.formValues || typeof answer.formValues !== 'object' || Array.isArray(answer.formValues)) return;
  const values = answer.formValues as Record<string, unknown>;
  const fields = new Set(questions.flatMap((question, index) => [...(question.options.length ? [`q${index}`] : []), `c${index}`]));
  if (Object.keys(values).some(key => !fields.has(key))) return;
  const answers: QuestionAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const raw = values[`q${index}`];
    const picked = raw === undefined || raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
    if (!question.multiSelect && picked.length > 1) return;
    let selected: string[] = [];
    for (const value of picked) {
      const choice = typeof value === 'string' ? /^o([0-9]{1,2})$/.exec(value)?.[1] : undefined;
      const option = choice === undefined ? undefined : question.options[Number(choice)];
      if (!option || selected.includes(option.label)) return;
      selected.push(option.label);
    }
    const custom = values[`c${index}`];
    if (custom !== undefined && custom !== null && (typeof custom !== 'string' || custom.length > 1000)) return;
    const text = typeof custom === 'string' ? custom.trim() : '';
    // For a single choice, typed text replaces the selection, as the host defines.
    if (text && !question.multiSelect) selected = [];
    answers.push({id: question.id, selected, ...(text ? {custom: text} : {})});
  }
  return answers;
}

export function answeredText(questions: readonly UserQuestion[], answers: readonly QuestionAnswer[]): string {
  if (questions.length !== 1) return '已提交回答。';
  const [answer] = answers;
  const value = answer?.custom ?? answer?.selected.join('、');
  return value ? `已回答：${value}` : '已跳过这个问题。';
}
