import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient } from '../../../client.js';
import { pinnedAccountId, requireConfirmation } from './guard.js';

function result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function registerPharmacyRichMenuTools(server: McpServer): void {
  server.tool(
    'manage_pharmacy_rich_menus',
    '薬局用リッチメニューを管理する。画像保存とページ間切替を含み、アカウントはLINE_HARNESS_ACCOUNT_IDに固定され、変更操作はdry-runと確認を必須にする。',
    {
      action: z.enum(['list', 'inspect', 'publish', 'unpublish', 'delete', 'apply_to_tag', 'set_switch']),
      groupId: z.string().optional(),
      sourcePageId: z.string().optional(),
      areaId: z.string().optional(),
      targetPageId: z.string().optional(),
      accountId: z.string().optional(),
      mode: z.enum(['bulk-link', 'set-default']).optional(),
      tagId: z.string().nullable().optional(),
      enabled: z.boolean().optional().describe('set-default の初期表示を有効化するか'),
      dryRun: z.boolean().default(true),
      confirm: z.boolean().default(false),
      confirmationToken: z.string().optional(),
      force: z.boolean().default(false),
    },
    async ({ action, groupId, sourcePageId, areaId, targetPageId, accountId, mode, tagId, enabled, dryRun, confirm, confirmationToken, force }) => {
      try {
        const resolvedAccountId = pinnedAccountId(accountId);
        const client = getClient();

        if (action === 'list') {
          return result({ success: true, accountId: resolvedAccountId, groups: await client.richMenuGroups.list(resolvedAccountId) });
        }

        if (!groupId) throw new Error('groupId is required for this action');
        if (action === 'inspect') {
          return result({ success: true, accountId: resolvedAccountId, group: await client.richMenuGroups.get(groupId, resolvedAccountId) });
        }

        if (action === 'set_switch') {
          if (!sourcePageId || !areaId || !targetPageId) {
            throw new Error('sourcePageId, areaId, and targetPageId are required for set_switch');
          }
          if (sourcePageId === targetPageId) throw new Error('source and target pages must differ');
          requireConfirmation(dryRun, confirm, 'set_switch');
          const group = await client.richMenuGroups.get(groupId, resolvedAccountId);
          const pages = group.pages ?? [];
          const source = pages.find((page) => page.id === sourcePageId);
          if (!source) throw new Error(`source page not found: ${sourcePageId}`);
          if (!pages.some((page) => page.id === targetPageId)) {
            throw new Error(`target page not found: ${targetPageId}`);
          }
          const area = source.areas.find((candidate) => candidate.id === areaId);
          if (!area) throw new Error(`area not found on source page: ${areaId}`);
          const nextPages = pages.map((page) => ({
            id: page.id,
            name: page.name,
            orderIndex: page.orderIndex,
            areas: page.areas.map((candidate) => {
              const { id, ...areaInput } = candidate;
              return page.id === sourcePageId && id === areaId
                ? { ...areaInput, actionType: 'richmenuswitch' as const, actionData: { targetPageId } }
                : areaInput;
            }),
          }));
          if (dryRun) {
            return result({
              success: true,
              dryRun: true,
              requiresConfirmation: true,
              operation: 'set_switch',
              accountId: resolvedAccountId,
              groupId,
              sourcePageId,
              areaId,
              targetPageId,
            });
          }
          const updated = await client.richMenuGroups.update(groupId, { pages: nextPages }, resolvedAccountId);
          return result({
            success: true,
            operation: 'set_switch',
            accountId: resolvedAccountId,
            groupId,
            sourcePageId,
            areaId,
            targetPageId,
            group: updated,
          });
        }

        if (action === 'publish' || action === 'unpublish' || action === 'delete') {
          requireConfirmation(dryRun, confirm, action);
          if (dryRun) {
            const group = await client.richMenuGroups.get(groupId, resolvedAccountId);
            return result({
              success: true,
              dryRun: true,
              requiresConfirmation: true,
              operation: action,
              groupId,
              status: group.status,
              pageCount: group.pages?.length ?? 0,
              imageReady: group.pages?.every((page) => !!page.imageR2Key) ?? false,
            });
          }
          if (action === 'publish') {
            return result({ success: true, operation: action, group: await client.richMenuGroups.publish(groupId, resolvedAccountId) });
          }
          if (action === 'unpublish') {
            return result({ success: true, operation: action, group: await client.richMenuGroups.unpublish(groupId, resolvedAccountId) });
          }
          await client.richMenuGroups.delete(groupId, { force, accountId: resolvedAccountId });
          return result({ success: true, operation: action, groupId });
        }

        if (action === 'apply_to_tag') {
          if (!mode) throw new Error('mode is required for apply_to_tag');
          const input = {
            mode,
            ...(mode === 'bulk-link' ? { tagId: tagId ?? null } : {}),
            ...(mode === 'set-default' && enabled !== undefined ? { enabled } : {}),
            dryRun,
            ...(confirmationToken ? { confirmationToken } : {}),
          } as const;
          if (!dryRun) requireConfirmation(false, confirm, 'apply_to_tag');
          return result({
            success: true,
            accountId: resolvedAccountId,
            operation: 'apply_to_tag',
            groupId,
            result: await client.richMenuGroups.applyToTag(groupId, input, resolvedAccountId),
          });
        }

        throw new Error(`unsupported action: ${action}`);
      } catch (error) {
        return result({ success: false, error: String(error) }, true);
      }
    },
  );
}
