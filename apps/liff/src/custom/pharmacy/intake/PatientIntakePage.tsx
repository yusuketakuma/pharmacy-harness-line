import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  patientIntakeApi,
  type PatientIntakeAnswers,
  type PatientAccessState,
  type PatientRelationship,
  type PharmacyPatient,
  type TenantPrivacyPolicy,
} from './api.js';
import {
  emptyPatientProfileDraft,
  patientProfileDraft,
  patientProfileErrors,
  PATIENT_PROXY_TERMS_HASH,
  PatientProfileForm,
  type PatientProfileDraft,
  type PatientProfileErrors,
} from './PatientProfileForm.js';
import {
  INITIAL_INTAKE_ANSWERS,
  INTAKE_STEP_COUNT,
  PatientQuestionnaire,
  safetyUnansweredKeys,
  type IntakeAnswersDraft,
} from './PatientQuestionnaire.js';
import { pharmacyRoute } from '../navigation.js';
import { PharmacyLoading, PharmacySpinner, PharmacyStatusBlock, usePharmacyAutoRetry, usePharmacyOnline } from '../feedback.js';
import { clearDraft, draftRestoreMessage, intakeDraftKey, legacyIntakeDraftKey, migrateLegacyDraft, NEW_PATIENT_DRAFT_KEY, newPatientDraftKey, saveDraft, sweepIntakeDrafts } from '../draftStorage.js';
import { cloneJsonValue, pharmacyUuid } from '../compat.js';
import { getLiffId } from '../../../lib/liff-auth.js';
import { pharmacyErrorMessage } from '../request.js';

const relationshipLabels: Record<PatientRelationship, string> = {
  self: '本人', child: '子ども', spouse: '配偶者', parent: '親', other: 'その他',
};

export type PatientLoadState = {
  patientId: string;
  status: 'loading' | 'ready' | 'error';
};

export function isCurrentPatientReady(
  selectedId: string,
  state: PatientLoadState | null,
): boolean {
  return Boolean(selectedId && state?.patientId === selectedId && state.status === 'ready');
}

export function canSubmitIntake(
  answers: IntakeAnswersDraft,
  representativeConsent: boolean,
  privacyConsent: boolean,
  busy: boolean,
  privacyPolicyAvailable = false,
): boolean {
  return Boolean(
    answers.allergiesStatus && answers.adverseReactionStatus &&
    answers.medicationStatus && answers.medicalHistoryStatus && answers.medicationNotebook &&
    representativeConsent && privacyConsent && privacyPolicyAvailable && !busy,
  );
}

type PatientIntakeSubmission = Parameters<typeof patientIntakeApi.submit>[1];
type PatientIntakeSubmissionInput = Omit<PatientIntakeSubmission, 'idempotencyKey'>;
type PatientIntakeOperation = {
  patientId: string;
  epoch: number;
  fingerprint: string;
  body: PatientIntakeSubmission;
};

type PendingProfileSave = {
  patientId: string;
  previousUpdatedAt: string;
  epoch: number;
};

export function retainPatientIntakeOperation(
  current: PatientIntakeOperation | null,
  patientId: string,
  epoch: number,
  input: PatientIntakeSubmissionInput,
): PatientIntakeOperation {
  const fingerprint = JSON.stringify(input);
  if (current?.patientId === patientId && current.epoch === epoch && current.fingerprint === fingerprint) {
    return current;
  }
  return {
    patientId,
    epoch,
    fingerprint,
    body: cloneJsonValue({ ...input, idempotencyKey: pharmacyUuid() }),
  };
}

type NewPatientDraftData = { patientDraft?: PatientProfileDraft; showAddress?: boolean };

// The new-patient draft key is scoped by liffId because multiple pharmacy
// LIFF apps share one Pages origin. The pre-scoping legacy key is read once
// and migrated to the scoped key.
function loadNewPatientDraft() {
  return migrateLegacyDraft<NewPatientDraftData>(newPatientDraftKey(getLiffId()), NEW_PATIENT_DRAFT_KEY);
}

function clearNewPatientDraft() {
  // Only the scoped key is ours: a surviving legacy key may be another
  // account's pre-scoping draft on this shared origin — its owner's page
  // migrates it on next load, so it must not be deleted here.
  clearDraft(newPatientDraftKey(getLiffId()));
}

type IntakeDraftData = { answers?: Partial<IntakeAnswersDraft>; step?: number };

// The selectedId always comes from this account's patient list, which proves
// a legacy unscoped draft with the same patientId belongs to this account —
// safe to adopt into the scoped key.
function loadIntakeDraft(patientId: string) {
  return migrateLegacyDraft<IntakeDraftData>(
    intakeDraftKey(getLiffId(), patientId), legacyIntakeDraftKey(patientId),
  );
}

function clearIntakeDraft(patientId: string) {
  clearDraft(intakeDraftKey(getLiffId(), patientId));
  // The caller only reaches this for a patientId proven to be this account's
  // (submitted or just revoked), so the legacy twin is safe to remove too.
  clearDraft(legacyIntakeDraftKey(patientId));
}

export default function PatientIntakePage() {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<PharmacyPatient[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [latestRevision, setLatestRevision] = useState<number | null>(null);
  const [latestAnswers, setLatestAnswers] = useState<PatientIntakeAnswers | null>(null);
  const [intakeLoadState, setIntakeLoadState] = useState<PatientLoadState | null>(null);
  const [accessState, setAccessState] = useState<PatientAccessState | null>(null);
  const [accessLoadState, setAccessLoadState] = useState<PatientLoadState | null>(null);
  const [answers, setAnswers] = useState<IntakeAnswersDraft>(INITIAL_INTAKE_ANSWERS);
  const [intakeStep, setIntakeStep] = useState(1);
  const [showStepErrors, setShowStepErrors] = useState(false);
  const [profileErrors, setProfileErrors] = useState<PatientProfileErrors>({});
  const [saved, setSaved] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [representativeConsent, setRepresentativeConsent] = useState(false);
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [privacyPolicy, setPrivacyPolicy] = useState<TenantPrivacyPolicy | null>(null);
  const [privacyPolicyLoading, setPrivacyPolicyLoading] = useState(true);
  const [privacyPolicyError, setPrivacyPolicyError] = useState<string | null>(null);
  const [patientDraft, setPatientDraft] = useState<PatientProfileDraft>(
    () => emptyPatientProfileDraft('self'),
  );
  const [showAddress, setShowAddress] = useState(false);
  const [showNewPatient, setShowNewPatient] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pendingProfileSave, setPendingProfileSave] = useState<PendingProfileSave | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [patientsFailures, setPatientsFailures] = useState(0);
  const [policyFailures, setPolicyFailures] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const registrationIdempotencyKeyRef = useRef(pharmacyUuid());
  const intakeOperationEpochRef = useRef(0);
  const intakeOperationRef = useRef<PatientIntakeOperation | null>(null);
  const profileSaveEpochRef = useRef(0);
  const profileSaveInFlightRef = useRef(false);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  useEffect(() => () => { profileSaveEpochRef.current += 1; }, []);
  // Two separate refs: previously both blocks shared errorRef, so the second
  // rendered block always stole the ref — the wrong node got focused.
  const errorRef = useRef<HTMLDivElement>(null);
  const policyErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = error ? errorRef.current : privacyPolicyError ? policyErrorRef.current : null;
    target?.focus();
    target?.scrollIntoView({ block: 'center' });
  }, [error, privacyPolicyError]);
  // New-patient draft is restored at most once per mount; reconnects must not
  // re-overwrite a form the patient is editing.
  const newPatientDraftHandledRef = useRef(false);
  // Fingerprint of the currently shown privacy policy; consent is only reset
  // when the policy actually changed.
  const policyFingerprintRef = useRef<string | null>(null);
  // Bumped on each failed validation so the error summary re-announces.
  const [summaryNonce, setSummaryNonce] = useState(0);

  useEffect(() => {
    if (!draftDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const handleLinkClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (!target || target.target === '_blank' || target.hasAttribute('download')) return;
      if (!window.confirm('未送信の入力があります。この端末には下書きが残りますが、画面を離れますか？')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleLinkClick, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleLinkClick, true);
    };
  }, [draftDirty]);

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.id === selectedId) ?? null,
    [patients, selectedId],
  );
  const patientSex = showNewPatient ? patientDraft.sex : selectedPatient?.sex;
  const showPregnancyQuestions = patientSex !== 'male' ||
    answers.pregnancyStatus !== 'not_applicable' || answers.breastfeedingStatus !== 'not_applicable';
  const intakeReady = isCurrentPatientReady(selectedId, intakeLoadState);
  const intakeLoading = intakeLoadState?.patientId === selectedId && intakeLoadState.status === 'loading';
  const accessReady = isCurrentPatientReady(selectedId, accessLoadState);

  // Generation guard: a mutation (create/revoke/confirm-read) or a newer
  // load supersedes an earlier in-flight list — a slow quiet refresh can
  // never resurrect a revoked patient.
  const patientsEpochRef = useRef(0);
  // Error message the patient list load last surfaced; a quiet success
  // clears the shared error channel only if its own message is still shown.
  const patientsLoadErrorRef = useRef<string | null>(null);

  const loadPatients = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    const epoch = ++patientsEpochRef.current;
    try {
      const result = await patientIntakeApi.list();
      if (epoch !== patientsEpochRef.current) return;
      setPatients(result.patients);
      setPatientsFailures(0);
      setError((current) => current === patientsLoadErrorRef.current ? null : current);
      // The list is authoritative: drafts of patients no longer in it
      // (deleted / proxy revoked) are orphaned and swept so they do not
      // linger in localStorage past their TTL. Scoped to this liffId — other
      // accounts' drafts on this shared origin are never touched.
      sweepIntakeDrafts(new Set(result.patients.map((patient) => patient.id)), getLiffId());
      // Revalidate the selection: a still-valid selection is kept as-is
      // mid-edit, but a vanished patient triggers the full selection reset —
      // the epoch bumps inside also cancel in-flight saves/submits so
      // nothing for the old patient can land on the next one.
      const current = selectedIdRef.current;
      if (current && !result.patients.some((patient) => patient.id === current)) {
        resetPatientSelection(result.patients[0]?.id ?? '');
        setEditing(false);
        setPatientDraft(emptyPatientProfileDraft('self'));
        setShowAddress(false);
        setProfileErrors({});
        setShowNewPatient(result.patients.length === 0);
      } else if (!current) {
        setSelectedId(result.patients[0]?.id ?? '');
      }
      if (result.patients.length === 0 && !newPatientDraftHandledRef.current) {
        newPatientDraftHandledRef.current = true;
        const draft = loadNewPatientDraft();
        setPatientDraft(draft?.data.patientDraft
          ? { ...emptyPatientProfileDraft('self'), ...draft.data.patientDraft }
          : emptyPatientProfileDraft('self'));
        setShowAddress(Boolean(draft?.data.showAddress));
        if (draft?.data.patientDraft) setDraftNotice(draftRestoreMessage(draft.savedAt));
        setShowNewPatient(true);
      }
    } catch (err) {
      if (epoch !== patientsEpochRef.current) return;
      if (!quiet) {
        const message = pharmacyErrorMessage(err, '患者情報を読み込めませんでした。');
        patientsLoadErrorRef.current = message;
        setError(message);
      }
      setPatientsFailures((count) => count + 1);
    } finally {
      if (epoch === patientsEpochRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPatients(); }, [loadPatients]);

  // Persist unsent input so an interrupted session can resume where it left off.
  useEffect(() => {
    if (!selectedId || !draftDirty) return;
    saveDraft(intakeDraftKey(getLiffId(), selectedId), { answers, step: intakeStep });
  }, [answers, intakeStep, selectedId, draftDirty]);

  useEffect(() => {
    if (!showNewPatient || editing || !draftDirty) return;
    saveDraft(newPatientDraftKey(getLiffId()), { patientDraft, showAddress });
  }, [patientDraft, showAddress, showNewPatient, editing, draftDirty]);

  const loadPrivacyPolicy = useCallback(async (
    isActive: () => boolean = () => true,
    quiet = false,
  ) => {
    // quiet reconnects keep the current policy visible instead of flashing
    // the section away and back.
    if (!quiet) {
      setPrivacyPolicyLoading(true);
      setPrivacyPolicy(null);
      setPrivacyPolicyError(null);
    }
    try {
      const result = await patientIntakeApi.privacyPolicy();
      if (!isActive()) return;
      if (!result.policy) {
        // The policy was removed server-side — authoritative state, not a
        // transient failure: drop the cached policy and its consent even on a
        // quiet refresh so a stale version can never be submitted against.
        policyFingerprintRef.current = null;
        setPrivacyPolicy(null);
        setPrivacyConsent(false);
        setPolicyFailures(0);
        setPrivacyPolicyError('この薬局では個人情報の利用目的が設定されていないため、アンケートを送信できません。薬局へお問い合わせください。');
        return;
      }
      // Consent is tied to the policy the patient actually saw: reset it only
      // when version or content changed — a plain reconnect must not silently
      // uncheck it.
      const fingerprint = `${result.policy.policy_version}:${result.policy.content_hash}`;
      if (policyFingerprintRef.current !== fingerprint) {
        policyFingerprintRef.current = fingerprint;
        setPrivacyConsent(false);
      }
      setPrivacyPolicy(result.policy);
      setPrivacyPolicyError(null);
      setPolicyFailures(0);
    } catch (err) {
      if (isActive()) {
        // A quiet background failure keeps the current policy visible — the
        // failure counter drives auto-retry instead of a focus-stealing error.
        if (!quiet) setPrivacyPolicyError(pharmacyErrorMessage(err, '個人情報の利用目的を確認できませんでした。再読み込みしてください。'));
        setPolicyFailures((count) => count + 1);
      }
    } finally {
      if (isActive()) setPrivacyPolicyLoading(false);
    }
  }, []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const retryPrivacyPolicy = useCallback(() => {
    void loadPrivacyPolicy(() => mountedRef.current, true);
  }, [loadPrivacyPolicy]);
  usePharmacyAutoRetry(patientsFailures, () => void loadPatients(true));
  usePharmacyAutoRetry(policyFailures, retryPrivacyPolicy);
  // On reconnect, re-run only idempotent reads — quietly, so neither the
  // consent checkbox nor the form fields the patient is editing are reset.
  const reconnectReads = useCallback(() => {
    void loadPatients(true);
    void loadPrivacyPolicy(() => mountedRef.current, true);
  }, [loadPatients, loadPrivacyPolicy]);
  usePharmacyOnline(reconnectReads);

  useEffect(() => {
    let active = true;
    void loadPrivacyPolicy(() => active);
    return () => { active = false; };
  }, [loadPrivacyPolicy]);

  useEffect(() => {
    if (!selectedId) {
      setIntakeLoadState(null);
      return;
    }
    let active = true;
    setDraftDirty(false);
    setDraftNotice(null);
    setIntakeStep(1);
    setLatestRevision(null);
    setLatestAnswers(null);
    setIntakeLoadState({ patientId: selectedId, status: 'loading' });
    setAnswers(INITIAL_INTAKE_ANSWERS);
    setShowStepErrors(false);
    setSaved(false);
    setRepresentativeConsent(false);
    setPrivacyConsent(false);
    setSuccess(null);
    setError(null);
    void patientIntakeApi.latest(selectedId).then((result) => {
      if (!active) return;
      const intake = result.intake;
      const draft = loadIntakeDraft(selectedId);
      if (!intake) {
        setAnswers(draft?.data.answers ? { ...INITIAL_INTAKE_ANSWERS, ...draft.data.answers } : INITIAL_INTAKE_ANSWERS);
        setIntakeStep(Math.min(INTAKE_STEP_COUNT, Math.max(1, draft?.data.step ?? 1)));
        if (draft?.data.answers) {
          setDraftDirty(true);
          setDraftNotice(draftRestoreMessage(draft.savedAt));
        }
        setIntakeLoadState({ patientId: selectedId, status: 'ready' });
        return;
      }
      setLatestRevision(intake.revision);
      try {
        const savedAnswers = {
          ...INITIAL_INTAKE_ANSWERS,
          ...(JSON.parse(intake.answers_json) as PatientIntakeAnswers),
        };
        setLatestAnswers(savedAnswers);
        // Draft wins over saved values, but saved values fill any key the
        // draft lacks (e.g. fields added after the draft was stored).
        setAnswers(draft?.data.answers ? { ...savedAnswers, ...draft.data.answers } : savedAnswers);
        setIntakeStep(Math.min(INTAKE_STEP_COUNT, Math.max(1, draft?.data.step ?? 1)));
        if (draft?.data.answers) {
          setDraftDirty(true);
          setDraftNotice(draftRestoreMessage(draft.savedAt));
        }
        setIntakeLoadState({ patientId: selectedId, status: 'ready' });
      } catch {
        setIntakeLoadState({ patientId: selectedId, status: 'error' });
        setError('回答を読み込めませんでした。');
      }
    }).catch((err: unknown) => {
      if (!active) return;
      setIntakeLoadState({ patientId: selectedId, status: 'error' });
      setError(pharmacyErrorMessage(err, '回答を読み込めませんでした。'));
    });
    return () => { active = false; };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setAccessState(null);
      setAccessLoadState(null);
      return;
    }
    let active = true;
    setAccessState(null);
    setAccessLoadState({ patientId: selectedId, status: 'loading' });
    void patientIntakeApi.access(selectedId).then((result) => {
      if (!active) return;
      setAccessState(result.access);
      setAccessLoadState({ patientId: selectedId, status: 'ready' });
    }).catch((err: unknown) => {
      if (!active) return;
      setAccessState(null);
      setAccessLoadState({ patientId: selectedId, status: 'error' });
      setError(pharmacyErrorMessage(err, 'お知らせ設定を読み込めませんでした。'));
    });
    return () => { active = false; };
  }, [selectedId]);

  function resetPatientSelection(nextId: string) {
    intakeOperationEpochRef.current += 1;
    profileSaveEpochRef.current += 1;
    profileSaveInFlightRef.current = false;
    selectedIdRef.current = nextId;
    setPendingProfileSave(null);
    setSelectedId(nextId);
    setLatestRevision(null);
    setLatestAnswers(null);
    setIntakeLoadState(nextId ? { patientId: nextId, status: 'loading' } : null);
    setAccessState(null);
    setAccessLoadState(nextId ? { patientId: nextId, status: 'loading' } : null);
    setAnswers(INITIAL_INTAKE_ANSWERS);
    setIntakeStep(1);
    setShowStepErrors(false);
    setSaved(false);
    setDraftDirty(false);
    setRepresentativeConsent(false);
    setPrivacyConsent(false);
    setError(null);
    setSuccess(null);
  }

  function selectPatient(nextId: string) {
    if (nextId === selectedId) return;
    if (draftDirty && !window.confirm('未送信の入力があります。切り替えてもこの端末には下書きが残ります。患者を切り替えますか？')) return;
    resetPatientSelection(nextId);
  }

  async function createPatient() {
    if (busy || profileSaveInFlightRef.current || pendingProfileSave) return;
    const {
      relationship,
      name,
      nameKana,
      birthDate,
      sex,
      contactPhone,
      postalCode,
      prefecture,
      city,
      addressLine1,
      addressLine2,
      proxyConsentAccepted,
    } = patientDraft;
    const errors = patientProfileErrors(patientDraft, editing);
    setProfileErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('赤く表示された項目を確認してください。');
      return;
    }
    profileSaveInFlightRef.current = true;
    setBusy(true);
    setError(null);
    const profile = {
      relationship, name, nameKana, birthDate, sex,
      contactPhone: contactPhone.trim() || null,
      postalCode: postalCode.trim() || null,
      prefecture: prefecture || null,
      city: city.trim() || null,
      addressLine1: addressLine1.trim() || null,
      addressLine2: addressLine2.trim() || null,
    };
    if (editing && selectedPatient) {
      const operation: PendingProfileSave = {
        patientId: selectedPatient.id,
        previousUpdatedAt: selectedPatient.updated_at,
        epoch: ++profileSaveEpochRef.current,
      };
      try {
        await patientIntakeApi.updatePatient(operation.patientId, {
          ...profile, expectedUpdatedAt: operation.previousUpdatedAt,
        });
        if (!isCurrentProfileSave(operation)) return;
        setPendingProfileSave(operation);
        await refreshSavedPatient(operation);
      } catch (err) {
        if (isCurrentProfileSave(operation)) {
          setError(pharmacyErrorMessage(err, '患者情報を更新できませんでした。'));
        }
      } finally {
        // busy/profileSaveInFlightRef are mutexes: nothing else could have
        // started while this save held busy, so a quiet patient-list refresh
        // that superseded the operation must not strand the lock.
        profileSaveInFlightRef.current = false;
        setBusy(false);
      }
      return;
    }
    try {
      const result = await patientIntakeApi.createPatient({
        ...profile,
        ...(relationship === 'child' && {
          proxyConsent: { accepted: proxyConsentAccepted, termsVersion: 1, termsHash: PATIENT_PROXY_TERMS_HASH },
          registrationIdempotencyKey: registrationIdempotencyKeyRef.current,
        }),
      });
      registrationIdempotencyKeyRef.current = pharmacyUuid();
      // Our own write supersedes any in-flight patient list read.
      patientsEpochRef.current += 1;
      setPatients((current) => current.some((patient) => patient.id === result.patient.id)
        ? current
        : [...current, result.patient]);
      resetPatientSelection(result.patient.id);
      if (result.proxyGrant) {
        const expiresOn = new Date(result.proxyGrant.expiresAt).toLocaleDateString(
          'ja-JP', { timeZone: 'Asia/Tokyo' },
        );
        setSuccess(`代理入力権限は${expiresOn}まで有効です。自動更新はされません。`);
        setSaved(false);
      }
      setShowNewPatient(false);
      setEditing(false);
      setPatientDraft(emptyPatientProfileDraft(relationship));
      setShowAddress(false);
      setProfileErrors({});
      setDraftDirty(false);
      clearNewPatientDraft();
    } catch (err) {
      setError(pharmacyErrorMessage(err, '患者情報を登録できませんでした。'));
    } finally {
      profileSaveInFlightRef.current = false;
      setBusy(false);
    }
  }

  function isCurrentProfileSave(operation: PendingProfileSave): boolean {
    return profileSaveEpochRef.current === operation.epoch &&
      selectedIdRef.current === operation.patientId;
  }

  async function refreshSavedPatient(operation: PendingProfileSave) {
    try {
      const result = await patientIntakeApi.list();
      if (!isCurrentProfileSave(operation)) return;
      const patient = result.patients.find((entry) => entry.id === operation.patientId);
      if (!patient || typeof patient.updated_at !== 'string' ||
          !Number.isFinite(Date.parse(patient.updated_at)) ||
          patient.updated_at === operation.previousUpdatedAt) {
        throw new Error('saved patient version is not confirmed');
      }
      patientsEpochRef.current += 1;
      setPatients(result.patients);
      setPendingProfileSave(null);
      setShowNewPatient(false);
      setEditing(false);
      setPatientDraft(emptyPatientProfileDraft(patient.relationship));
      setShowAddress(false);
      setProfileErrors({});
      setDraftDirty(false);
      setSuccess('患者情報を更新しました。');
      setError(null);
    } catch {
      if (isCurrentProfileSave(operation)) {
        setError('患者情報は保存されました。最新版を確認できないため、再確認してください。更新を再送しないでください。');
      }
    }
  }

  async function retryProfileRefresh() {
    if (!pendingProfileSave || busy || profileSaveInFlightRef.current) return;
    profileSaveInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await refreshSavedPatient(pendingProfileSave);
    } finally {
      profileSaveInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function revokeProxy() {
    if (!selectedPatient || selectedPatient.relationship === 'self' || busy ||
        !window.confirm('この患者への代理入力権限を取り消しますか？取り消すと、直後から患者情報とアンケートを開けなくなります。')) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await patientIntakeApi.revokeProxy(selectedPatient.id);
      // The revoked patient's draft becomes unreachable — drop it now. The
      // epoch bump also discards any in-flight list read that still contains
      // the revoked patient.
      clearIntakeDraft(selectedPatient.id);
      patientsEpochRef.current += 1;
      const remaining = patients.filter((patient) => patient.id !== selectedPatient.id);
      setPatients(remaining);
      resetPatientSelection(remaining[0]?.id ?? '');
      setSuccess('代理入力権限を取り消しました。');
      if (remaining.length === 0) resetPatientForm('self');
    } catch (err) {
      setError(pharmacyErrorMessage(err, '代理入力権限を取り消せませんでした。'));
    } finally {
      setBusy(false);
    }
  }

  async function updateNotifications() {
    if (!selectedPatient || !accessState || !accessReady || busy) return;
    const action = accessState.notifications === 'enabled' ? 'stop' : 'resume';
    if (action === 'stop' && !window.confirm(
      'この患者について、薬局からの自動のお知らせを停止しますか？すでに停止したお知らせは、再開後も送信されません。',
    )) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await patientIntakeApi.setNotifications(selectedPatient.id, {
        action,
        expectedControlVersion: accessState.controlVersion,
      });
      setAccessState((current) => current && ({
        ...current,
        notifications: result.status === 'stopped' ? 'stopped' : 'enabled',
        controlVersion: result.version,
      }));
      setSuccess(result.status === 'stopped'
        ? 'この患者について、自動のお知らせを停止しました。'
        : 'この患者について、今後の自動のお知らせを再開しました。');
    } catch (err) {
      setError(pharmacyErrorMessage(err, 'お知らせ設定を変更できませんでした。'));
    } finally {
      setBusy(false);
    }
  }

  async function saveIntake(
    nextAnswers: PatientIntakeAnswers,
    nextRepresentativeConsent: boolean,
    nextPrivacyConsent: boolean,
  ) {
    if (!selectedId || !intakeReady || busy) return;
    if (!privacyPolicy) {
      setPrivacyPolicyError('個人情報の利用目的を確認できないため、アンケートを送信できません。薬局へお問い合わせください。');
      return;
    }
    // Build the retained operation BEFORE marking busy: clone/key generation
    // can throw on older WebViews, and a stuck busy flag disables the page.
    const submissionInput: PatientIntakeSubmissionInput = {
      answers: cloneJsonValue(nextAnswers),
      representativeConsent: nextRepresentativeConsent,
      privacyConsent: nextPrivacyConsent,
      privacyPolicyVersion: privacyPolicy.policy_version,
      privacyPolicyHash: privacyPolicy.content_hash,
    };
    const fingerprint = JSON.stringify(submissionInput);
    const current = intakeOperationRef.current;
    const sameOperation = current?.patientId === selectedId &&
      current.epoch === intakeOperationEpochRef.current && current.fingerprint === fingerprint;
    const epoch = sameOperation ? intakeOperationEpochRef.current : intakeOperationEpochRef.current + 1;
    const operation = retainPatientIntakeOperation(
      current, selectedId, epoch, submissionInput,
    );
    intakeOperationRef.current = operation;
    intakeOperationEpochRef.current = operation.epoch;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await patientIntakeApi.submit(operation.patientId, operation.body);
      const currentOperation = intakeOperationRef.current === operation &&
        intakeOperationEpochRef.current === operation.epoch &&
        selectedIdRef.current === operation.patientId;
      if (intakeOperationRef.current === operation) intakeOperationRef.current = null;
      if (!currentOperation) return;
      setLatestRevision(result.intake.revision);
      setLatestAnswers(operation.body.answers);
      setAnswers(operation.body.answers);
      setDraftDirty(false);
      clearIntakeDraft(selectedId);
      setSuccess('アンケートを保存しました。');
      setSaved(true);
      setRepresentativeConsent(false);
      setPrivacyConsent(false);
      setShowStepErrors(false);
      window.scrollTo(0, 0);
    } catch (err) {
      const status = err instanceof Error ? (err as Error & { status?: unknown }).status : undefined;
      const currentOperation = intakeOperationRef.current === operation &&
        intakeOperationEpochRef.current === operation.epoch &&
        selectedIdRef.current === operation.patientId;
      if (typeof status === 'number' && intakeOperationRef.current === operation) {
        intakeOperationRef.current = null;
      }
      if (!currentOperation) return;
      if (status === 409) {
        setPrivacyConsent(false);
        await loadPrivacyPolicy();
      }
      if (intakeOperationEpochRef.current !== operation.epoch) return;
      setError(pharmacyErrorMessage(err, 'アンケートを送信できませんでした。'));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!intakeReady || !canSubmitIntake(answers, representativeConsent, privacyConsent, busy, privacyPolicy !== null)) return;
    // canSubmitIntake guarantees the four safety answers are no longer ''.
    await saveIntake(answers as PatientIntakeAnswers, representativeConsent, privacyConsent);
  }

  function nextStep() {
    if (safetyUnansweredKeys(answers, intakeStep).length > 0) {
      setShowStepErrors(true);
      // The field-level summary is the single announcement target for
      // validation failures — bump the nonce so an identical failure still
      // re-focuses it instead of a competing page-level error block.
      setSummaryNonce((nonce) => nonce + 1);
      setError(null);
      return;
    }
    setShowStepErrors(false);
    setError(null);
    setDraftDirty(true);
    setIntakeStep((step) => Math.min(INTAKE_STEP_COUNT, step + 1));
  }

  const updateAnswers = useCallback((update: SetStateAction<IntakeAnswersDraft>) => {
    setAnswers(update);
    setDraftDirty(true);
    setSaved(false);
  }, []);

  async function confirmUnchanged() {
    if (!latestAnswers || busy || !privacyPolicy || !intakeReady || !window.confirm(
      '前回の回答から変更がないことを確認します。本人または代理人として回答内容を薬局へ伝え、個人情報の利用目的を確認したうえで調剤・連絡に利用することに同意しますか？',
    )) return;
    await saveIntake(latestAnswers, true, true);
  }

  function updatePatientDraft<K extends keyof PatientProfileDraft>(
    key: K,
    value: PatientProfileDraft[K],
  ) {
    setPatientDraft((current) => ({ ...current, [key]: value }));
    setDraftDirty(true);
    setSaved(false);
  }

  function resetPatientForm(relationshipValue: PatientRelationship) {
    setProfileErrors({});
    setEditing(false);
    const draft = loadNewPatientDraft();
    setPatientDraft(draft?.data.patientDraft
      ? { ...emptyPatientProfileDraft(relationshipValue), ...draft.data.patientDraft }
      : emptyPatientProfileDraft(relationshipValue));
    setShowAddress(Boolean(draft?.data.showAddress));
    if (draft?.data.patientDraft) setDraftNotice(draftRestoreMessage(draft.savedAt));
    setShowNewPatient(true);
    registrationIdempotencyKeyRef.current = pharmacyUuid();
  }

  function confirmIntakeNavigation(): boolean {
    if (draftDirty && !window.confirm('未送信の入力があります。この端末には下書きが残りますが、画面を離れますか？')) return false;
    setDraftDirty(false);
    return true;
  }

  return (
    <main className="pharmacy-main max-w-md mx-auto">
      <div className="p-4 space-y-4">
        <p className="text-base leading-6 text-gray-600">本人・ご家族の情報を薬局に伝えます。入力目安：約1分、選択式中心で詳細は任意です。</p>
        {error && <div ref={errorRef} tabIndex={-1} className="rounded-lg bg-red-50 p-3 text-base text-red-700 focus:outline-none">{error}</div>}
        {draftNotice && <p role="status" className="rounded-lg bg-blue-50 p-3 text-base text-blue-800">{draftNotice}</p>}
        {privacyPolicyLoading && <p role="status" className="rounded-lg bg-gray-50 p-3 text-base text-gray-700">個人情報の利用目的を確認しています...</p>}
        {privacyPolicyError && <div ref={policyErrorRef} tabIndex={-1} className="rounded-lg bg-red-50 p-3 text-base text-red-700 focus:outline-none">
          <p>{privacyPolicyError}</p>
          <button type="button" onClick={() => void loadPrivacyPolicy()} disabled={privacyPolicyLoading} className="pharmacy-control min-h-11 mt-2 rounded-lg border border-red-300 bg-white px-4 py-2 font-bold disabled:opacity-50">再読み込み</button>
        </div>}
        {success && <PharmacyStatusBlock tone="success">
          <p className="font-bold">{success}</p>
          {saved && <>
            <p className="mt-2 font-bold">次にすること</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>続けて処方せんを送る場合は、下の「処方せん事前送信へ」を押してください。</li>
              <li>体調やお薬に変化があったときは、この画面から回答を更新できます。</li>
            </ul>
            <button type="button" onClick={() => { if (confirmIntakeNavigation()) navigate(pharmacyRoute('/pharmacy/menu')); }} className="pharmacy-control min-h-11 mt-3 w-full rounded-xl border border-green-700 bg-white px-4 py-2 font-bold text-green-800">すべての機能へ戻る</button>
          </>}
        </PharmacyStatusBlock>}

        <section className="rounded-xl bg-white p-4 shadow-sm space-y-3" aria-labelledby="patient-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="patient-heading" className="font-bold">回答する患者</h2>
            <div className="flex gap-3">
              <button type="button" disabled={Boolean(pendingProfileSave) || busy} className="pharmacy-control min-h-11 text-base font-bold text-green-800 disabled:opacity-50" onClick={() => {
                if (showNewPatient) setShowNewPatient(false);
                else resetPatientForm(patients.length === 0 ? 'self' : 'child');
              }}>
                {showNewPatient ? '一覧に戻る' : patients.length === 0 ? '本人を登録' : '家族を追加'}
              </button>
              {selectedPatient && selectedPatient.relationship === 'self' && !showNewPatient && <button type="button" className="pharmacy-control min-h-11 text-base font-bold text-green-800" onClick={() => {
                setEditing(true);
                setShowNewPatient(true);
                setPatientDraft(patientProfileDraft(selectedPatient));
                setShowAddress(Boolean(selectedPatient.postal_code || selectedPatient.prefecture || selectedPatient.city || selectedPatient.address_line1 || selectedPatient.address_line2));
              }}>患者情報を修正</button>}
            </div>
          </div>
          {pendingProfileSave && <PharmacyStatusBlock tone="info">
            患者情報は保存されました。最新版の確認が必要です。
            <button type="button" onClick={() => void retryProfileRefresh()} disabled={busy} aria-busy={busy} className="pharmacy-control min-h-11 mt-2 block rounded-lg border border-amber-700 bg-white px-4 py-2 font-bold disabled:opacity-50">患者情報を再確認</button>
          </PharmacyStatusBlock>}
          {showNewPatient ? (
            <fieldset disabled={Boolean(pendingProfileSave)}><PatientProfileForm
              draft={patientDraft}
              editing={editing}
              busy={busy}
              showAddress={showAddress}
              errors={profileErrors}
              onChange={updatePatientDraft}
              onToggleAddress={() => setShowAddress((value) => !value)}
              onSubmit={() => void createPatient()}
            /></fieldset>
          ) : loading ? <PharmacyLoading label="読み込み中..." /> : patients.length === 0 ? <p className="text-base text-gray-600">まず患者情報を登録してください。</p> : (
            <label className="block text-base">患者を選択<select value={selectedId} onChange={(event) => selectPatient(event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base" disabled={busy}>{patients.map((patient) => <option key={patient.id} value={patient.id}>{relationshipLabels[patient.relationship]}：{patient.name}</option>)}</select></label>
          )}
          {selectedPatient && <p className="text-base text-gray-700">生年月日：{selectedPatient.birth_date}　回答版：{latestRevision ? `第${latestRevision}版` : '未回答'}</p>}
          {selectedPatient && selectedPatient.relationship !== 'self' && !showNewPatient && (
            <button type="button" onClick={() => void revokeProxy()} disabled={busy} className="min-h-11 w-full rounded-lg border border-red-300 bg-white px-4 py-3 font-bold text-red-700 disabled:opacity-50">
              代理権限を取り消す
            </button>
          )}
        </section>

        {!showNewPatient && selectedPatient && (
          <section className="rounded-xl bg-white p-4 shadow-sm space-y-3" aria-labelledby="notification-heading">
            <h2 id="notification-heading" className="font-bold">LINEのお知らせ</h2>
            {!accessReady || !accessState ? (
              <p className="text-base text-gray-600">設定を確認しています...</p>
            ) : <>
              <p className="text-base text-gray-800">
                現在：<strong>{accessState.notifications === 'enabled' ? '受け取る' : '停止中'}</strong>
              </p>
              <p className="text-base leading-6 text-gray-700">
                この患者について薬局から自動送信されるお知らせを設定します。代理権限や個人情報の同意状態は変わりません。
              </p>
              <button type="button" onClick={() => void updateNotifications()} disabled={busy}
                className="pharmacy-control min-h-11 w-full rounded-xl border border-green-700 bg-white px-4 py-3 font-bold text-green-800 disabled:opacity-50">
                {accessState.notifications === 'enabled' ? 'お知らせを停止する' : 'お知らせを再開する'}
              </button>
            </>}
          </section>
        )}

        {!showNewPatient && selectedPatient && <>
          {latestAnswers && (
            <button
              type="button"
              onClick={() => void confirmUnchanged()}
              disabled={busy || !intakeReady}
              aria-busy={busy}
              className="pharmacy-control min-h-11 w-full rounded-xl border border-green-700 bg-white px-4 py-3 font-bold text-green-800 disabled:opacity-50"
            >
              {busy ? <PharmacySpinner label="更新中…" /> : '前回から変更なしで更新'}
            </button>
          )}
          <PatientQuestionnaire
            answers={answers}
            step={intakeStep}
            busy={busy || intakeLoading}
            showPregnancyQuestions={showPregnancyQuestions}
            representativeConsent={representativeConsent}
            privacyConsent={privacyConsent}
            privacyPolicy={privacyPolicy}
            showErrors={showStepErrors}
            errorNonce={summaryNonce}
            onAnswersChange={updateAnswers}
            onRepresentativeConsentChange={(value) => { setRepresentativeConsent(value); setDraftDirty(true); setSaved(false); }}
            onPrivacyConsentChange={(value) => { setPrivacyConsent(value); setDraftDirty(true); setSaved(false); }}
          />
          {intakeStep === INTAKE_STEP_COUNT && !canSubmitIntake(answers, representativeConsent, privacyConsent, false, privacyPolicy !== null) && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-base text-amber-900">
            <p className="font-bold">送信するには、次を確認してください</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {(['allergiesStatus', 'adverseReactionStatus', 'medicationStatus', 'medicalHistoryStatus'] as const).some((key) => !answers[key]) && <li>安全確認の質問（ステップ1・2）に未回答があります。「戻る」で回答してください。</li>}
              {!representativeConsent && <li>回答内容を薬局へ伝えることへの同意にチェックしてください。</li>}
              {!privacyConsent && <li>個人情報の利用目的への同意にチェックしてください。</li>}
              {!privacyPolicy && <li>個人情報の利用目的を確認できるまで送信できません。薬局へお問い合わせください。</li>}
            </ul>
          </div>}
          <div className="flex gap-3">
            <button type="button" onClick={() => setIntakeStep((step) => Math.max(1, step - 1))} disabled={intakeStep === 1 || busy} className="min-h-11 flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 font-bold text-gray-700 disabled:opacity-40">戻る</button>
            {intakeStep < INTAKE_STEP_COUNT ? <button type="button" onClick={nextStep} disabled={busy || intakeLoading} className="min-h-11 flex-1 rounded-xl bg-green-700 px-4 py-3 font-bold text-white disabled:bg-gray-300">次へ</button> : <button type="button" onClick={() => void submit()} disabled={!intakeReady || !canSubmitIntake(answers, representativeConsent, privacyConsent, busy, privacyPolicy !== null)} aria-busy={busy} className="min-h-11 flex-1 rounded-xl bg-green-700 px-4 py-3 font-bold text-white disabled:bg-gray-300">{busy ? <PharmacySpinner label="保存中…" /> : latestRevision ? '回答を更新する' : 'アンケートを送信する'}</button>}
          </div>
          <button type="button" onClick={() => { if (confirmIntakeNavigation()) navigate(pharmacyRoute('/prescriptions')); }} className="pharmacy-control min-h-11 w-full rounded-xl border border-green-700 bg-white px-4 py-3 font-bold text-green-800">処方せん事前送信へ</button>
          <p className="text-base leading-5 text-gray-700">回答内容は薬局の確認に使います。緊急時は医療機関へご相談ください。</p>
        </>}
      </div>
    </main>
  );
}
