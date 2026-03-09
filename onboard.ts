import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, lstatSync, readdirSync } from "fs";
import { join, resolve, basename, dirname, extname } from "path";
import { PACKAGES_DIR } from "./constants.js";
import { addPackage, packageDir, installDependenciesIfNeeded } from "./registry.js";
import { enablePackage, ensurePackageInSettings, generatePackageJson } from "./store.js";
import { ensureGitignore } from "./git-pool.js";

// ============================================================================
// Types
// ============================================================================

export interface OnboardAnalysis {
  /** Source path (absolute) */
  sourcePath: string;
  /** Detected type */
  type: "single-file" | "directory" | "directory-with-package";
  /** Derived package name */
  name: string;
  /** Whether it has dependencies that need npm install */
  hasDependencies: boolean;
  /** Description of what will happen */
  steps: string[];
  /** Target directory */
  targetDir: string;
  /** Whether source is a valid extension/skill/prompt */
  valid: boolean;
  /** Error message if not valid */
  error?: string;
}

// ============================================================================
// Analysis — examine what we're onboarding
// ============================================================================

function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

export function analyzeOnboard(sourcePath: string, cwd: string): OnboardAnalysis {
  const absPath = resolve(cwd, sourcePath);
  const result: OnboardAnalysis = {
    sourcePath: absPath,
    type: "single-file",
    name: "",
    hasDependencies: false,
    steps: [],
    targetDir: "",
    valid: false,
  };

  if (!existsSync(absPath)) {
    result.error = `Path does not exist: ${absPath}`;
    return result;
  }

  if (isDir(absPath)) {
    // Directory — check for package.json
    const pkgJsonPath = join(absPath, "package.json");
    if (existsSync(pkgJsonPath)) {
      result.type = "directory-with-package";
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        result.name = sanitizeName(pkg.name || basename(absPath));
        result.hasDependencies = !!(pkg.dependencies && Object.keys(pkg.dependencies).length > 0);
      } catch {
        result.name = sanitizeName(basename(absPath));
      }
    } else {
      result.type = "directory";
      result.name = sanitizeName(basename(absPath));
    }

    // Validate: must contain at least one recognizable resource
    const hasExtension = existsSync(join(absPath, "extensions")) ||
      readdirSync(absPath).some(f => f.endsWith(".ts") || f.endsWith(".js"));
    const hasSkill = existsSync(join(absPath, "skills")) || existsSync(join(absPath, "SKILL.md"));
    const hasPrompt = existsSync(join(absPath, "prompts")) ||
      readdirSync(absPath).some(f => f.endsWith(".md") && f !== "README.md" && f !== "SKILL.md");
    const hasPiManifest = existsSync(pkgJsonPath) && (() => {
      try { return !!JSON.parse(readFileSync(pkgJsonPath, "utf-8")).pi; } catch { return false; }
    })();

    if (!hasExtension && !hasSkill && !hasPrompt && !hasPiManifest) {
      result.error = "Directory doesn't contain recognizable extensions, skills, or prompts";
      return result;
    }
  } else {
    // Single file
    const ext = extname(absPath);
    if (![".ts", ".js", ".md"].includes(ext)) {
      result.error = `Unsupported file type: ${ext}. Expected .ts, .js, or .md`;
      return result;
    }
    result.type = "single-file";
    result.name = sanitizeName(basename(absPath, ext));
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
    const ext = extname(absPath);
    const isExtension = ext === ".ts" || ext === ".js";
    const subdir = isExtension ? "extensions" : "prompts";

    result.steps = [
      `Create package: ~/.pi/packagemanager/packages/${result.name}/`,
      `  ├── package.json  (generated)`,
      `  └── ${subdir}/`,
      `      └── ${basename(absPath)}  (moved here)`,
      `Remove: ${absPath}`,
      `Enable "${result.name}" for this repo`,
      `Regenerate repo package → /reload to apply`,
    ];
  } else {
    result.steps = [
      `Move to: ~/.pi/packagemanager/packages/${result.name}/`,
    ];
    if (result.hasDependencies) {
      result.steps.push(`Run: npm install`);
    }
    result.steps.push(
      `Add: .gitignore (node_modules/)`,
      `Remove original: ${absPath}`,
      `Enable "${result.name}" for this repo`,
      `Regenerate repo package → /reload to apply`,
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
    const ext = extname(analysis.sourcePath);
    const isExtension = ext === ".ts" || ext === ".js";
    const subdir = isExtension ? "extensions" : "prompts";

    // Create package directory with proper structure
    const pkgDir = analysis.targetDir;
    const resourceDir = join(pkgDir, subdir);
    mkdirSync(resourceDir, { recursive: true });

    // Copy the file
    cpSync(analysis.sourcePath, join(resourceDir, basename(analysis.sourcePath)));

    // Generate package.json
    const pkgJson = {
      name: analysis.name,
      version: "1.0.0",
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
