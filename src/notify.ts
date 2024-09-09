import ky from 'ky'

export async function notify(msg: string, chat_id: number, bot_token: string) {
  return await ky.post(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
    body: JSON.stringify({
      chat_id,
      text: `\`\`\`${msg}\`\`\``,
      parse_mode: 'MarkdownV2',
    }),
  })
}
