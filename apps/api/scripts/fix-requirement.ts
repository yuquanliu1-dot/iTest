import { pool } from '../src/db/client.ts';

const REQ_ID = '4f88438b-acdb-4c76-93b6-f27dc4159dba';
await pool.query(
  `UPDATE requirements SET title = $1, content = $2, updated_at = NOW() WHERE id = $3`,
  [
    '登录功能',
    '用户使用「用户名」+「密码」登录 iTest 平台。用户名输入框 label 是「用户名」，密码输入框 label 是「密码」，登录按钮文字是「登录」。登录成功跳转到工作台首页；用户名或密码错误登录时在页面上提示错误信息。',
    REQ_ID,
  ],
);
const r = await pool.query(`SELECT title, content FROM requirements WHERE id = $1`, [REQ_ID]);
console.log('updated:', r.rows[0]?.title);
console.log('content:', r.rows[0]?.content);
await pool.end();