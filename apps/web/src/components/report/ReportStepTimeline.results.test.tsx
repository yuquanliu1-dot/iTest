import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReportStepTimeline, { type StepResult } from './ReportStepTimeline';
import '../../i18n';

/**
 * The report page must show the "actual request sent" together with "the result that came back":
 * sql step → executed SQL + bound params + returned rows; httpRequest step → request line + request headers + response body + response headers.
 * Legacy reports lack sql/params fields → don't render empty blocks (a missing field must not produce a blank heading).
 */
const sqlStep: StepResult = {
  order: 2,
  status: 'passed',
  durationMs: 12,
  sql: {
    dbRef: 'SIEM数据库',
    rowCount: 1,
    durationMs: 10,
    rows: [{ asset_name: 'paas-es-test-02' }],
    sql: 'select count(1) from asmp_asset.asmp_all_asset_infos where host_ip = $1',
    params: ['10.0.0.5'],
  },
};

const httpStep: StepResult = {
  order: 3,
  status: 'passed',
  durationMs: 30,
  http: {
    request: { method: 'GET', url: 'http://192.168.30.123:1688/api/hosts', headers: { accept: '*/*' } },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      bodyText: '{"ok":true}',
      durationMs: 25,
    },
  },
};

describe('ReportStepTimeline · 请求与返回结果同时展示', () => {
  it('sql 步展示实际执行的 SQL、绑定参数与返回行', () => {
    render(<ReportStepTimeline stepResults={[sqlStep]} isRunning={false} />);
    expect(screen.getByText('实际执行的 SQL')).toBeTruthy();
    expect(screen.getByText('select count(1) from asmp_asset.asmp_all_asset_infos where host_ip = $1')).toBeTruthy();
    expect(screen.getByText('绑定参数')).toBeTruthy();
    expect(screen.getByText('返回结果')).toBeTruthy();
    expect(screen.getByText(/paas-es-test-02/)).toBeTruthy();
  });

  it('httpRequest 步展示请求行、响应体与响应头', () => {
    render(<ReportStepTimeline stepResults={[httpStep]} isRunning={false} />);
    expect(screen.getByText('请求行')).toBeTruthy();
    expect(screen.getByText('GET http://192.168.30.123:1688/api/hosts')).toBeTruthy();
    expect(screen.getByText('响应头')).toBeTruthy();
    expect(screen.getByText('{"ok":true}')).toBeTruthy();
  });

  it('老报告无 sql/params 字段 → 不渲染请求块，也不出现空标题', () => {
    const legacy: StepResult = {
      order: 1,
      status: 'passed',
      durationMs: 5,
      sql: { dbRef: 'db', rowCount: 0, durationMs: 3, rows: [] },
    };
    render(<ReportStepTimeline stepResults={[legacy]} isRunning={false} />);
    expect(screen.queryByText('实际执行的 SQL')).toBeNull();
    expect(screen.queryByText('绑定参数')).toBeNull();
    expect(screen.getByText('返回结果')).toBeTruthy();
  });
});
