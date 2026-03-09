import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "fs";
import { join, resolve, basename, extname } from "path";
import { PACKAGES_DIR } from "./constants.js";
import { addPackage, packageDir, installDependenciesIfNeeded } from "./registry.js";
import { enablePackage, ensurePackageInSettings, generatePackageJson } from "./store.js";
import { ensureGitignore, isGitEnabled, gitSyncPool } from "./git-pool.js";

// ============================================================================
// Execute onboard — the mechanical part after agent review
// ============================================================================

export interface OnboardOptions {
  /** Package name (agent-chosen) */
  name: string;
  /** Source path (absolute) */
  sourcePath: string;
  /** Current working directory / repo path */
  repoPath: string;
}

export function executeOnboard(opts: OnboardOptions): { gitSync?: string } {
  const absPath = opts.sourcePath.startsWith("~/")
    ? join(process.env.HOME || "/root", opts.sourcePath.slice(2))
    : resolve(opts.repoPath, opts.sourcePath);

  if (!existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  const targetDir = packageDir(opts.name);
  if (existsSync(targetDir)) {
    throw new Error(`Package "${opts.name}" already exists in the pool. Remove it first.`);
  }

  mkdirSync(PACKAGES_DIR, { recursive: true });

  // Move to pool
  cpSync(absPath, targetDir, { recursive: true });
  rmSync(absPath, { recursive: true, force: true });

  // Ensure .gitignore has node_modules
  const gitignorePath = join(targetDir, ".gitignore");
  let gitignoreContent = "";
  try { gitignoreContent = readFileSync(gitignorePath, "utf-8"); } catch {}
  if (!gitignoreContent.includes("node_modules")) {
    gitignoreContent += (gitignoreContent && !gitignoreContent.endsWith("\n") ? "\n" : "") + "node_modules/\n";
    writeFileSync(gitignorePath, gitignoreContent);
  }

  // Ensure pi-package keyword in package.json
  const pkgJsonPath = join(targetDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (!pkg.keywords?.includes("pi-package")) {
        pkg.keywords = pkg.keywords || [];
        pkg.keywords.push("pi-package");
        writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
      }
      // npm install if needed
      if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
        installDependenciesIfNeeded(targetDir);
      }
    } catch {}
  }

  // Register in registry
  addPackage({
    name: opts.name,
    sourceType: "local",
    source: "local",
    onboardedFrom: absPath,
    installedAt: new Date().toISOString(),
  });

  // Enable for the repo
  enablePackage(opts.repoPath, opts.name);
  generatePackageJson(opts.repoPath);
  ensurePackageInSettings(opts.repoPath);

  // Update pool .gitignore if git-enabled
  ensureGitignore();

  // Auto git-sync
  let gitSync: string | undefined;
  if (isGitEnabled()) {
    try {
      const result = gitSyncPool();
      gitSync = result.message;
    } catch (e: any) {
      gitSync = `sync failed: ${e.message}`;
    }
  }

  return { gitSync };
}
