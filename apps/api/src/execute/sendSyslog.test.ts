import { describe, it, expect } from 'vitest';
import * as dgram from 'node:dgram';
import * as net from 'node:net';

import {
  buildRfc3164,
  facilityCode,
  rfc3164Timestamp,
  runSendSyslog,
  SyslogSendError,
  SyslogSendTimeout,
} from './sendSyslog.js';
import type { SendSyslogAction } from '@itest/shared';

function action(partial: Partial<SendSyslogAction> = {}): SendSyslogAction {
  return {
    kind: 'sendSyslog',
    protocol: 'udp',
    host: '127.0.0.1',
    port: 514,
    facility: 'user',
    severity: 'info',
    message: 'hello from itest',
    timeoutMs: 3000,
    ...partial,
  };
}

describe('facilityCode', () => {
  it('枚举下标即 code：kernel=0 / user=1 / local0=16 / local7=23', () => {
    expect(facilityCode('kernel')).toBe(0);
    expect(facilityCode('user')).toBe(1);
    expect(facilityCode('local0')).toBe(16);
    expect(facilityCode('local7')).toBe(23);
  });

  it('未知 facility 抛 SyslogSendError', () => {
    expect(() => facilityCode('nope')).toThrow(SyslogSendError);
  });
});

describe('rfc3164Timestamp', () => {
  it('日 <10 前导空格而非补零', () => {
    const ts = rfc3164Timestamp(new Date('2026-10-05T08:09:10'));
    expect(ts).toBe('Oct  5 08:09:10');
  });

  it('日 >=10 两位', () => {
    const ts = rfc3164Timestamp(new Date('2026-10-20T23:59:59'));
    expect(ts).toBe('Oct 20 23:59:59');
  });
});

describe('buildRfc3164', () => {
  it('PRI = facility*8 + severity（user/info=14），报文含 hostname 与 TAG itest', () => {
    const packet = buildRfc3164({
      facility: 'user',
      severity: 'info',
      message: 'disk full',
      hostname: 'myhost',
      date: new Date('2026-10-20T12:00:00'),
    });
    expect(packet.startsWith('<14>Oct 20 12:00:00 myhost itest: disk full')).toBe(true);
  });

  it('local7/emerg 的 PRI=184', () => {
    const packet = buildRfc3164({
      facility: 'local7',
      severity: 'emerg',
      message: 'x',
      hostname: 'h',
      date: new Date('2026-10-20T12:00:00'),
    });
    expect(packet.startsWith('<184>')).toBe(true);
  });
});

/** 随机端口起一个 UDP 接收端。 */
async function udpListener(): Promise<{ port: number; recv: Promise<Buffer> }> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((res) => socket.bind(0, '127.0.0.1', () => res()));
  const recv = new Promise<Buffer>((res) => socket.once('message', (m) => res(m)));
  return { port: socket.address().port, recv };
}

/** 随机端口起一个 TCP 接收端。 */
async function tcpListener(): Promise<{ port: number; recv: Promise<Buffer> }> {
  const server = net.createServer();
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as net.AddressInfo).port;
  const recv = new Promise<Buffer>((res) => {
    server.once('connection', (s) => {
      s.once('data', (d) => { res(d); s.end(); server.close(); });
    });
  });
  return { port, recv };
}

describe('runSendSyslog', () => {
  it('UDP：本地收包与结果 packet/bytes 一致', async () => {
    const { port, recv } = await udpListener();
    const result = await runSendSyslog({ action: action({ protocol: 'udp', port }), vars: {} });
    const wire = await recv;
    expect(wire.toString()).toBe(result.packet);
    expect(result.protocol).toBe('udp');
    expect(result.bytes).toBe(Buffer.byteLength(result.packet));
    expect(result.packet).toContain('itest: hello from itest');
  });

  it('TCP：报文以 \\n 分帧', async () => {
    const { port, recv } = await tcpListener();
    const result = await runSendSyslog({ action: action({ protocol: 'tcp', port }), vars: {} });
    const wire = await recv;
    expect(wire.toString()).toBe(`${result.packet}\n`);
    expect(result.bytes).toBe(Buffer.byteLength(result.packet) + 1);
  });

  it('host 支持 {{var}} 替换；缺失变量抛 var-missing', async () => {
    const { port, recv } = await udpListener();
    const result = await runSendSyslog({ action: action({ host: '{{sysHost}}', port }), vars: { sysHost: '127.0.0.1' } });
    expect(result.host).toBe('127.0.0.1');
    await recv;
    await expect(runSendSyslog({ action: action({ host: '{{sysHost}}', port }), vars: {} })).rejects.toThrow(/var-missing/);
  });

  it('TCP 端口无人监听抛 SyslogSendError', async () => {
    // 占一个端口再关掉，保证该端口当前无人监听
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', () => res()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((res) => probe.close(() => res()));

    await expect(
      runSendSyslog({ action: action({ protocol: 'tcp', port, timeoutMs: 1000 }), vars: {} }),
    ).rejects.toThrow(SyslogSendError);
  });

  it('TCP 连接超时抛 SyslogSendTimeout', async () => {
    // 不可路由地址触发连接超时（timeoutMs 压到 1s 下限）
    await expect(
      runSendSyslog({ action: action({ protocol: 'tcp', host: '10.255.255.1', timeoutMs: 1000 }), vars: {} }),
    ).rejects.toThrow(SyslogSendTimeout);
  });
});
