import type { Chat, ChatMessage } from '../types';
import { MOBILE_ACTION_TOOLS } from '../tools/registry';

export function chatToJsonl(chat: Chat): string {
  const dayOfWeek = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const now = new Date();
  const systemContent = `Current date and time given in YYYY-MM-DDTHH:MM:SS format: ${now.toISOString().slice(0, 19)}\nDay of week is ${dayOfWeek[now.getDay()]}\nYou are a model that can do function calling with the following functions\n\n${JSON.stringify(MOBILE_ACTION_TOOLS)}`;

  const messages: any[] = [{ role: 'system', content: systemContent }];

  for (const msg of chat.messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: msg.toolCalls.map(tc => ({
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
      } else {
        messages.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool' && msg.toolResult) {
      messages.push({
        role: 'tool',
        content: JSON.stringify({
          success: msg.toolResult.success,
          message: msg.toolResult.message,
        }),
      });
    }
  }

  const entry = {
    messages,
    metadata: {
      model: chat.model,
      chat_id: chat.id,
      title: chat.title,
      message_count: chat.messages.length,
      created_at: new Date(chat.createdAt).toISOString(),
      updated_at: new Date(chat.updatedAt).toISOString(),
    },
  };

  return JSON.stringify(entry);
}

export function chatsToJsonl(chats: Chat[]): string {
  return chats
    .filter(c => c.messages.length >= 2)
    .map(chatToJsonl)
    .join('\n');
}

export function exportForFineTuning(
  chats: Chat[],
  options: { minMessages?: number } = {},
): string {
  const { minMessages = 2 } = options;
  return chats
    .filter(
      c => c.messages.filter(m => m.role !== 'system').length >= minMessages,
    )
    .map(chatToJsonl)
    .join('\n');
}
