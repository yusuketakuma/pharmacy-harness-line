import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import MynaReceivePage from './MynaReceivePage.js';

describe('Myna receive gateway UI', () => {
  it('uses patient-facing purpose labels and separates official confirmation', () => {
    const html = renderToStaticMarkup(<MemoryRouter><MynaReceivePage /></MemoryRouter>);
    expect(html).toContain('お薬を受け取る');
    expect(html).toContain('電子処方箋を送る');
    expect(html).toContain('紙の処方箋を送る');
    expect(html).toContain('病院から送信済み');
    expect(html).toContain('薬局での確認が必要です');
  });
});
