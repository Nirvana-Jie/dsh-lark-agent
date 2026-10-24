import { describe, expect, it } from 'vitest';
import type { UserQuestion } from '../src/dsh-runtime.js';
import { answeredText, approvalCard, questionAnswers, questionCard, simpleQuestion } from '../src/interaction-cards.js';

const single: UserQuestion = {id: 'mode', question: 'Which mode?', options: [{label: 'Fast'}, {label: 'Careful', description: 'More checks'}], multiSelect: false};
const multi: UserQuestion = {id: 'langs', question: 'Languages?', options: [{label: 'TS'}, {label: 'Go'}], multiSelect: true};
const open: UserQuestion = {id: 'name', question: 'Name?', options: [], multiSelect: false};

describe('approval and question cards', () => {
  it('shows the exact call in one fence and drops the buttons once settled', () => {
    const asked = approvalCard({toolName: 'bash', detail: 'echo ```nested```'}, {allow: 'allow-token', deny: 'deny-token'});
    expect(asked.kind).toBe('card');
    const text = JSON.stringify(asked);
    expect(text).toContain('````\\necho ```nested```\\n````');
    expect(text).toContain('allow-token');
    const settled = JSON.stringify(approvalCard({toolName: 'bash'}, undefined, {text: '已拒绝，这次不会执行。', tone: 'error'}));
    expect(settled).not.toContain('allow-token');
    expect(settled).not.toContain('"behaviors"');
    expect(settled).toContain('已拒绝，这次不会执行。');
  });

  it('colours a settled card by its outcome', () => {
    const header = (payload: ReturnType<typeof approvalCard>) => payload.kind === 'card' ? (payload.card.header as {template: string}).template : undefined;
    expect(header(approvalCard({toolName: 'bash'}, {allow: 'a', deny: 'd'}))).toBe('blue');
    expect(header(approvalCard({toolName: 'bash'}, undefined, {text: '已允许这一次。', tone: 'success'}))).toBe('green');
    expect(header(approvalCard({toolName: 'bash'}, undefined, {text: '已拒绝，这次不会执行。', tone: 'error'}))).toBe('red');
    expect(header(approvalCard({toolName: 'bash'}, undefined, {text: '5 分钟内没有确认，已按拒绝处理。', tone: 'muted'}))).toBe('grey');
    const answered = questionCard([single], undefined, {text: '已回答：Fast', tone: 'success'});
    expect(answered.kind === 'card' && (answered.card.header as {template: string}).template).toBe('green');
    expect(JSON.stringify(answered)).toContain('已回答：Fast');
  });

  it('uses buttons only for one short single choice', () => {
    expect(simpleQuestion([single])).toBe(true);
    expect(simpleQuestion([multi])).toBe(false);
    expect(simpleQuestion([open])).toBe(false);
    expect(simpleQuestion([single, open])).toBe(false);
    expect(simpleQuestion([{...single, options: Array.from({length: 7}, (_unused, index) => ({label: `o${index}`}))}])).toBe(false);
  });

  it('builds a form with positional field names only', () => {
    const form = questionCard([multi, open], {reply: 'reply-token'});
    const text = JSON.stringify(form);
    expect(text).toContain('"name":"q0"');
    expect(text).toContain('"tag":"multi_select_static"');
    expect(text).toContain('"name":"c1"');
    expect(text).not.toContain('"name":"langs"');
  });

  it('maps a tap to the original label and treats the extra button as a skip', () => {
    expect(questionAnswers([single], {verb: 'choose', index: 1})).toEqual([{id: 'mode', selected: ['Careful']}]);
    expect(questionAnswers([single], {verb: 'choose', index: 2})).toEqual([{id: 'mode', selected: []}]);
    expect(questionAnswers([single], {verb: 'choose', index: 3})).toBeUndefined();
    expect(questionAnswers([multi], {verb: 'choose', index: 0})).toBeUndefined();
  });

  it('validates form answers strictly', () => {
    expect(questionAnswers([multi, open], {verb: 'reply', formValues: {q0: ['o1', 'o0'], c1: ' demo '}}))
      .toEqual([{id: 'langs', selected: ['Go', 'TS']}, {id: 'name', selected: [], custom: 'demo'}]);
    // Typed text replaces a single choice, as the host defines.
    expect(questionAnswers([single], {verb: 'reply', formValues: {q0: 'o0', c0: 'Neither'}})).toEqual([{id: 'mode', selected: [], custom: 'Neither'}]);
    for (const formValues of [{q0: ['o5']}, {q0: ['o0', 'o0']}, {extra: 'x'}, {c1: 'x'.repeat(1001)}, {q1: 'o0'}, []]) {
      expect(questionAnswers([multi, open], {verb: 'reply', formValues})).toBeUndefined();
    }
    expect(questionAnswers([single], {verb: 'reply', formValues: {q0: ['o0', 'o1']}})).toBeUndefined();
  });

  it('summarizes one answer and keeps several private to the card', () => {
    expect(answeredText([single], [{id: 'mode', selected: ['Fast']}])).toBe('已回答：Fast');
    expect(answeredText([single], [{id: 'mode', selected: []}])).toBe('已跳过这个问题。');
    expect(answeredText([multi, open], [])).toBe('已提交回答。');
  });
});
