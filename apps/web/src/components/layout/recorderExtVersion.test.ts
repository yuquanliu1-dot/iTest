import { describe, it, expect } from 'vitest';
import { compareVersion, deriveExtState, offersDownload } from './recorderExtVersion';

describe('compareVersion', () => {
  it('按段比较，位数不足补 0', () => {
    expect(compareVersion('0.0.2', '0.0.3')).toBeLessThan(0);
    expect(compareVersion('0.0.3', '0.0.2')).toBeGreaterThan(0);
    expect(compareVersion('0.0.2', '0.0.2')).toBe(0);
    expect(compareVersion('0.1', '0.0.9')).toBeGreaterThan(0);
    expect(compareVersion('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });
});

describe('deriveExtState', () => {
  it('已装版本旧于部署版本 → update（提示可升级）', () => {
    expect(deriveExtState('ready', '0.0.2', '0.0.3')).toBe('update');
  });

  it('已装版本等于部署版本 → ready', () => {
    expect(deriveExtState('ready', '0.0.3', '0.0.3')).toBe('ready');
  });

  // 这是本次修的核心：单向比较（只判 installed < current）会把「装的更新」误报成
  // 绿色 ready，用户以为已是最新，实际服务器那边还停在旧版。
  it('已装版本新于部署版本 → ahead（不是 ready）', () => {
    expect(deriveExtState('ready', '0.0.3', '0.0.2')).toBe('ahead');
  });

  it('探测阶段的结果原样透出，不参与版本比较', () => {
    expect(deriveExtState('unknown', null, '0.0.3')).toBe('unknown');
    expect(deriveExtState('missing', null, '0.0.3')).toBe('missing');
    expect(deriveExtState('stale', null, '0.0.3')).toBe('stale');
  });

  it('拿不到任一版本时不误报升级', () => {
    expect(deriveExtState('ready', '0.0.3', null)).toBe('ready');
    expect(deriveExtState('ready', null, '0.0.3')).toBe('ready');
  });
});

describe('offersDownload', () => {
  it('update / missing 给下载入口', () => {
    expect(offersDownload('update')).toBe(true);
    expect(offersDownload('missing')).toBe(true);
  });

  // 下载的是部署版本，比已装的旧——在 ahead 态提供下载就是把新版本覆盖成旧版本，
  // 属于降级，必须挡住。
  it('ahead 不给下载入口（下载即降级）', () => {
    expect(offersDownload('ahead')).toBe(false);
  });

  it('ready 不给下载入口', () => {
    expect(offersDownload('ready')).toBe(false);
  });

  // stale / unknown 的下载入口是既有行为，本次不改。
  it('stale / unknown 保持既有行为（仍给下载入口）', () => {
    expect(offersDownload('stale')).toBe(true);
    expect(offersDownload('unknown')).toBe(true);
  });
});
