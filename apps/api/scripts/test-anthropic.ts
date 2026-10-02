import Anthropic from '@anthropic-ai/sdk';
(async () => {
  const client = new Anthropic({
    apiKey: 'REDACTED-LLM-API-KEY',
    baseURL: 'http://192.168.2.197:3000',
  });
  const resp = await client.messages.create({
    model: 'Auto',
    max_tokens: 512,
    system: 'You are a test compiler. Output JSON only: {"steps": [...]}.',
    messages: [{ role: 'user', content: 'ai-step\n指令: 打开登录页' }],
  });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  console.log('TEXT:', text);
})();