import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type UxGateEvidence = {
  status: string;
  prerequisite: { V033_7: string };
  freeze: { candidateIdentity: string; frozenBeforeDeviceTrials: boolean };
  participants: Array<{ id: string }>;
  tasks: Array<{
    id: string;
    trialsPerEnvironment: number;
    successDefinition: string;
    failureDefinition: string;
  }>;
  environments: Array<{ id: string; status: string }>;
  acceptance: {
    zeroTolerance: string[];
    auxiliaryMetrics: { completionSeconds: number; successRatePercent: number; gate: boolean };
  };
  results: { deviceTrials: string; assistiveTechnology: string; slowNetwork: string };
};

describe('v0.34 patient critical journey UX gate', () => {
  it('freezes the real-device trial denominator without fabricating acceptance', () => {
    const evidence = JSON.parse(readFileSync(new URL(
      '../../../../../docs/pharmacy/evidence/v0.34.0-patient-critical-journey.json',
      import.meta.url,
    ), 'utf8')) as UxGateEvidence;

    expect(evidence.status).toBe('NOT_RUN');
    expect(evidence.prerequisite.V033_7).toBe('BLOCKED');
    expect(evidence.freeze).toMatchObject({
      candidateIdentity: 'LOCAL_SOURCE_COMMIT',
      frozenBeforeDeviceTrials: true,
    });
    expect(evidence.freeze.exactCandidateSha).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.boundaries.commit).toContain(evidence.freeze.exactCandidateSha);
    expect(evidence.participants.map(({ id }) => id)).toEqual([
      'patient-self', 'family-proxy', 'older-adult',
    ]);
    expect(evidence.tasks.map(({ id }) => id)).toEqual([
      'timeline-to-detail', 'new-prescription-send', 'interrupted-upload-recovery',
    ]);
    for (const task of evidence.tasks) {
      expect(task.trialsPerEnvironment).toBeGreaterThanOrEqual(3);
      expect(task.successDefinition.length).toBeGreaterThan(0);
      expect(task.failureDefinition.length).toBeGreaterThan(0);
    }
    expect(evidence.environments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ios-line-webview', status: 'NOT_RUN' }),
      expect.objectContaining({ id: 'android-line-webview', status: 'NOT_RUN' }),
    ]));
    expect(evidence.acceptance.zeroTolerance).toEqual([
      'duplicate-submission', 'input-loss', 'wrong-owner-data', 'critical-safety-error',
    ]);
    expect(evidence.acceptance.auxiliaryMetrics).toEqual({
      completionSeconds: 90,
      successRatePercent: 90,
      gate: false,
    });
    expect(evidence.results).toEqual({
      deviceTrials: 'NOT_RUN',
      assistiveTechnology: 'NOT_RUN',
      slowNetwork: 'NOT_RUN',
    });
  });
});
