import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '@/lib/api';
import {
  canMutatePharmacyRichMenu,
  movePharmacyRichMenuAction,
  PHARMACY_RICH_MENU_LABELS,
  pharmacyRichMenuDiffLabel,
  pharmacyRichMenuReadinessMessage,
} from './PharmacyRichMenuLayoutPanel';
import { richMenuAreaStyle } from './preview-geometry';

const ORDER = [
  'prescription-send', 'prescription-history', 'medication-followup', 'manual-chat', 'pharmacy-info',
];
const HERE = dirname(fileURLToPath(import.meta.url));

describe('pharmacy rich-menu layout panel', () => {
  it('keeps ordinary staff read-only in the management UI', () => {
    expect(canMutatePharmacyRichMenu('owner')).toBe(true);
    expect(canMutatePharmacyRichMenu('admin')).toBe(true);
    expect(canMutatePharmacyRichMenu('staff')).toBe(false);
    expect(canMutatePharmacyRichMenu(null)).toBe(false);
  });

  it('uses the exact visible tile labels in the reorder controls', () => {
    expect(PHARMACY_RICH_MENU_LABELS).toEqual({
      'prescription-send': '処方せん事前送信',
      'prescription-history': '受付状況',
      'medication-followup': '服薬後フォロー',
      'manual-chat': '薬局へ相談',
      'pharmacy-info': '薬局情報',
    });
  });

  it('moves one tile without dropping or duplicating another tile', () => {
    expect(movePharmacyRichMenuAction(ORDER, 'medication-followup', -1)).toEqual([
      'prescription-send', 'medication-followup', 'prescription-history', 'manual-chat', 'pharmacy-info',
    ]);
    expect(movePharmacyRichMenuAction(ORDER, 'prescription-send', -1)).toEqual(ORDER);
    expect(movePharmacyRichMenuAction(ORDER, 'pharmacy-info', 1)).toEqual(ORDER);
  });

  it('turns publish diagnostics into an actionable Japanese error', () => {
    const error = new ApiError(409, 'pharmacy rich-menu version is not ready', {
      status: 'BLOCKED',
      reasonCodes: ['ACTION_URI_INVALID', 'ACTION_MESSAGE_INVALID'],
    });

    expect(pharmacyRichMenuReadinessMessage(error)).toBe(
      'リンク先が正しくありません。相談メッセージが承認済み文言と一致しません。',
    );
  });

  it('maps saved LINE pixel bounds onto compact and large previews', () => {
    expect(richMenuAreaStyle({
      boundsX: 0, boundsY: 0, boundsWidth: 1250, boundsHeight: 843,
    }, 'large')).toEqual({ left: '0%', top: '0%', width: '50%', height: '50%' });
    expect(richMenuAreaStyle({
      boundsX: 1250, boundsY: 0, boundsWidth: 1250, boundsHeight: 843,
    }, 'compact')).toEqual({ left: '50%', top: '0%', width: '50%', height: '100%' });
  });

  it('describes every public-to-draft diff for screen readers', () => {
    expect(pharmacyRichMenuDiffLabel({ kind: 'same', currentIndex: 0, draftIndex: 0 }))
      .toBe('枠1: 同一');
    expect(pharmacyRichMenuDiffLabel({ kind: 'moved', currentIndex: 2, draftIndex: 0 }))
      .toBe('枠1: 枠3から移動');
    expect(pharmacyRichMenuDiffLabel({ kind: 'added', currentIndex: null, draftIndex: 1 }))
      .toBe('枠2: 追加');
    expect(pharmacyRichMenuDiffLabel({ kind: 'removed', currentIndex: 1, draftIndex: null }))
      .toBe('枠2: 削除');
    expect(pharmacyRichMenuDiffLabel({ kind: 'action_changed', currentIndex: 1, draftIndex: 1 }))
      .toBe('枠2: action変更');
    expect(pharmacyRichMenuDiffLabel({ kind: 'image_changed', currentIndex: 1, draftIndex: 1 }))
      .toBe('枠2: 画像変更');
  });

  it('uses the pharmacy layout API and exposes keyboard-operable move controls', () => {
    const panel = readFileSync(join(HERE, 'PharmacyRichMenuLayoutPanel.tsx'), 'utf8');
    const api = readFileSync(join(HERE, 'api.ts'), 'utf8');
    const genericApi = readFileSync(join(HERE, '../../../lib/api.ts'), 'utf8');
    const page = readFileSync(join(HERE, '../../../app/rich-menus/page.tsx'), 'utf8');
    const accounts = readFileSync(join(HERE, '../../../app/accounts/page.tsx'), 'utf8');
    const featureSettings = readFileSync(join(HERE, '../growth-loop/FeatureSettingsPage.tsx'), 'utf8');
    const resetStart = panel.indexOf('useEffect(() => {\n    setLayout(null)');
    const accountReset = panel.slice(resetStart, panel.indexOf('\n  }, [load])', resetStart));

    expect(api).toContain('/api/custom/pharmacy/rich-menus/layout?accountId=');
    expect(api).toContain('/api/custom/pharmacy/rich-menus/lifecycle?accountId=');
    expect(api).toContain('/api/custom/pharmacy/rich-menus/versions?accountId=');
    expect(api).toContain('/diff?accountId=${encodeURIComponent(accountId)}');
    expect(genericApi).toContain('getForAccount: (groupId: string, accountId: string)');
    expect(api).toContain('renamePharmacyVersion:');
    expect(api).toContain('deletePharmacyVersion:');
    expect(api).toContain('reconcilePharmacyOperation:');
    expect(api).toContain('resumePharmacyOperation:');
    expect(api).toContain('/publish?accountId=${encodeURIComponent(accountId)}');
    expect(panel).toContain('pharmacyGrowthApi.readiness');
    expect(panel).toContain('pharmacyRichMenuApi.pharmacyLifecycle');
    expect(panel).toContain('pharmacyRichMenuApi.savePharmacyLifecycle');
    expect(panel).toContain('リッチメニュー運用状態');
    expect(panel).toContain('停止中');
    expect(panel).toContain('稼働中');
    expect(panel).toContain('凍結中');
    expect(panel).toContain('設定不足');
    expect(panel).toContain('初期設定を開始');
    expect(panel).toContain('初期設定を再開');
    expect(panel).toContain('初期設定を確認');
    expect(panel).toContain('aria-label="リッチメニュー初期設定の手順"');
    expect(panel).toContain('1. 患者向け機能をON/OFF');
    expect(panel).toContain('2. 並び順を保存');
    expect(panel).toContain('3. 現在の配置を画像として保存');
    expect(panel).toContain('4. LINEへ登録');
    expect(panel).toContain('5. この画像に切替');
    expect(panel).toContain('「処方せん事前送信」と「受付状況」は同時にON/OFF');
    expect(panel).toContain("localStorage.getItem('lh_staff_role')");
    expect(panel).toContain('一般スタッフは閲覧のみです。変更はオーナーまたは管理者が行ってください。');
    expect(panel).toContain("versionsResponse.data.length === 0 ? current || '通常営業メニュー' : current");
    expect(panel).toContain('保存済みメニュー');
    expect(panel).toContain('メニュー名');
    expect(panel).not.toContain('保存済み画像version');
    expect(panel).toContain('disabled={lifecycleSaving || lifecycle.state === state || !canMutate}');
    expect(panel).toContain('disabled={index === 0 || saving || !canMutate}');
    expect(panel).toContain('disabled={dirty || creating || !versionName.trim() || !canMutate}');
    expect(panel).toContain("readiness.capabilityEnabled ? '#pharmacy-rich-menu-layout-editor' : '/pharmacy-features'");
    expect(panel).toContain('aria-label={`${label}を前へ移動`}');
    expect(panel).toContain('aria-label={`${label}を後ろへ移動`}');
    expect(panel).toContain('最後の枠: すべての機能');
    expect(panel).toContain('現在の配置を画像として保存');
    expect(panel).toContain('LINEへ登録');
    expect(panel).toContain('名前を変更');
    expect(panel).toContain('前回確認済み');
    expect(panel).toContain('結果確認が必要');
    expect(panel).toContain('状態を再確認');
    expect(panel).toContain('登録を再開');
    expect(panel).toContain('下書きを削除');
    expect(panel).toContain('この画像へ戻す');
    expect(panel).toContain('画像とtap領域を確認');
    expect(panel).toContain('公開中との差分');
    expect(panel).toContain('CURRENT_DEFAULT_EVIDENCE_STALE');
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('aria-modal="true"');
    expect(panel).toContain('page.imageR2Key !== version.imageR2Key');
    expect(panel).toContain('accountRef.current !== requestedAccountId');
    expect(accountReset).toContain('setSaving(false)');
    expect(accountReset).toContain('setLifecycleSaving(false)');
    expect(accountReset).toContain('setCreating(false)');
    expect(accountReset).toContain('setRenaming(null)');
    expect(accountReset).toContain('setDeleting(null)');
    expect(accountReset).toContain('setPublishing(null)');
    expect(panel).toContain('check.actionType');
    expect(panel).toContain('initialSetDefaultIntent={switchIntent}');
    expect(panel).toContain('<ApplyToTagModal');
    expect(page).toContain('selectedAccount?.pharmacyMode && <PharmacyRichMenuLayoutPanel');
    expect(page).toContain('!selectedAccount.pharmacyMode');
    expect(page).toContain('if (selectedAccount.pharmacyMode)');
    expect(page).toContain('この画像に切替');
    expect(accounts).not.toContain('preparePharmacy');
    expect(accounts).toContain('href="/rich-menus"');
    expect(accounts).toContain('pharmacyGrowthApi.readiness');
    expect(accounts).toContain('初期設定を開始');
    expect(accounts).toContain('初期設定を再開');
    expect(accounts).toContain('初期設定を確認');
    expect(accounts).toContain('configurationDoctor.checks');
    expect(accounts).toContain('check.fixHref');
    expect(featureSettings).toContain("from '@/custom/pharmacy/rich-menu/preview-geometry'");
    expect(featureSettings).not.toContain("from '@/custom/pharmacy/rich-menu/PharmacyRichMenuLayoutPanel'");
  });
});
