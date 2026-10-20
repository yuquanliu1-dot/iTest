import Anthropic from '@anthropic-ai/sdk';
import { StepAction } from '@itest/shared';
(async () => {
  const client = new Anthropic({
    apiKey: process.env.LLM_API_KEY ?? 'sk-replace-me',
    baseURL: process.env.LLM_BASE_URL ?? 'http://127.0.0.1:3000',
  });
  const resp = await client.messages.create({
    model: 'Auto',
    max_tokens: 512,
    system: '你是测试自动化步骤编译器。把用户的自然语言操作指令编译为具体的 JSON 步骤数组。只输出 JSON：{"steps": [...]}，不要输出其他内容。',
    messages: [
      { role: 'user', content: 'ai-step\n指令: 打开登录页' },
      { role: 'assistant', content: '```json\n{"steps":[{"action":"navigate","url":"/login"}]}\n```' },
      { role: 'user', content: '上一次输出不合法：locator 必须用 array；url 必须是绝对 URL。请只输出纯 JSON {\"steps\":[...]}。' },
    ],
  });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  console.log('TEXT:', text);
  console.log('---');
  const json = JSON.parse(text.replace(/```json|```/g, '').trim());
  console.log('JSON:', JSON.stringify(json, null, 2));
})();