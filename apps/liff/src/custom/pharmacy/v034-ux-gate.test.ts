import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type UxGateEvidence = {
  status: string;
  prerequisite: { V033_7: string };
  localImplementation: {
    V034_1: string;
    V034_2: string;
    V034_3: string;
    V034_4: string;
  };
  freeze: {
    candidateIdentity: string;
    exactCandidateSha: string;
    frozenBeforeDeviceTrials: boolean;
  };
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
  automatedEvidence: {
    browserAudit: string;
    browserAuditLimit: string;
    workerBuild: string;
    liffBuild: string;
    workerDeployDryRun: string;
    workerProductionBuild: string;
    workerProductionDeployDryRun: string;
  };
  results: { deviceTrials: string; assistiveTechnology: string; slowNetwork: string };
  boundaries: { commit: string };
};

describe('v0.34 patient critical journey UX gate', () => {
  it('freezes the real-device trial denominator without fabricating acceptance', () => {
    const evidence = JSON.parse(readFileSync(new URL(
      '../../../../../docs/pharmacy/evidence/v0.34.0-patient-critical-journey.json',
      import.meta.url,
    ), 'utf8')) as UxGateEvidence;

    expect(evidence.status).toBe('NOT_RUN');
    expect(evidence.prerequisite.V033_7).toBe('BLOCKED');
    expect(evidence.localImplementation).toEqual({
      V034_1: 'PARTIAL_LOCAL_EC_POLICY_GATE',
      V034_2: 'PASS_LOCAL',
      V034_3: 'PASS_LOCAL',
      V034_4: 'PARTIAL_LOCAL_DEVICE_TRIALS_NOT_RUN',
    });
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
    expect(evidence.automatedEvidence.browserAudit)
      .toBe('PASS_LOCAL_CHROME_SYNTHETIC_TIMELINE_STATES_AND_200_PERCENT');
    expect(evidence.automatedEvidence.browserAuditLimit)
      .toContain('does not substitute for LINE WebView');
    expect(evidence.automatedEvidence).toMatchObject({
      workerBuild: 'PASS_EXACT_CANDIDATE',
      liffBuild: 'PASS_EXACT_CANDIDATE',
      workerDeployDryRun: 'PASS_NO_DEPLOY_2369_77_KIB_GZIP_487_31_KIB',
      workerProductionBuild: 'PASS_EXACT_CANDIDATE',
      workerProductionDeployDryRun:
        'PASS_NO_DEPLOY_D1_LINE_CRM_R2_LINE_HARNESS_IMAGES_KEEP_VARS',
    });
    expect(evidence.results).toEqual({
      deviceTrials: 'NOT_RUN',
      assistiveTechnology: 'NOT_RUN',
      slowNetwork: 'NOT_RUN',
    });
  });
});
