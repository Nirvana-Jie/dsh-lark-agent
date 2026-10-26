import type {ReplyPanel} from './replies.js';

/** A searchable message marker, not a native Feishu feed-group tag. */
export const TOPIC_SOURCE_MARKER = '#dsh-lark-agent';

/** The entry itself owns the native thread; it needs no separate navigation confirmation. */
export function topicEntryPanel(title: string, chatType: 'p2p' | 'group'): ReplyPanel {
  return {title, subtitle: TOPIC_SOURCE_MARKER, summary: `${TOPIC_SOURCE_MARKER} · ${title}，在话题内继续对话`,
    sections: [{text: '在下方点「回复话题」，继续聊天。'}],
    ...(chatType === 'group' ? {note: '群聊中每条消息仍需 @机器人。'} : {}),
  };
}
