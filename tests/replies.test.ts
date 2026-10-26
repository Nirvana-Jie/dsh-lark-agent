import { describe, expect, it } from 'vitest';
import { renderAnswer, renderPanel, safePlainText, type ReplyPayload } from '../src/replies.js';

function cardOf(payload: ReplyPayload): Record<string, unknown> {
  expect(payload.kind).toBe('card');
  if (payload.kind !== 'card') throw new Error('Expected card');
  return payload.card;
}

function components(value: unknown, tag: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(item => components(item, tag));
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [...(object.tag === tag ? [object] : []), ...Object.values(object).flatMap(item => components(item, tag))];
}

describe('answer presentation', () => {
  it('keeps ordinary short conversation as a text message', () => {
    expect(renderAnswer('好的，明天继续。', 4000)).toEqual([{kind: 'text', text: '好的，明天继续。'}]);
    expect(renderAnswer('示例短句42', 4000)).toEqual([{kind: 'text', text: '示例短句42'}]);
  });

  it('renders ordinary Markdown as one rich post', () => {
    const answer = '**已完成**\n\n- 会话已保存\n- 记忆可恢复\n\n查看 [飞书文档](https://open.feishu.cn/document)。';
    expect(renderAnswer(answer, 4000)).toEqual([{kind: 'post', markdown: answer}]);
  });

  it('keeps code blocks and inline code opaque, even when they contain HTML or links', () => {
    const code = '```html\n<at user_id="all">all</at>\n<img src="https://image.test/a.png">\n[run](javascript:alert(1))\n```';
    const answer = `代码示例：\n\n${code}\n\n使用 \`<person id="ou_x">\` 测试。`;
    const [payload] = renderAnswer(answer, 4000);
    expect(payload).toEqual({kind: 'post', markdown: answer});
  });

  it('handles tilde fences, variable backtick fences and inline backtick runs', () => {
    const answer = '## 示例\n\n````text\n```\n<person>literal</person>\n````\n\n~~~html\n<at>literal</at>\n~~~\n\n``text ` <at>literal</at>``';
    expect(renderAnswer(answer, 4000)).toEqual([{kind: 'post', markdown: answer}]);
  });

  it('uses a card with collapsed details for a long structured answer', () => {
    const details = '恢复测试已通过，原生会话 ID 保持一致。\n'.repeat(65);
    const answer = `# 验证完成\n\n恢复验证已通过。\n\n## 验证详情\n${details}`;
    const [payload] = renderAnswer(answer, 4000);
    const card = cardOf(payload!);
    expect(card.schema).toBe('2.0');
    const panels = components(card, 'collapsible_panel');
    expect(panels).toHaveLength(1);
    expect(panels[0]!.expanded).toBe(false);
    expect(panels[0]!.header).toMatchObject({icon: {token: 'down_outlined'}, icon_position: 'right', icon_expanded_angle: -180});
    expect(components(card, 'markdown').map(part => part.content).join('')).toBe(answer);
    expect(payload!.kind === 'card' && payload!.fallbackText).toBe(answer);
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(24_000);
  });

  it('keeps a report heading and its conclusion visible before collapsed details', () => {
    const conclusion = '重启后恢复原会话，个人记忆在私聊和群聊共用。';
    const answer = `## 验证报告\n\n${conclusion}\n\n### 详细过程\n${'每轮会话事件均等待磁盘保存成功。\n'.repeat(80)}`;
    const [payload] = renderAnswer(answer, 4000);
    const card = cardOf(payload!);
    const visible = components(card, 'column_set')[0]!;
    expect(components(visible, 'markdown')[0]!.content).toBe(`## 验证报告\n\n${conclusion}\n\n`);
    expect(components(card, 'collapsible_panel')[0]!.elements).toMatchObject([{tag: 'markdown', content: answer.slice(answer.indexOf('### 详细过程')), text_align: 'left'}]);
    expect(components(card, 'markdown').map(part => part.content).join('')).toBe(answer);
  });

  it('uses a rich post when the opening conclusion cannot fit a compact visible lead', () => {
    const answer = `# 完整报告\n\n${'不可拆分的结论段落。'.repeat(90)}\n\n## 后续细节\n保留全部内容。`;
    expect(renderAnswer(answer, 4000)).toEqual([{kind: 'post', markdown: answer}]);
  });

  it('keeps a long, indivisible code block in one post when it fits', () => {
    const answer = `\`\`\`typescript\n${'const value = "你好😀";\n'.repeat(90)}\`\`\``;
    expect(renderAnswer(answer, 4000)).toEqual([{kind: 'post', markdown: answer}]);
  });

  it('falls back to exact UTF-8 text chunks for an oversized fenced block', () => {
    const answer = `\`\`\`typescript\n${'const value = "你好😀";\n'.repeat(1400)}\`\`\``;
    const payloads = renderAnswer(answer, 100);
    expect(payloads.every(part => part.kind === 'text')).toBe(true);
    expect(payloads.map(part => part.kind === 'text' ? part.text : '').join('')).toBe(answer);
    expect(payloads.every(part => part.kind === 'text' && Buffer.byteLength(part.text) <= 100 && !part.text.includes('\ufffd'))).toBe(true);
  });

  it.each(['"', '\\'])('budgets both JSON layers for escape-dense %s code without losing content', character => {
    const answer = `\`\`\`text\n${character.repeat(8000)}\n\`\`\``;
    const post = {zh_cn: {content: [[{tag: 'md', text: answer}]]}};
    expect(Buffer.byteLength(JSON.stringify(post))).toBeLessThan(24_000);
    expect(Buffer.byteLength(JSON.stringify({msg_type: 'post', content: JSON.stringify(post), uuid: 'x'.repeat(50), reply_in_thread: true}))).toBeGreaterThan(28_000);
    const payloads = renderAnswer(answer, 4000);
    expect(payloads.every(payload => payload.kind === 'text')).toBe(true);
    expect(payloads.map(payload => payload.kind === 'text' ? payload.text : '').join('')).toBe(answer);
    expect(payloads.every(payload => payload.kind === 'text' && Buffer.byteLength(payload.text) <= 4000)).toBe(true);
  });

  it('retains rich post presentation for escaped code inside the complete wire budget', () => {
    const answer = `\`\`\`text\n${'"\\'.repeat(2400)}\n\`\`\``;
    const [payload] = renderAnswer(answer, 4000);
    expect(payload).toEqual({kind: 'post', markdown: answer});
    const post = {zh_cn: {content: [[{tag: 'md', text: answer}]]}};
    expect(Buffer.byteLength(JSON.stringify({msg_type: 'post', content: JSON.stringify(post), uuid: 'x'.repeat(50), reply_in_thread: true}))).toBeLessThan(28_000);
  });

  it('does not invent a closing fence for malformed model Markdown', () => {
    const answer = '代码如下：\n```js\nconsole.log("继续😀");\n';
    const payloads = renderAnswer(answer, 12);
    expect(payloads.every(part => part.kind === 'text')).toBe(true);
    expect(payloads.map(part => part.kind === 'text' ? part.text : '').join('')).toBe(answer);
  });

  it('preserves whitespace, code points and every paragraph on huge content fallback', () => {
    const answer = `## 很长的报告\n\n${'  内容😀𠮷\n\n'.repeat(5000)}尾声\n`;
    const payloads = renderAnswer(answer, 333);
    expect(payloads.every(part => part.kind === 'text')).toBe(true);
    expect(payloads.map(part => part.kind === 'text' ? part.text : '').join('')).toBe(answer);
    expect(payloads.every(part => part.kind === 'text' && Buffer.byteLength(part.text) <= 333)).toBe(true);
  });

  it('left-aligns Markdown tables outside code without rewriting code data', () => {
    const answer = '| 名称 | 数量 |\n| :---: | ---: |\n| 会话 | 2 |\n\n```md\n| :---: | ---: |\n```';
    const [payload] = renderAnswer(answer, 4000);
    expect(payload).toEqual({kind: 'post', markdown: '| 名称 | 数量 |\n| :--- | :--- |\n| 会话 | 2 |\n\n```md\n| :---: | ---: |\n```'});
  });

  it('returns no messages for blank input and rejects invalid byte limits', () => {
    expect(renderAnswer('\n  ', 100)).toEqual([]);
    for (const limit of [0, 3, 4.5, NaN, Infinity]) expect(() => renderAnswer('hi', limit)).toThrow();
  });
});

describe('untrusted model Markdown', () => {
  it('neutralizes code-literal mentions when a rich post becomes a text message', () => {
    const source = '```html\n<at user_id="all">所有人</at>\n<person id="ou_user"/>\n<img src="https://images.test/a.png">\n```';
    const [payload] = renderAnswer(source, 4000);
    expect(payload).toEqual({kind: 'post', markdown: source});
    if (payload?.kind !== 'post') throw new Error();
    expect(safePlainText(payload.markdown)).toBe('```html\n‹at user_id="all"›所有人‹/at›\n‹person id="ou_user"/›\n‹img src="https://images.test/a.png"›\n```');
  });

  it.each([
    '&lt;at user_id="all"&gt;所有人&lt;/at&gt;',
    '&#60;at user_id="all"&#62;所有人&#60;/at&#62;',
    '&#x3C;at user_id="all"&#X3e;所有人&#x3c;/at&#x3e;',
    '&#00060;at user_id="all"&#00062;所有人&#00060;/at&#00062;',
    '&amp;amp;lt;at user_id="all"&amp;amp;gt;所有人&amp;amp;lt;/at&amp;amp;gt;',
    '&#38;lt;at user_id="all"&#38;gt;所有人&#38;lt;/at&#38;gt;',
    '&amp;#x26;lt;at user_id="all"&amp;#x26;gt;所有人&amp;#x26;lt;/at&amp;#x26;gt;',
  ])('neutralizes encoded angle delimiters at the final plain-text boundary: %s', source => {
    expect(safePlainText(source)).toBe('‹at user_id="all"›所有人‹/at›');
    expect(safePlainText(safePlainText(source))).toBe(safePlainText(source));
  });

  it('neutralizes mixed delimiters and incomplete native tags', () => {
    expect(safePlainText('<at user_id="all"&gt;所有人</at>')).toBe('‹at user_id="all"›所有人‹/at›');
    expect(safePlainText('<AT user_id="all"')).toBe('‹AT user_id="all"');
    expect(safePlainText('<button value="<at user_id=all>">发送</button>')).not.toContain('<');
  });

  it('keeps ordinary plain prose, comparisons, URLs, whitespace and emoji unchanged', () => {
    const source = '你好😀\n  if (value < 3 && value > 0) return value;\nhttps://docs.test/?a=1&b=2\n';
    expect(safePlainText(source)).toBe(source);
  });

  it('neutralizes native mention and component tags in prose', () => {
    const [payload] = renderAnswer('**提示** <at user_id="all">所有人</at> <person id="ou_x"/> <button>运行</button>', 4000);
    expect(payload?.kind).toBe('post');
    if (payload?.kind !== 'post') throw new Error();
    expect(payload.markdown).not.toMatch(/<(?:at|person|button)/);
    expect(payload.markdown).toContain('&lt;at user_id="all"&gt;所有人&lt;/at&gt;');
  });

  it('neutralizes mention tags in plain text and oversized fallback too', () => {
    const [short] = renderAnswer('<at user_id="all">所有人</at>你好', 4000);
    expect(short).toEqual({kind: 'text', text: '‹at user_id="all"›所有人‹/at›你好'});
    const payloads = renderAnswer('## 内容\n\n' + '<at user_id="all">所有人</at>'.repeat(2000), 4000);
    expect(payloads.every(payload => payload.kind === 'text' && !payload.text.includes('<at'))).toBe(true);
  });

  it('does not reactivate entity-encoded tags', () => {
    const [payload] = renderAnswer('**示例** &lt;at user_id="all"&gt;所有人&lt;/at&gt;', 4000);
    expect(payload).toEqual({kind: 'post', markdown: '**示例** &amp;lt;at user_id="all"&amp;gt;所有人&amp;lt;/at&amp;gt;'});
  });

  it('converts images to ordinary web links and leaves no image components', () => {
    const [payload] = renderAnswer('## 图片\n![截图](https://images.test/a.png)\n![引用][shot]\n[shot]: https://images.test/b.png', 4000);
    expect(payload?.kind).toBe('post');
    if (payload?.kind !== 'post') throw new Error();
    expect(payload.markdown).toContain('[截图](https://images.test/a.png)');
    expect(payload.markdown).not.toContain('![');
    expect(payload.markdown).toContain('[引用][shot]');
  });

  it('preserves HTTPS query links and balanced parentheses', () => {
    const [payload] = renderAnswer('[文档](https://docs.test/path_(one)?a=1&b=2) 和 <https://docs.test>', 4000);
    expect(payload).toEqual({kind: 'post', markdown: '[文档](https://docs.test/path_(one)?a=1&b=2) 和 [https://docs.test](https://docs.test)'});
  });

  it('preserves query separators while keeping encoded tags and link titles inert', () => {
    const [payload] = renderAnswer('[说明 &lt;at&gt;](https://docs.test/?a=1&b=2 "标题 &lt;at&gt;") 和 [实体](https://docs.test/?x=&lt;at&y=&#60;person)', 4000);
    expect(payload).toEqual({kind: 'post', markdown: '[说明 &amp;lt;at&amp;gt;](https://docs.test/?a=1&b=2 "标题 &amp;lt;at&amp;gt;") 和 [实体](https://docs.test/?x=%26lt;at&y=%26#60;person)'});
  });

  it.each(['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'ftp://files.test/a', 'https://name:secret@docs.test/a', 'javascript&#58;alert(1)'])('disables unsafe Markdown link destination %s', destination => {
    const [payload] = renderAnswer(`[打开](${destination})`, 4000);
    expect(payload?.kind).toBe('post');
    if (payload?.kind !== 'post') throw new Error();
    expect(payload.markdown).not.toContain('](');
    expect(payload.markdown).toContain('[打开]（');
  });

  it('disables unsafe reference links and escapes raw HTML', () => {
    const [payload] = renderAnswer('## 引用\n[打开][target]\n[target]: javascript:alert(1)\n<a href="javascript:alert(1)">打开</a>', 4000);
    expect(payload?.kind).toBe('post');
    if (payload?.kind !== 'post') throw new Error();
    expect(payload.markdown).toContain('[target]： javascript:alert(1)');
    expect(payload.markdown).toContain('&lt;a href=');
  });

  it('never interprets arbitrary model JSON as a card', () => {
    const answer = JSON.stringify({schema: '2.0', body: {elements: [{tag: 'button', behaviors: [{type: 'callback', value: {command: '/new'}}]}]}});
    expect(renderAnswer(answer, 4000)).toEqual([{kind: 'text', text: answer}]);
  });
});

describe('application panels', () => {
  it('keeps topic navigation query parameters intact in the rendered card', () => {
    const link = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_example&open_thread_id=omt_example&openchatid=oc_example&openthreadid=omt_example&thread_position=0';
    const card = cardOf(renderPanel({title: '话题已就绪', summary: '打开新话题继续',
      sections: [{text: `已准备好。[打开话题继续](${link})。`}]}));
    const text = components(card, 'markdown').map(row => row.content).join('\n');
    const destination = /\]\((https:[^)]+)\)/.exec(text)?.[1];
    expect(destination).toBeDefined();
    const url = new URL(destination!);
    expect(url.searchParams.get('open_thread_id')).toBe('omt_example');
    expect(url.searchParams.get('thread_position')).toBe('0');
    expect(destination).toBe(link);
  });

  it('keeps section headings separate from original body content without fake controls', () => {
    const card = cardOf(renderPanel({title: '机器人状态', summary: '会话已恢复且个人记忆可用', sections: [
      {title: '当前会话', text: '已从磁盘恢复。'}, {title: '长期记忆', text: '同一用户跨聊天可用。'},
    ]}));
    const groups = components(card, 'column_set');
    expect(groups).toHaveLength(2);
    expect(components(card, 'markdown').map(part => part.content)).toEqual(['**当前会话**', '已从磁盘恢复。', '**长期记忆**', '同一用户跨聊天可用。']);
    expect(components(card, 'interactive_container')).toHaveLength(0);
    expect(components(card, 'button')).toHaveLength(0);
  });

  it('preserves real metric values, notes and subtitle in both the card and plain fallback', () => {
    const payload = renderPanel({title: '会话状态', subtitle: '已保存 · 下次自动恢复', summary: '当前会话已保存，个人记忆可继续使用',
      metrics: [{label: '个人全局', value: '1', note: '跨聊天使用'}, {label: '当前聊天', value: '0'}],
      sections: [{title: '当前会话', text: '海盐联调'}], note: '仅你本人可操作'});
    const card = cardOf(payload);
    expect(card.header).toMatchObject({subtitle: {content: '已保存 · 下次自动恢复'}});
    expect(components(card, 'div').map(part => (part.text as {content: string}).content))
      .toEqual(['个人全局', '跨聊天使用', '当前聊天', '仅你本人可操作']);
    expect(components(card, 'markdown').map(part => part.content))
      .toEqual(['**1**', '**0**', '**当前会话**', '海盐联调']);
    if (payload.kind !== 'card') throw new Error();
    expect(payload.fallbackText).toBe('会话状态\n\n已保存 · 下次自动恢复\n\n个人全局：1\n跨聊天使用\n\n当前聊天：0\n\n当前会话\n海盐联调\n\n仅你本人可操作');
  });

  it('preserves every new field and neutralizes native tags if a metric panel exceeds the budget', () => {
    const subtitle = '<at user_id="all">标题</at>';
    const value = '条目😀'.repeat(9000);
    const payload = renderPanel({title: '完整记录', subtitle, summary: '完整保留每条记录及说明',
      metrics: [{label: '真实内容', value, note: '该记录未省略'}], sections: [], note: '记录结束'});
    expect(payload).toEqual({kind: 'text', text: `完整记录\n\n‹at user_id="all"›标题‹/at›\n\n真实内容：${value}\n该记录未省略\n\n记录结束`});
  });

  it('renders real callback buttons with equal columns and optional confirmation', () => {
    const card = cardOf(renderPanel({title: '会话管理', summary: '查看或切换当前聊天中属于你的会话', sections: [{title: '当前会话', text: '会话 A'}], actions: [
      {label: '查看历史', value: {token: 'signed-session-list'}, primary: true},
      {label: '新建会话', value: {token: 'signed-new'}, confirm: {title: '开启新会话', text: '当前对话归档，长期记忆保留。'}},
    ]}));
    expect(components(card, 'column').every(column => column.weight === 1 && column.width === 'weighted')).toBe(true);
    const buttons = components(card, 'button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({type: 'primary', behaviors: [{type: 'callback', value: {token: 'signed-session-list'}}]});
    expect(buttons[1]).toMatchObject({confirm: {title: {tag: 'plain_text', content: '开启新会话'}}, icon: {tag: 'standard_icon'}});
    expect(components(card, 'action')).toHaveLength(0);
  });

  it('keeps explicit option grids equal-width on mobile and preserves normal compact actions', () => {
    const panel = {title: '选择模型', summary: '选择下一条回复使用的模型和思考深度', sections: [],
      actions: [{label: '短名称', value: {token: 'one'}}, {label: '一个更长的模型名称', value: {token: 'two'}}, {label: '第三个模型', value: {token: 'three'}}]};
    for (const actionColumns of [1, 3] as const) {
      const card = cardOf(renderPanel({...panel, actionColumns}));
      const rows = components(card, 'column_set');
      expect(rows).toHaveLength(actionColumns === 1 ? 3 : 1);
      expect(rows.every(row => row.flex_mode === 'none')).toBe(true);
      expect(components(card, 'column').every(column => column.width === 'weighted' && column.weight === 1)).toBe(true);
      expect(components(card, 'button').every(button => button.width === 'fill')).toBe(true);
    }
    expect(components(cardOf(renderPanel(panel)), 'column_set')[0]!.flex_mode).toBe('flow');
  });

  it('preserves the provider suffix on one-column model choices without expanding compact action labels', () => {
    const labels = ['DeepSeek Harness Experimental Model · 服务商 A', 'DeepSeek Harness Experimental Model · 服务商 B'];
    const panel = {title: '选择模型', summary: '按服务商区分同名模型并选择使用', sections: [],
      actions: labels.map((label, index) => ({label, value: {token: String(index)}}))};
    const visibleLabels = (card: Record<string, unknown>) => components(card, 'button').map(button => (button.text as {content: string}).content);
    expect(visibleLabels(cardOf(renderPanel({...panel, actionColumns: 1})))).toEqual(labels);
    for (const actionColumns of [undefined, 3] as const) {
      expect(visibleLabels(cardOf(renderPanel({...panel, actionColumns})))).toEqual(labels.map(label => label.slice(0, 24)));
    }
    const card = cardOf(renderPanel({...panel, actionColumns: 1, actions: [{label: '😀'.repeat(70), value: {token: 'long'}}]}));
    expect(visibleLabels(card)).toEqual(['😀'.repeat(64)]);
  });

  it('copies callback values so later caller mutation cannot change the prepared card', () => {
    const value = {token: 'original'};
    const card = cardOf(renderPanel({title: '记忆管理', summary: '查看你的个人长期记忆', sections: [{text: '记忆条目属于当前用户。'}], actions: [{label: '查看记忆', value}]}));
    value.token = 'changed';
    expect(components(card, 'button')[0]).toMatchObject({behaviors: [{value: {token: 'original'}}]});
  });

  it('provides a readable real summary and disables forwarded interactions', () => {
    const card = cardOf(renderPanel({title: '机器人状态', summary: '**当前会话已恢复**，你的个人记忆可跨聊天使用。', sections: [{text: '当前会话已恢复，个人记忆可跨聊天使用。'}]}));
    expect(card.config).toMatchObject({enable_forward: false, enable_forward_interaction: false,
      summary: {content: '当前会话已恢复，你的个人记忆可跨聊天使用。'}});
  });

  it('keeps all panel content in a text fallback if JSON would exceed 24KB', () => {
    const text = '完整内容😀'.repeat(4000);
    const payload = renderPanel({title: '完整记录', summary: '当前记录内容较长，完整保留', sections: [{title: '详情', text}], note: '记录结束'});
    expect(payload).toEqual({kind: 'text', text: `完整记录\n\n详情\n${text}\n\n记录结束`});
  });

  it('falls back when an escape-dense panel fits inner JSON but exceeds the wire envelope', () => {
    const text = `\`\`\`text\n${'"\\'.repeat(4000)}\n\`\`\``;
    const payload = renderPanel({title: '代码详情', summary: '完整显示含转义字符的代码', sections: [{text}], note: '内容完整保留'});
    expect(payload).toEqual({kind: 'text', text: `代码详情\n\n${text}\n\n内容完整保留`});
  });

  it('keeps the final interactive envelope within its budget', () => {
    const text = `\`\`\`text\n${'"\\'.repeat(2200)}\n\`\`\``;
    const card = cardOf(renderPanel({title: '代码详情', summary: '完整显示含转义字符的代码', sections: [{text}]}));
    expect(Buffer.byteLength(JSON.stringify({msg_type: 'interactive', content: JSON.stringify(card), uuid: 'x'.repeat(50), reply_in_thread: true}))).toBeLessThanOrEqual(28_000);
  });

  it('uses simple text when a panel has too little real content for a useful summary', () => {
    expect(renderPanel({title: '状态', summary: '', sections: []})).toEqual({kind: 'text', text: '状态'});
  });
});
