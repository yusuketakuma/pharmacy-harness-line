import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PharmacyErrorSummary, PharmacyStatusBlock } from './feedback.js';

// V036-14: announcement and focus are single-channel. Status blocks announce
// through their live region (never take focus); error blocks announce through
// focus (never carry a live-region role). These pin the rendered DOM contract.
describe('single-channel announcements', () => {
  it('success status announces via role=status and is not focusable', () => {
    const html = renderToStaticMarkup(<PharmacyStatusBlock tone="success"><p>完了</p></PharmacyStatusBlock>);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('tabindex');
  });

  it('info status announces via role=status and is not focusable', () => {
    const html = renderToStaticMarkup(<PharmacyStatusBlock tone="info"><p>確認</p></PharmacyStatusBlock>);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('tabindex');
  });

  it('error status announces via focus and carries no live region role', () => {
    const html = renderToStaticMarkup(<PharmacyStatusBlock tone="error"><p>失敗</p></PharmacyStatusBlock>);
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toMatch(/role="(?:alert|status)"/);
  });

  it('error summary announces via focus and carries no live region role', () => {
    const html = renderToStaticMarkup(<PharmacyErrorSummary items={[{ id: 'field-1', label: '必須項目' }]} />);
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toMatch(/role="(?:alert|status)"/);
  });
});
