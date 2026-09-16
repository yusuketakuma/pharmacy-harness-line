import * as p from "@clack/prompts";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import {
  renderInstalledWranglerToml,
  resolveInstalledWranglerConfig,
  type SavedInstallConfig,
} from "../lib/installed-wrangler.js";
import { repoPnpm } from "../lib/pnpm.js";

const REPO_URL =
  process.env.LINE_HARNESS_REPO_URL ??
  "https://github.com/Shudesu/line-harness-oss.git";

/**
 * Pin the cloned repo to the release tag for `version` (e.g. `0.16.0` →
 * `v0.16.0`).
 *
 * Setup deploys the Worker from the official release bundle; pinning the
 * clone to the SAME release keeps everything else sourced from the repo —
 * schema.sql, migrations, the vite-built client assets — consistent with
 * the deployed Worker. Installing from main HEAD instead would apply
 * migrations newer than the release, leaving the database "ahead" of what
 * the manifest expects on the next update.
 *
 * A dirty checkout is never reset here. Setup's canonical clone is made
 * clean by `ensureRepo` only when its config is an exact regenerated file;
 * custom checkouts fail closed and retain their edits.
 */
export async function pinRepoToTag(
  repoDir: string,
  version: string,
): Promise<void> {
  const tag = `v${version}`;
  const s = p.spinner();
  s.start(`リリース ${tag} のソースに固定中...`);

  try {
    await execa(
      "git",
      ["fetch", "--depth", "1", "origin", "tag", tag, "--no-tags"],
      { cwd: repoDir },
    );
    await execa("git", ["checkout", "--quiet", tag], { cwd: repoDir });
  } catch (error: any) {
    s.stop(`リリースタグ ${tag} への切り替えに失敗`);
    throw new Error(
      [
        `リリースタグ ${tag} を取得できませんでした: ${error.message}`,
        "ネットワークを確認して再実行してください。",
        "（タグの無い開発用リポジトリの場合は --from-source を使ってください）",
      ].join("\n"),
    );
  }
  s.stop(`リリース ${tag} のソースに固定しました`);

  // The tag may pin different dependency versions than the previously
  // installed main HEAD — reinstall to match its lockfile.
  s.start("依存関係インストール中...");
  try {
    await repoPnpm(repoDir, ["install", "--frozen-lockfile"], {
      cwd: repoDir,
    });
  } catch {
    await repoPnpm(repoDir, ["install"], { cwd: repoDir });
  }
  s.stop("依存関係インストール完了");
}

/**
 * Clone the LINE Harness repo and install dependencies.
 * Returns the path to the cloned repo.
 */
export async function ensureRepo(repoDir: string | null): Promise<string> {
  // If --repo-dir was given and has the repo, use it
  if (repoDir && existsSync(join(repoDir, "pnpm-workspace.yaml"))) {
    return repoDir;
  }

  // Check if cwd is the repo
  if (existsSync(join(process.cwd(), "pnpm-workspace.yaml"))) {
    return process.cwd();
  }

  // Check standard install location
  const homeDir = join(
    process.env.HOME || process.env.USERPROFILE || tmpdir(),
    ".line-harness",
  );
  if (existsSync(join(homeDir, "pnpm-workspace.yaml"))) {
    const wranglerTomlPath = join(homeDir, "apps/worker/wrangler.toml");
    const configPath = join(homeDir, ".line-harness-config.json");
    let installedToml: string | null = null;

    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(
          readFileSync(configPath, "utf-8"),
        ) as SavedInstallConfig;
        const resolved = resolveInstalledWranglerConfig(config);
        if (resolved) {
          installedToml = renderInstalledWranglerToml(resolved);
        }
      } catch {
        // Ignore unreadable config and continue with a normal pull.
      }
    }

    if (installedToml && existsSync(wranglerTomlPath)) {
      try {
        const currentToml = readFileSync(wranglerTomlPath, "utf-8");
        if (currentToml === installedToml) {
          // A generated file is safe to restore only when it is not staged.
          // Marker-only or hand-edited files remain untouched.
          await execa(
            "git",
            ["diff", "--cached", "--quiet", "--", "apps/worker/wrangler.toml"],
            { cwd: homeDir },
          );
          const mode = statSync(wranglerTomlPath).mode & 0o777;
          try {
            await execa("git", ["checkout", "--", "apps/worker/wrangler.toml"], {
              cwd: homeDir,
            });
          } catch {
            // Restore the exact preimage if git failed after touching the file.
            try {
              writeFileSync(wranglerTomlPath, currentToml);
              chmodSync(wranglerTomlPath, mode);
            } catch {
              // Leave the original failure visible through the pull guard.
            }
          }
        }
      } catch {
        // A staged/mismatched/unreadable file is user-owned for this run.
      }
    }

    // Pull latest
    const s = p.spinner();
    s.start("最新バージョンを取得中...");
    try {
      await execa("git", ["pull", "--ff-only"], { cwd: homeDir });
    } catch {
      // Non-critical, continue with existing
    }
    s.stop("リポジトリ更新完了");

    return homeDir;
  }

  // Clone fresh
  const s = p.spinner();
  s.start("LINE Harness をダウンロード中...");

  try {
    await execa("git", ["clone", "--depth", "1", REPO_URL, homeDir]);
  } catch (error: any) {
    s.stop("ダウンロード失敗");
    throw new Error(
      `git clone に失敗しました: ${error.message}\ngit がインストールされているか確認してください。`,
    );
  }
  s.stop("ダウンロード完了");

  // Install dependencies
  s.start("依存関係インストール中...");
  try {
    await repoPnpm(homeDir, ["install", "--frozen-lockfile"], {
      cwd: homeDir,
    });
  } catch {
    // Try without frozen lockfile
    await repoPnpm(homeDir, ["install"], { cwd: homeDir });
  }
  s.stop("依存関係インストール完了");

  return homeDir;
}
