import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";
import { pinnedAccountId, requireConfirmation } from "../custom/pharmacy/rich-menu/guard.js";

export function registerManageRichMenus(server: McpServer): void {
  server.tool(
    "manage_rich_menus",
    "リッチメニューの管理操作。list: 一覧取得、delete: 削除、set_default: デフォルト設定。作成は create_rich_menu ツールを使用。",
    {
      action: z.enum(["list", "delete", "set_default"]).describe("Action to perform"),
      richMenuId: z.string().optional().describe("Rich menu ID (required for delete, set_default)"),
      accountId: z.string().optional().describe("Must match LINE_HARNESS_ACCOUNT_ID"),
      dryRun: z.boolean().default(true).describe("Preview destructive operations without changing LINE"),
      confirm: z.boolean().default(false).describe("Required for live delete/default changes"),
    },
    async ({ action, richMenuId, accountId, dryRun, confirm }) => {
      try {
        const resolvedAccountId = pinnedAccountId(accountId);
        const client = getClient();
        if (action === "list") {
          const menus = await client.richMenus.list(resolvedAccountId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, richMenus: menus }, null, 2) }] };
        }
        if (!richMenuId) throw new Error("richMenuId is required for this action");
        requireConfirmation(dryRun, confirm, `manage_rich_menus:${action}`);
        if (dryRun) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            success: true, dryRun: true, requiresConfirmation: true,
            accountId: resolvedAccountId, action, richMenuId,
          }, null, 2) }] };
        }
        if (action === "delete") {
          await client.richMenus.delete(richMenuId, resolvedAccountId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, deleted: richMenuId }, null, 2) }] };
        }
        if (action === "set_default") {
          await client.richMenus.setDefault(richMenuId, resolvedAccountId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, defaultRichMenuId: richMenuId }, null, 2) }] };
        }
        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(err) }) }], isError: true };
      }
    },
  );
}
