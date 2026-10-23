import {describe, expect, it} from 'vitest';
import {diagramMermaid, formAnswers, presentationCard, presentationDraft, presentationText, type PresentationDraft} from '../src/presentation.js';

export const sampleChart = {kind: 'chart', title: '示例销量', summary: '示例数据：周二比周一增加 3 单。', content: {type: 'bar', series: ['销量'], data: [{label: '周一', values: [2]}, {label: '周二', values: [5]}]}} as const;
export const sampleForm = {kind: 'form', title: '选择写作方式', summary: '请告诉我受众和用途，我会据此继续起草。', content: {fields: [
  {id: 'audience', label: '读者', type: 'select', options: [{value: 'engineer', label: '工程师'}, {value: 'general', label: '一般读者'}]},
  {id: 'purpose', label: '用途', type: 'text', required: false},
]}} as const;

describe('declarative presentation', () => {
  it('renders a real chart with the supplied numeric values and a readable fallback', () => {
    const draft = presentationDraft(sampleChart), reply = presentationCard(draft);
    expect(reply.kind).toBe('card');
    if (reply.kind !== 'card') return;
    const elements = (reply.card.body as {elements: Record<string, unknown>[]}).elements;
    expect(elements.find(element => element.tag === 'chart')).toMatchObject({chart_spec: {type: 'bar', data: [{values: [
      {category: '周一', series: '销量', value: 2}, {category: '周二', series: '销量', value: 5},
    ]}]}});
    expect(reply.fallbackText).toContain('周二：销量 5');
    expect(reply.card.config).toMatchObject({enable_forward: false});
  });
  it('preserves multi-series data and uses a categorical line axis', () => {
    const draft = presentationDraft({...sampleChart, content: {type: 'line', series: ['A', 'B'], data: [{label: '一月', values: [1, 2]}]}});
    expect(JSON.stringify(presentationCard(draft))).toContain('"xField":"category"');
    expect(presentationText(draft)).toContain('A 1，B 2');
  });
  it.each([
    {...sampleChart, audience: 'all'},
    {...sampleChart, content: {...sampleChart.content, url: 'https://attacker.invalid'}},
    {...sampleChart, content: {...sampleChart.content, data: [{label: 'A', values: [Infinity]}]}},
    {...sampleChart, content: {...sampleChart.content, data: [{label: 'A', values: [1, 2]}]}},
    {...sampleChart, content: {...sampleChart.content, type: 'pie', data: [{label: 'A', values: [-1]}]}},
    {...sampleChart, content: {...sampleChart.content, type: 'pie', data: [{label: 'A', values: [0]}]}},
    {...sampleChart, content: {...sampleChart.content, data: [{label: 'A', values: [1]}, {label: 'A', values: [2]}]}},
    {...sampleChart, title: '\u202Ehidden'},
    {kind: 'html', title: 'example', summary: 'example', content: {html: '<script>alert(1)</script>'}},
    {...sampleChart, content: {...sampleChart.content, series: []}},
  ])('rejects unsafe or misleading data %#', value => expect(() => presentationDraft(value)).toThrow());
  it('does not evaluate getters supplied at the presentation boundary', () => {
    let called = false;
    expect(() => presentationDraft({get kind() {called = true; return 'chart';}})).toThrow();
    expect(called).toBe(false);
  });
  it('escapes diagram labels as data and rejects dangling edges', () => {
    const draft = presentationDraft({kind: 'diagram', title: '图示', summary: '关系图示。', content: {
      nodes: [{id: 'a', label: '"] click a "https://evil" %%{init}'}, {id: 'b', label: '服务'}], edges: [{from: 'a', to: 'b', label: '调用'}],
    }});
    if (draft.kind !== 'diagram') return;
    const source = diagramMermaid(draft.content);
    expect(source).not.toContain('https://'); expect(source).not.toContain('%%{'); expect(source).not.toContain('"] click');
    expect(source).toContain('a -->|"调用"| b');
    expect(() => presentationDraft({...draft, content: {...draft.content, edges: [{from: 'a', to: 'missing'}]}})).toThrow();
  });
  it('creates a signed form submit without putting commands in user fields', () => {
    const draft = presentationDraft(sampleForm), reply = presentationCard(draft, {token: 'signed-fixture'});
    expect(reply.kind).toBe('card');
    if (reply.kind !== 'card') return;
    const form = (reply.card.body as {elements: any[]}).elements.find(element => element.tag === 'form');
    expect(form.elements[0]).toMatchObject({tag: 'select_static', name: 'audience', required: true});
    expect(form.elements.at(-1)).toMatchObject({tag: 'button', form_action_type: 'submit', form_name: form.name, behaviors: [{type: 'callback', value: {token: 'signed-fixture'}}]});
    expect(formAnswers((draft as Extract<PresentationDraft, {kind: 'form'}>).content, {audience: 'engineer', purpose: '/new\n普通用户输入'})).toEqual({audience: 'engineer', purpose: '/new\n普通用户输入'});
  });
  it('rejects forged, oversized, missing or unexpected form values', () => {
    const draft = presentationDraft(sampleForm); if (draft.kind !== 'form') return;
    for (const value of [{}, {audience: 'invented'}, {audience: ['engineer']}, {audience: 'engineer', owner: 'another'}, {audience: 'engineer', purpose: 'a'.repeat(1001)}]) expect(() => formAnswers(draft.content, value)).toThrow();
    expect(formAnswers(draft.content, {audience: 'general'})).toEqual({audience: 'general'});
    expect(() => presentationDraft({...sampleForm, content: {fields: [{id: 'dsh_submit', label: 'x', type: 'text'}]}})).toThrow();
  });
  it('has no fake form controls without a working callback and preserves the full source fallback', () => {
    const draft = presentationDraft(sampleForm);
    expect(JSON.stringify(presentationCard(draft))).not.toContain('"tag":"form"');
    expect(presentationText(draft)).toContain('工程师 / 一般读者');
  });
});
