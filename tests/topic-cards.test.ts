import {describe, expect, it} from 'vitest';
import {topicEntryPanel} from '../src/topic-cards.js';
import {renderPanel} from '../src/replies.js';

describe('the topic entry card', () => {
  it('makes the card the entry and uses the native thread reply affordance', () => {
    const payload = renderPanel(topicEntryPanel('新话题', 'p2p'));
    expect(payload).toMatchObject({kind: 'card', card: {schema: '2.0', header: {
      title: {content: '新话题'}, subtitle: {content: 'dsh-lark-agent'},
    }}, fallbackText: expect.stringContaining('回复话题')});
    expect(JSON.stringify(payload)).not.toContain('话题已就绪');
    expect(JSON.stringify(payload)).not.toContain('打开话题继续');
    expect(JSON.stringify(payload)).not.toContain('@机器人');
  });

  it('keeps the group mention instruction on group entries only', () => {
    expect(renderPanel(topicEntryPanel('Team discussion', 'group'))).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('每条消息仍需 @机器人')});
  });

  it('renders the session title as inert text without adding callback capabilities', () => {
    const payload = renderPanel(topicEntryPanel('<at id=all>All</at> **Project**', 'p2p'));
    expect(payload).toMatchObject({kind: 'card', card: {header: {title: {tag: 'plain_text', content: 'All Project'}}}});
    expect(JSON.stringify(payload)).not.toContain('callback');
    expect(JSON.stringify(payload)).not.toContain('<at');
  });
});
