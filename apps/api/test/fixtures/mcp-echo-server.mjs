// 零依赖 stdio NDJSON MCP echo server（冒烟/测试用）。
// 协议：每个 JSON-RPC 消息一行；initialize 成功时写 MCP_ECHO_MARKER 文件（用于测试断言"已建连"），
// 随后注册一个 echo 工具。tools/call 原样回显 text。
import fs from 'node:fs';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === 'initialize') {
    if (process.env.MCP_ECHO_MARKER) fs.writeFileSync(process.env.MCP_ECHO_MARKER, new Date().toISOString());
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0.0.1' } } });
    return;
  }
  // notification（无 id）：silent
  if (id === undefined || id === null) return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id,
      result: { tools: [{ name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] },
    });
    return;
  }
  if (method === 'tools/call' && params?.name === 'echo') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(params.arguments?.text ?? '') }] } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});