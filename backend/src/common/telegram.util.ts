type InlineKeyboard = { text: string; callback_data: string }[][];

function api(botToken: string, method: string) {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

export async function sendTelegramMessage(botToken: string, chatIds: string[], text: string, keyboard?: InlineKeyboard): Promise<Record<string, number>> {
  const messageIds: Record<string, number> = {};
  for (const chatId of chatIds) {
    try {
      const res = await fetch(api(botToken, 'sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined }),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.result?.message_id) messageIds[chatId] = data.result.message_id;
    } catch (e) { console.error('telegram send failed:', e); }
  }
  return messageIds;
}

export async function editTelegramMessage(botToken: string, chatId: string | number, messageId: number, text: string, keyboard?: InlineKeyboard) {
  try {
    await fetch(api(botToken, 'editMessageText'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard || [] } }),
    });
  } catch (e) { console.error('telegram edit failed:', e); }
}

export async function answerCallbackQuery(botToken: string, callbackQueryId: string, text?: string) {
  try {
    await fetch(api(botToken, 'answerCallbackQuery'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || undefined }),
    });
  } catch (e) { console.error('telegram answerCallbackQuery failed:', e); }
}

export async function setTelegramWebhook(botToken: string, url: string, secretToken: string) {
  try {
    const res = await fetch(api(botToken, 'setWebhook'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ['callback_query'] }),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) console.error('telegram setWebhook rejected:', data);
  } catch (e) { console.error('telegram setWebhook failed:', e); }
}

export function escapeHtml(s: string) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
