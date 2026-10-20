import type { SendSyslogAction, SyslogStepResult } from '@itest/shared';
import { substituteVars, SyslogFacility, SyslogSeverity } from '@itest/shared';
import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { hostname as osHostname } from 'node:os';

export class SyslogSendError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SyslogSendError'; }
}
export class SyslogSendTimeout extends Error {
  constructor(msg: string) { super(msg); this.name = 'SyslogSendTimeout'; }
}

export type { SyslogStepResult };

/** RFC3164 TAG 固定为 itest。 */
const TAG = 'itest';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** facility/severity code = 枚举下标（SyslogFacility 定义保证 kernel=0 ... local7=23）。 */
export function facilityCode(facility: string): number {
  const i = SyslogFacility.options.indexOf(facility as never);
  if (i < 0) throw new SyslogSendError(`未知 syslog facility: ${facility}`);
  return i;
}

export function severityCode(severity: string): number {
  const i = SyslogSeverity.options.indexOf(severity as never);
  if (i < 0) throw new SyslogSendError(`未知 syslog severity: ${severity}`);
  return i;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** RFC3164 时间戳：`Mmm dd hh:mm:ss`，日 <10 用前导空格（不是补零）。 */
export function rfc3164Timestamp(date: Date): string {
  const day = date.getDate();
  const dayField = day < 10 ? ` ${day}` : String(day);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${MONTHS[date.getMonth()]} ${dayField} ${time}`;
}

/** 生成 RFC3164 报文：`<PRI>TIMESTAMP HOSTNAME TAG: MSG`（不含帧尾换行，TCP 分帧时另加）。 */
export function buildRfc3164(opts: {
  facility: string;
  severity: string;
  message: string;
  hostname: string;
  date: Date;
}): string {
  const pri = facilityCode(opts.facility) * 8 + severityCode(opts.severity);
  return `<${pri}>${rfc3164Timestamp(opts.date)} ${opts.hostname} ${TAG}: ${opts.message}`;
}

function sendUdp(host: string, port: number, packet: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const closeSocket = () => { try { socket.close(); } catch { /* 未 bind 即失败时 close 可能抛错，忽略 */ } };
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSocket();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      settle(new SyslogSendTimeout(`syslog UDP ${host}:${port} 发送超时（${timeoutMs}ms）`));
    }, timeoutMs);
    socket.on('error', (e) => settle(new SyslogSendError(`syslog UDP ${host}:${port} 失败: ${e.message}`)));
    socket.send(packet, port, host, (err) => settle(err ? new SyslogSendError(`syslog UDP ${host}:${port} 发送失败: ${err.message}`) : null));
  });
}

function sendTcp(host: string, port: number, payload: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) socket.destroy();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      settle(new SyslogSendTimeout(`syslog TCP ${host}:${port} 连接/发送超时（${timeoutMs}ms）`));
    }, timeoutMs);
    socket.on('error', (e) => settle(new SyslogSendError(`syslog TCP ${host}:${port} 失败: ${e.message}`)));
    socket.on('connect', () => {
      // RFC6587 octet-sticking 之外的常见做法：每条报文以 \n 分帧
      socket.end(payload, () => settle(null));
    });
  });
}

export async function runSendSyslog(opts: {
  action: SendSyslogAction;
  vars: Record<string, string>;
}): Promise<SyslogStepResult> {
  const { action, vars } = opts;

  const { value: host, missing } = substituteVars(action.host, vars);
  if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.host.slice(0, 100)}")`);

  const date = new Date();
  const packet = buildRfc3164({
    facility: action.facility,
    severity: action.severity,
    message: action.message,
    hostname: osHostname(),
    date,
  });
  const bytes = Buffer.byteLength(packet) + (action.protocol === 'tcp' ? 1 : 0);

  const t0 = Date.now();
  if (action.protocol === 'tcp') {
    await sendTcp(host, action.port, Buffer.from(`${packet}\n`), action.timeoutMs);
  } else {
    await sendUdp(host, action.port, Buffer.from(packet), action.timeoutMs);
  }
  const durationMs = Date.now() - t0;

  return {
    protocol: action.protocol,
    host,
    port: action.port,
    facility: action.facility,
    severity: action.severity,
    packet,
    durationMs,
    bytes,
  };
}
