import type {ReplyPanel} from './replies.js';

/** The entry itself owns the native thread; it needs no separate navigation confirmation. */
export function topicEntryPanel(title: string, chatType: 'p2p' | 'group'): ReplyPanel {
  return {title, summary: `${title}，在话题内继续对话`,
    sections: [{text: '在下方点「回复话题」，继续聊天。'}],
    ...(chatType === 'group' ? {note: '群聊中每条消息仍需 @机器人。'} : {}),
  };
}
