import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, lstatSync } from "fs";
import { join, resolve, basename, relative } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import {
  PACKAGES_DIR,
  REPOS_DIR,
  CONFIG_ROOT,
  type RepoManifest,
  type PackageResources,
} from "./constants.js";
import { loadRegistry, packageDir, getMandatoryPackages } from "./registry.js";

// ============================================================================
// Repo hashing
// ============================================================================

export function repoHash(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex").slice(0, 16);
}

export function repoPackageDir(repoPath: string): string {
  return join(REPOS_DIR, repoHash(repoPath));
}

// ============================================================================
// Repo manifest (which packages are enabled per-repo)
// ============================================================================

function manifestPath(repoPath: string): string {
  return join(repoPackageDir(repoPath), "manifest.json");
}

export function loadRepoManifest(repoPath: string): RepoManifest {
  const mp = manifestPath(repoPath);
  try {
    const data = JSON.parse(readFileSync(mp, "utf-8"));
    return {
      repoPath: data.repoPath || repoPath,
      enabled: Array.isArray(data.enabled) ? data.enabled : [],
      disabled: Array.isArray(data.disabled) ? data.disabled : [],
    };
  } catch {
    return { repoPath, enabled: [], disabled: [] };
  }
}

export function saveRepoManifest(manifest: RepoManifest): void {
  const dir = repoPackageDir(manifest.repoPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(manifest.repoPath), JSON.stringify(manifest, null, 2));
}

// ============================================================================
// Resolve what resources a package provides
// ============================================================================

function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

function collectFiles(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isDir(full)) {
      // For skills, the directory itself is the resource
      if (existsSync(join(full, "SKILL.md"))) {
        files.push(full);
      } else {
        // Recurse for nested extension dirs
        const indexTs = join(full, "index.ts");
        const indexJs = join(full, "index.js");
        if (existsSync(indexTs)) files.push(full);
        else if (existsSync(indexJs)) files.push(full);
      }
    } else if (extensions.some(ext => entry.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

export function resolvePackageResources(pkgName: string): PackageResources {
  const dir = packageDir(pkgName);
  if (!existsSync(dir)) return { extensions: [], skills: [], prompts: [], themes: [] };

  // Check for pi manifest in package.json
  const pkgJsonPath = join(dir, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (pkg.pi) {
        const result: PackageResources = { extensions: [], skills: [], prompts: [], themes: [] };

        if (pkg.pi.extensions) {
          for (const entry of pkg.pi.extensions) {
            const resolved = resolve(dir, entry);
            if (existsSync(resolved)) {
              if (isDir(resolved)) {
                result.extensions.push(...collectFiles(resolved, [".ts", ".js"]));
              } else {
                result.extensions.push(resolved);
              }
            }
          }
        }

        if (pkg.pi.skills) {
          for (const entry of pkg.pi.skills) {
            const resolved = resolve(dir, entry);
            if (existsSync(resolved)) {
              if (isDir(resolved)) {
                // Could be a skill dir directly or a dir containing skills
                if (existsSync(join(resolved, "SKILL.md"))) {
                  result.skills.push(resolved);
                } else {
                  result.skills.push(...collectFiles(resolved, []));
                }
              }
            }
          }
        }

        if (pkg.pi.prompts) {
          for (const entry of pkg.pi.prompts) {
            const resolved = resolve(dir, entry);
            if (existsSync(resolved)) {
              if (isDir(resolved)) {
                result.prompts.push(...collectFiles(resolved, [".md"]));
              } else {
                result.prompts.push(resolved);
              }
            }
          }
        }

        if (pkg.pi.themes) {
          for (const entry of pkg.pi.themes) {
            const resolved = resolve(dir, entry);
            if (existsSync(resolved)) {
              if (isDir(resolved)) {
                result.themes.push(...collectFiles(resolved, [".json"]));
              } else {
                result.themes.push(resolved);
              }
            }
          }
        }

        return result;
      }
    } catch {}
  }

  // Fall back to convention directories
  return {
    extensions: collectFiles(join(dir, "extensions"), [".ts", ".js"]),
    skills: collectFiles(join(dir, "skills"), []),
    prompts: collectFiles(join(dir, "prompts"), [".md"]),
    themes: collectFiles(join(dir, "themes"), [".json"]),
  };
}

// ============================================================================
// Resolve active packages for a repo
// ============================================================================

/**
 * Resolve the active package set: (mandatory - disabled) + enabled, deduplicated.
 * Accepts an optional pre-loaded manifest to avoid double-reads.
 */
export function getActivePackages(repoPath: string, manifest?: RepoManifest): string[] {
  const m = manifest || loadRepoManifest(repoPath);
  const mandatory = getMandatoryPackages();
  const disabledSet = new Set(m.disabled);
  const seen = new Set<string>();
  const result: string[] = [];

  // Mandatory packages first (unless disabled)
  for (const name of mandatory) {
    if (!disabledSet.has(name) && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }

  // Then explicitly enabled packages
  for (const name of m.enabled) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }

  return result;
}

// ============================================================================
// Generate pi package.json for a repo
// ============================================================================

export function generatePackageJson(repoPath: string): string {
  const manifest = loadRepoManifest(repoPath);
  const dir = repoPackageDir(repoPath);
  mkdirSync(dir, { recursive: true });

  const allExtensions: string[] = [];
  const allSkills: string[] = [];
  const allPrompts: string[] = [];
  const allThemes: string[] = [];

  // Resolve active packages: (mandatory - disabled) + enabled, deduplicated
  const active = getActivePackages(repoPath, manifest);

  for (const pkgName of active) {
    const resources = resolvePackageResources(pkgName);
    allExtensions.push(...resources.extensions);
    allSkills.push(...resources.skills);
    allPrompts.push(...resources.prompts);
    allThemes.push(...resources.themes);
  }

  const piManifest: Record<string, string[]> = {};
  if (allExtensions.length > 0) piManifest.extensions = allExtensions;
  if (allSkills.length > 0) piManifest.skills = allSkills;
  if (allPrompts.length > 0) piManifest.prompts = allPrompts;
  if (allThemes.length > 0) piManifest.themes = allThemes;

  const pkgJson = {
    name: `managed-${repoHash(repoPath)}`,
    version: "1.0.0",
    description: `Managed package for ${repoPath}`,
    pi: piManifest,
  };

  writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
  return dir;
}

// ============================================================================
// Toggle a package for a repo
// ============================================================================

export function togglePackage(repoPath: string, pkgName: string): boolean {
  const manifest = loadRepoManifest(repoPath);
  const mandatory = getMandatoryPackages();
  const isMandatory = mandatory.includes(pkgName);

  if (isMandatory) {
    // Mandatory packages toggle via the disabled list
    const idx = manifest.disabled.indexOf(pkgName);
    if (idx >= 0) {
      // Currently disabled → re-enable (remove from disabled)
      manifest.disabled.splice(idx, 1);
    } else {
      // Currently enabled (default) → disable
      manifest.disabled.push(pkgName);
    }
    saveRepoManifest(manifest);
    generatePackageJson(repoPath);
    return idx >= 0; // true if now enabled (was in disabled, removed)
  } else {
    // Normal packages toggle via the enabled list
    const idx = manifest.enabled.indexOf(pkgName);
    if (idx >= 0) {
      manifest.enabled.splice(idx, 1);
    } else {
      manifest.enabled.push(pkgName);
    }
    saveRepoManifest(manifest);
    generatePackageJson(repoPath);
    return idx < 0; // true if now enabled
  }
}

export function enablePackage(repoPath: string, pkgName: string): void {
  const manifest = loadRepoManifest(repoPath);
  if (!manifest.enabled.includes(pkgName)) {
    manifest.enabled.push(pkgName);
    saveRepoManifest(manifest);
    generatePackageJson(repoPath);
  }
}

// ============================================================================
// Ensure package source is in a repo's .pi/settings.json
// ============================================================================

export function ensurePackageInSettings(repoPath: string): boolean {
  const settingsPath = join(repoPath, ".pi", "settings.json");
  // Build a ~-relative path so it's portable across machines
  // CONFIG_ROOT might be ~/.pi or a custom path via PI_CODING_AGENT_DIR
  const home = homedir();
  const reposDir = join(CONFIG_ROOT, "packagemanager", "repos", repoHash(repoPath));
  const packageSource = reposDir.startsWith(home)
    ? `~/${relative(home, reposDir)}`
    : reposDir;

  let settings: any = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {}

  if (!settings.packages) settings.packages = [];

  // Check if already present
  const alreadyPresent = settings.packages.some((p: any) =>
    typeof p === "string" ? p === packageSource : p?.source === packageSource
  );
  if (alreadyPresent) return false;

  settings.packages.push(packageSource);
  mkdirSync(join(repoPath, ".pi"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
}

// ============================================================================
// Description helpers
// ============================================================================

export function getPackageDescription(pkgName: string): string {
  const dir = packageDir(pkgName);

  // Check package.json
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    if (pkg.description) return pkg.description.slice(0, 80);
  } catch {}

  // Check for single SKILL.md
  const skillMd = join(dir, "SKILL.md");
  if (existsSync(skillMd)) {
    try {
      const content = readFileSync(skillMd, "utf-8");
      const match = content.match(/description:\s*(.+)/);
      if (match) return match[1].trim().slice(0, 80);
    } catch {}
  }

  // Describe by what it contains
  const resources = resolvePackageResources(pkgName);
  const parts: string[] = [];
  if (resources.extensions.length) parts.push(`${resources.extensions.length} ext`);
  if (resources.skills.length) parts.push(`${resources.skills.length} skill`);
  if (resources.prompts.length) parts.push(`${resources.prompts.length} prompt`);
  if (resources.themes.length) parts.push(`${resources.themes.length} theme`);
  return parts.length > 0 ? parts.join(", ") : "empty package";
}
