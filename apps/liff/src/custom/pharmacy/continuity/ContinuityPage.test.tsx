import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ContinuityPage from './ContinuityPage.js';

describe('continuity patient hub', () => {
  it('renders a simple follow-up hub without clinical detail', () => {
    const html = renderToStaticMarkup(<MemoryRouter><ContinuityPage /></MemoryRouter>);
    expect(html).toContain('継続フォロー');
    expect(html).toContain('処方せん事前送信へ');
    expect(html).not.toContain('患者名');
  });
});
