import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, lstatSync, readdirSync, statSync } from "fs";
import { join, resolve, basename, dirname, extname } from "path";
import { PACKAGES_DIR } from "./constants.js";
import { addPackage, packageDir, installDependenciesIfNeeded } from "./registry.js";
import { enablePackage, ensurePackageInSettings, generatePackageJson } from "./store.js";
import { ensureGitignore } from "./git-pool.js";

// ============================================================================
// Types
// ============================================================================

/** Pi package component types matching the pi package spec */
export type PiComponentType = "extension" | "skill" | "prompt" | "theme";

export interface ComponentDetail {
  type: PiComponentType;
  /** How it was detected */
  via: "pi-manifest" | "convention-dir" | "file-pattern" | "file-type";
  /** Specific files or paths that triggered detection */
  evidence: string[];
}

export interface OnboardAnalysis {
  /** Source path (absolute) */
  sourcePath: string;
  /** Detected type */
  type: "single-file" | "directory" | "directory-with-package";
  /** Derived package name */
  name: string;
  /** Whether it has dependencies that need npm install */
  hasDependencies: boolean;
  /** Dependencies list */
  dependencies: string[];
  /** Description of what will happen */
  steps: string[];
  /** Target directory */
  targetDir: string;
  /** Whether source is a valid pi component */
  valid: boolean;
  /** Error message if not valid */
  error?: string;
  /** Detected pi components with details */
  components: ComponentDetail[];
  /** Whether package.json has a pi manifest */
  hasPiManifest: boolean;
  /** Description from package.json if available */
  description: string;
  /** Files found (relative paths) */
  files: string[];
  /** pi manifest details if present */
  piManifest: Record<string, unknown> | null;
  /** Has pi-package keyword */
  hasPiKeyword: boolean;
}

// ============================================================================
// Analysis — examine what we're onboarding
// ============================================================================

function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        out.push(...listFiles(full, `${prefix}${entry}/`));
      } else {
        out.push(`${prefix}${entry}`);
      }
    } catch {}
  }
  return out;
}

/** Check if a directory contains SKILL.md (making it a skill folder) */
function hasSkillMd(dir: string): boolean {
  return existsSync(join(dir, "SKILL.md"));
}

/** Recursively find SKILL.md folders inside a directory */
function findSkillFolders(dir: string): string[] {
  const results: string[] = [];
  if (hasSkillMd(dir)) results.push(dir);
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory() && hasSkillMd(full)) {
        results.push(full);
      }
    } catch {}
  }
  return results;
}

export function analyzeOnboard(sourcePath: string, cwd: string): OnboardAnalysis {
  const expanded = sourcePath.startsWith("~/") ? join(process.env.HOME || "/root", sourcePath.slice(2)) : sourcePath;
  const absPath = resolve(cwd, expanded);
  const result: OnboardAnalysis = {
    sourcePath: absPath,
    type: "single-file",
    name: "",
    hasDependencies: false,
    dependencies: [],
    steps: [],
    targetDir: "",
    valid: false,
    components: [],
    hasPiManifest: false,
    description: "",
    files: [],
    piManifest: null,
    hasPiKeyword: false,
  };

  if (!existsSync(absPath)) {
    result.error = `Path does not exist: ${absPath}`;
    return result;
  }

  if (isDir(absPath)) {
    // List all files
    result.files = listFiles(absPath);
    const topEntries = readdirSync(absPath);

    // Directory — check for package.json
    const pkgJsonPath = join(absPath, "package.json");
    if (existsSync(pkgJsonPath)) {
      result.type = "directory-with-package";
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        result.name = sanitizeName(pkg.name || basename(absPath));
        result.description = pkg.description || "";
        if (pkg.keywords?.includes("pi-package")) {
          result.hasPiKeyword = true;
        }
        if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
          result.hasDependencies = true;
          result.dependencies = Object.entries(pkg.dependencies).map(
            ([name, ver]) => `${name}@${ver}`
          );
        }
        if (pkg.pi) {
          result.hasPiManifest = true;
          result.piManifest = pkg.pi;
        }
      } catch {
        result.name = sanitizeName(basename(absPath));
      }
    } else {
      result.type = "directory";
      result.name = sanitizeName(basename(absPath));
    }

    // ── Detect from pi manifest ──────────────────────────────────────
    if (result.piManifest) {
      const m = result.piManifest;
      if (m.extensions && (m.extensions as string[]).length > 0) {
        result.components.push({
          type: "extension",
          via: "pi-manifest",
          evidence: (m.extensions as string[]),
        });
      }
      if (m.skills && (m.skills as string[]).length > 0) {
        result.components.push({
          type: "skill",
          via: "pi-manifest",
          evidence: (m.skills as string[]),
        });
      }
      if (m.prompts && (m.prompts as string[]).length > 0) {
        result.components.push({
          type: "prompt",
          via: "pi-manifest",
          evidence: (m.prompts as string[]),
        });
      }
      if (m.themes && (m.themes as string[]).length > 0) {
        result.components.push({
          type: "theme",
          via: "pi-manifest",
          evidence: (m.themes as string[]),
        });
      }
    }

    // ── Detect from convention directories ────────────────────────────
    const hasTypes = new Set(result.components.map(c => c.type));

    if (!hasTypes.has("extension") && existsSync(join(absPath, "extensions"))) {
      const extFiles = listFiles(join(absPath, "extensions"))
        .filter(f => f.endsWith(".ts") || f.endsWith(".js"));
      if (extFiles.length > 0) {
        result.components.push({
          type: "extension",
          via: "convention-dir",
          evidence: extFiles.map(f => `extensions/${f}`),
        });
      }
    }

    if (!hasTypes.has("skill") && existsSync(join(absPath, "skills"))) {
      const skillFolders = findSkillFolders(join(absPath, "skills"));
      const skillMds = listFiles(join(absPath, "skills")).filter(f => f.endsWith(".md"));
      if (skillFolders.length > 0 || skillMds.length > 0) {
        result.components.push({
          type: "skill",
          via: "convention-dir",
          evidence: [
            ...skillFolders.map(f => `skills/${basename(f)}/SKILL.md`),
            ...skillMds.map(f => `skills/${f}`),
          ],
        });
      }
    }

    if (!hasTypes.has("prompt") && existsSync(join(absPath, "prompts"))) {
      const promptFiles = listFiles(join(absPath, "prompts")).filter(f => f.endsWith(".md"));
      if (promptFiles.length > 0) {
        result.components.push({
          type: "prompt",
          via: "convention-dir",
          evidence: promptFiles.map(f => `prompts/${f}`),
        });
      }
    }

    if (!hasTypes.has("theme") && existsSync(join(absPath, "themes"))) {
      const themeFiles = listFiles(join(absPath, "themes")).filter(f => f.endsWith(".json"));
      if (themeFiles.length > 0) {
        result.components.push({
          type: "theme",
          via: "convention-dir",
          evidence: themeFiles.map(f => `themes/${f}`),
        });
      }
    }

    // ── Detect from file patterns (root-level files, no convention dirs) ─
    const hasTypesNow = new Set(result.components.map(c => c.type));

    if (!hasTypesNow.has("extension")) {
      const rootTsJs = topEntries.filter(f => {
        if (f === "package.json") return false;
        return (f.endsWith(".ts") || f.endsWith(".js")) && !statSync(join(absPath, f)).isDirectory();
      });
      if (rootTsJs.length > 0) {
        result.components.push({
          type: "extension",
          via: "file-pattern",
          evidence: rootTsJs,
        });
      }
    }

    if (!hasTypesNow.has("skill") && hasSkillMd(absPath)) {
      result.components.push({
        type: "skill",
        via: "file-pattern",
        evidence: ["SKILL.md"],
      });
    }

    if (!hasTypesNow.has("prompt")) {
      const rootMds = topEntries.filter(f =>
        f.endsWith(".md") && f !== "README.md" && f !== "SKILL.md" && f !== "DEVELOPMENT.md" && f !== "AGENTS.md"
      );
      if (rootMds.length > 0) {
        result.components.push({
          type: "prompt",
          via: "file-pattern",
          evidence: rootMds,
        });
      }
    }

    if (!hasTypesNow.has("theme")) {
      const rootJsonThemes = topEntries.filter(f =>
        f.endsWith(".json") && f !== "package.json" && f !== "package-lock.json" && f !== "tsconfig.json"
      );
      // Only count as themes if they look like theme files (heuristic)
      const themeEvidence: string[] = [];
      for (const f of rootJsonThemes) {
        try {
          const content = JSON.parse(readFileSync(join(absPath, f), "utf-8"));
          // Theme files typically have color-related keys
          if (content.colors || content.fg || content.bg || content.accent || content.theme) {
            themeEvidence.push(f);
          }
        } catch {}
      }
      if (themeEvidence.length > 0) {
        result.components.push({
          type: "theme",
          via: "file-pattern",
          evidence: themeEvidence,
        });
      }
    }

    if (result.components.length === 0) {
      result.error = "No pi components found. Expected: extensions (.ts/.js), skills (SKILL.md), prompts (.md), or themes (.json)";
      return result;
    }
  } else {
    // Single file
    const ext = extname(absPath);
    const name = basename(absPath);

    if (ext === ".ts" || ext === ".js") {
      result.type = "single-file";
      result.name = sanitizeName(basename(absPath, ext));
      result.files = [name];
      result.components.push({ type: "extension", via: "file-type", evidence: [name] });
    } else if (name === "SKILL.md") {
      result.type = "single-file";
      result.name = sanitizeName(basename(dirname(absPath)));
      result.files = [name];
      result.components.push({ type: "skill", via: "file-type", evidence: [name] });
    } else if (ext === ".md") {
      result.type = "single-file";
      result.name = sanitizeName(basename(absPath, ext));
      result.files = [name];
      result.components.push({ type: "prompt", via: "file-type", evidence: [name] });
    } else if (ext === ".json") {
      result.type = "single-file";
      result.name = sanitizeName(basename(absPath, ext));
      result.files = [name];
      result.components.push({ type: "theme", via: "file-type", evidence: [name] });
    } else {
      result.error = `Unsupported file type: ${ext}. Expected .ts, .js, .md, or .json`;
      return result;
    }
  }

  // Check for name conflict
  result.targetDir = packageDir(result.name);
  if (existsSync(result.targetDir)) {
    result.error = `Package "${result.name}" already exists in the pool. Remove it first or use a different name.`;
    return result;
  }

  // Build steps
  result.valid = true;

  if (result.type === "single-file") {
    const comp = result.components[0];
    const subdir = comp.type === "extension" ? "extensions"
      : comp.type === "skill" ? "skills"
      : comp.type === "theme" ? "themes"
      : "prompts";

    result.steps = [
      `Create package: ~/.pi/packagemanager/packages/${result.name}/`,
      `  ├── package.json  (generated, pi.${subdir})`,
      `  └── ${subdir}/`,
      `      └── ${basename(absPath)}  (moved here)`,
      `Remove original: ${absPath}`,
      `Enable for this repo`,
    ];
  } else {
    result.steps = [
      `Move to: ~/.pi/packagemanager/packages/${result.name}/`,
    ];
    if (result.hasDependencies) {
      result.steps.push(`Run: npm install`);
    }
    result.steps.push(
      `Add .gitignore (node_modules/)`,
      `Remove original: ${absPath}`,
      `Enable for this repo`,
    );
  }

  return result;
}

// ============================================================================
// Execute onboard
// ============================================================================

export function executeOnboard(analysis: OnboardAnalysis, repoPath: string): void {
  if (!analysis.valid) throw new Error(analysis.error || "Invalid onboard analysis");

  mkdirSync(PACKAGES_DIR, { recursive: true });

  if (analysis.type === "single-file") {
    const comp = analysis.components[0];
    const subdir = comp.type === "extension" ? "extensions"
      : comp.type === "skill" ? "skills"
      : comp.type === "theme" ? "themes"
      : "prompts";

    // Create package directory with proper structure
    const pkgDir = analysis.targetDir;
    const resourceDir = join(pkgDir, subdir);
    mkdirSync(resourceDir, { recursive: true });

    // Copy the file
    cpSync(analysis.sourcePath, join(resourceDir, basename(analysis.sourcePath)));

    // Generate package.json
    const pkgJson: Record<string, unknown> = {
      name: analysis.name,
      version: "1.0.0",
      keywords: ["pi-package"],
      description: `Onboarded from ${analysis.sourcePath}`,
      pi: {
        [subdir]: [`./${subdir}`],
      },
    };
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    // Add .gitignore
    writeFileSync(join(pkgDir, ".gitignore"), "node_modules/\n");

    // Remove original
    rmSync(analysis.sourcePath);
  } else {
    // Move directory
    cpSync(analysis.sourcePath, analysis.targetDir, { recursive: true });
    rmSync(analysis.sourcePath, { recursive: true });

    // Ensure package.json has pi-package keyword if missing
    const pkgJsonPath = join(analysis.targetDir, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        if (!pkg.keywords?.includes("pi-package")) {
          pkg.keywords = pkg.keywords || [];
          pkg.keywords.push("pi-package");
          writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
        }
      } catch {}
    }

    // Ensure .gitignore has node_modules
    const gitignorePath = join(analysis.targetDir, ".gitignore");
    let gitignoreContent = "";
    try { gitignoreContent = readFileSync(gitignorePath, "utf-8"); } catch {}
    if (!gitignoreContent.includes("node_modules")) {
      gitignoreContent += (gitignoreContent && !gitignoreContent.endsWith("\n") ? "\n" : "") + "node_modules/\n";
      writeFileSync(gitignorePath, gitignoreContent);
    }

    // Install dependencies if needed
    if (analysis.hasDependencies) {
      installDependenciesIfNeeded(analysis.targetDir);
    }
  }

  // Register in registry
  addPackage({
    name: analysis.name,
    sourceType: "local",
    source: "local",
    onboardedFrom: analysis.sourcePath,
    installedAt: new Date().toISOString(),
  });

  // Enable for the repo
  enablePackage(repoPath, analysis.name);
  generatePackageJson(repoPath);
  ensurePackageInSettings(repoPath);

  // Update pool .gitignore if git-enabled
  ensureGitignore();
}

// ============================================================================
// Helpers
// ============================================================================

function sanitizeName(name: string): string {
  return name
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
