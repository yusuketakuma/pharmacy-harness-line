import { expect, test } from 'vitest';
import { renderField } from './form.js';
import { safeLiffRedirectTarget } from '../lib/safe-redirect.js';

test('form attributes cannot introduce markup or event handlers', () => {
  const rendered = renderField({
    name: 'answer',
    label: 'Synthetic',
    type: 'text',
    placeholder: 'x" autofocus onfocus="alert(1)\'><img src=x onerror=alert(2)>',
  });
  expect(rendered).toContain('x&quot; autofocus onfocus=&quot;');
  expect(rendered).not.toContain('placeholder="x"');
  expect(rendered).not.toContain('<img');
  expect(rendered).toContain('&#39;&gt;&lt;img');
});
test('LIFF redirects reject foreign origins and attach identity only to local tracking paths', () => {
  const origin = 'https://worker.example.test';
  expect(safeLiffRedirectTarget('https://marketing.example/t/x', origin, 'synthetic-user')).toBe(
    'https://marketing.example/t/x',
  );
  expect(safeLiffRedirectTarget('//evil.example/t/x', origin)).toBeNull();
  expect(safeLiffRedirectTarget('javascript:alert(1)', origin)).toBeNull();
  expect(safeLiffRedirectTarget('/t/x?lu=forged#section', origin, 'synthetic-user')).toBe(
    `${origin}/t/x?lu=synthetic-user#section`,
  );
  expect(safeLiffRedirectTarget('/other?target=/t/x', origin, 'synthetic-user')).toBe(`${origin}/other?target=/t/x`);
});
