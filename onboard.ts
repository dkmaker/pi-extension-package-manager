import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, extname } from "path";
import { PACKAGES_DIR } from "./constants.js";
import { packageDir, listPackages } from "./registry.js";
import { resolvePackageResources } from "./store.js";

// ============================================================================
// Validate a package in the pool
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  name: string;
  errors: string[];
  warnings: string[];
  info: string[];
}

export function validatePackage(name: string): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    name,
    errors: [],
    warnings: [],
    info: [],
  };

  const dir = packageDir(name);

  // 1. Check package exists in pool
  if (!existsSync(dir)) {
    result.valid = false;
    result.errors.push(`Package directory not found: ${dir}`);
    return result;
  }

  // 2. Check package.json
  const pkgJsonPath = join(dir, "package.json");
  let pkg: any = null;
  if (existsSync(pkgJsonPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      result.info.push(`package.json: ${pkg.name || "(no name)"} v${pkg.version || "?"}`);

      if (pkg.keywords?.includes("pi-package")) {
        result.info.push("✓ has pi-package keyword");
      } else {
        result.warnings.push("Missing pi-package keyword in package.json");
      }

      if (pkg.description) {
        result.info.push(`Description: ${pkg.description}`);
      }
    } catch (e: any) {
      result.valid = false;
      result.errors.push(`Invalid package.json: ${e.message}`);
    }
  } else {
    result.warnings.push("No package.json found");
  }

  // 3. Check pi manifest or convention directories
  const hasPiManifest = pkg?.pi && typeof pkg.pi === "object";
  const hasConventionDirs =
    existsSync(join(dir, "extensions")) ||
    existsSync(join(dir, "skills")) ||
    existsSync(join(dir, "prompts")) ||
    existsSync(join(dir, "themes"));

  if (hasPiManifest) {
    result.info.push(`pi manifest: ${Object.keys(pkg.pi).join(", ")}`);
  } else if (!hasConventionDirs) {
    // Check for root-level files that could be extensions
    const rootFiles = readdirSync(dir).filter(f => {
      try { return statSync(join(dir, f)).isFile(); } catch { return false; }
    });
    const hasCode = rootFiles.some(f => f.endsWith(".ts") || f.endsWith(".js"));
    const hasSkill = existsSync(join(dir, "SKILL.md"));
    const hasMd = rootFiles.some(f => f.endsWith(".md") && f !== "README.md" && f !== "SKILL.md");

    if (!hasCode && !hasSkill && !hasMd) {
      result.warnings.push("No pi manifest, convention directories, or recognizable pi resources found");
    }
  }

  // 4. Resolve resources and validate paths
  const resources = resolvePackageResources(name);
  const totalResources =
    resources.extensions.length +
    resources.skills.length +
    resources.prompts.length +
    resources.themes.length;

  if (totalResources === 0) {
    result.warnings.push("No resources resolved — package may be empty or misconfigured");
  } else {
    if (resources.extensions.length) result.info.push(`Extensions (${resources.extensions.length}): ${resources.extensions.map(p => shortPath(p, dir)).join(", ")}`);
    if (resources.skills.length) result.info.push(`Skills (${resources.skills.length}): ${resources.skills.map(p => shortPath(p, dir)).join(", ")}`);
    if (resources.prompts.length) result.info.push(`Prompts (${resources.prompts.length}): ${resources.prompts.map(p => shortPath(p, dir)).join(", ")}`);
    if (resources.themes.length) result.info.push(`Themes (${resources.themes.length}): ${resources.themes.map(p => shortPath(p, dir)).join(", ")}`);

    // Verify each resolved path actually exists
    for (const p of [...resources.extensions, ...resources.skills, ...resources.prompts, ...resources.themes]) {
      if (!existsSync(p)) {
        result.valid = false;
        result.errors.push(`Resolved path does not exist: ${shortPath(p, dir)}`);
      }
    }
  }

  // 5. Check dependencies
  if (pkg?.dependencies && Object.keys(pkg.dependencies).length > 0) {
    const nodeModules = join(dir, "node_modules");
    if (!existsSync(nodeModules)) {
      result.valid = false;
      result.errors.push("Has dependencies but node_modules/ is missing — run npm install");
    } else {
      result.info.push(`Dependencies installed (${Object.keys(pkg.dependencies).length})`);
    }
  }

  // 6. Try jiti load for extensions
  if (resources.extensions.length > 0) {
    for (const ext of resources.extensions) {
      try {
        const { createJiti } = require("@mariozechner/jiti") as any;
        const jiti = createJiti(ext);
        jiti(ext);
        result.info.push(`✓ jiti load OK: ${shortPath(ext, dir)}`);
      } catch (e: any) {
        result.valid = false;
        result.errors.push(`jiti load failed for ${shortPath(ext, dir)}: ${e.message}`);
      }
    }
  }

  // 7. Check it's registered
  const allPkgs = listPackages();
  const registered = allPkgs.find(p => p.name === name);
  if (!registered) {
    result.warnings.push("Package exists in pool directory but is not registered in registry.json");
  } else {
    result.info.push(`Registered as: ${registered.sourceType} (${registered.source})`);
  }

  return result;
}

function shortPath(p: string, base: string): string {
  if (p.startsWith(base)) return p.slice(base.length + 1);
  return p;
}
