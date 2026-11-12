// Zero-dependency stdio NDJSON MCP echo server (for smoke/testing).
// Protocol: one JSON-RPC message per line; on successful initialize, writes the MCP_ECHO_MARKER file (used by tests to assert "connection established"),
// then registers an echo tool. tools/call echoes text back verbatim.
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
  // notification (no id): silent
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