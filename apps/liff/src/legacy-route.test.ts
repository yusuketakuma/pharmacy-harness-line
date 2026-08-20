import { describe, expect, it } from 'vitest';
import { legacyQueryTarget } from './legacy-route.js';

describe('legacyQueryTarget', () => {
  it('converts an existing webinar query link to the Pages route', () => {
    expect(
      legacyQueryTarget(
        '?page=webinar&slug=ai-live&sessionStartAt=1800000000&liffId=123',
      ),
    ).toBe('/webinar/ai-live?sessionStartAt=1800000000&liffId=123');
  });

  it('converts event and event history links', () => {
    expect(legacyQueryTarget('?page=event&id=event-1&liffId=123')).toBe(
      '/events/event-1?liffId=123',
    );
    expect(legacyQueryTarget('?page=event-me&liffId=123')).toBe(
      '/events/me?liffId=123',
    );
  });

  it('keeps booking as the safe default', () => {
    expect(legacyQueryTarget('')).toBe('/booking');
    expect(legacyQueryTarget('?page=salon-book&liffId=123')).toBe(
      '/booking?liffId=123',
    );
  });

  it('opens the custom prescription page from a LIFF query link', () => {
    expect(legacyQueryTarget('?page=prescription&liffId=123')).toBe(
      '/prescriptions?liffId=123',
    );
  });

  it('opens the pharmacy rich-menu destinations', () => {
    expect(legacyQueryTarget('?page=pharmacy-menu&liffId=123')).toBe(
      '/pharmacy/menu?liffId=123',
    );
    expect(legacyQueryTarget('?page=pharmacy-info&liffId=123')).toBe(
      '/pharmacy/info?liffId=123',
    );
    expect(legacyQueryTarget('?page=pharmacy-prescription-history&liffId=123')).toBe(
      '/prescriptions?view=history&liffId=123',
    );
    expect(legacyQueryTarget('?page=pharmacy-receive&liffId=123')).toBe(
      '/pharmacy/receive?liffId=123',
    );
    expect(legacyQueryTarget('?page=pharmacy-intake&liffId=123')).toBe(
      '/pharmacy/patient-intake?liffId=123',
    );
    expect(legacyQueryTarget('?page=pharmacy-continuity&liffId=123')).toBe(
      '/pharmacy/continuity?liffId=123',
    );
    expect(legacyQueryTarget('?page=pharmacy-followup&followUpId=followup-1&liffId=123')).toBe(
      '/pharmacy/medication-followup?followUpId=followup-1&liffId=123',
    );
    expect(legacyQueryTarget('?page=pharmacy-emergency-contraception&liffId=123')).toBe(
      '/pharmacy/emergency-contraception?liffId=123',
    );
  });
});
