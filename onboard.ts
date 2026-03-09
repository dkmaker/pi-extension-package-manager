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

export async function validatePackage(name: string): Promise<ValidationResult> {
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

  // 5. Validate skills (SKILL.md frontmatter, name matches folder)
  if (resources.skills.length > 0) {
    for (const skillPath of resources.skills) {
      const skillDir = existsSync(join(skillPath, "SKILL.md")) ? skillPath : null;
      if (!skillDir) continue;

      const folderName = skillDir.split("/").pop() || "";
      const skillMdPath = join(skillDir, "SKILL.md");
      let content: string;
      try {
        content = readFileSync(skillMdPath, "utf-8");
      } catch {
        result.valid = false;
        result.errors.push(`Cannot read ${shortPath(skillMdPath, dir)}`);
        continue;
      }

      // Parse frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        result.warnings.push(`Skill ${folderName}: missing frontmatter in SKILL.md`);
        continue;
      }

      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      const skillName = nameMatch ? nameMatch[1].trim() : null;
      const skillDesc = descMatch ? descMatch[1].trim() : null;

      // Name must match folder
      if (!skillName) {
        result.valid = false;
        result.errors.push(`Skill ${folderName}: missing "name" in frontmatter`);
      } else if (skillName !== folderName) {
        result.valid = false;
        result.errors.push(`Skill name mismatch: frontmatter name "${skillName}" ≠ folder name "${folderName}"`);
      } else {
        result.info.push(`✓ Skill "${skillName}" name matches folder`);
      }

      // Name format validation
      if (skillName) {
        if (skillName.length > 64) {
          result.warnings.push(`Skill "${skillName}": name exceeds 64 characters`);
        }
        if (/[^a-z0-9-]/.test(skillName)) {
          result.warnings.push(`Skill "${skillName}": name contains invalid characters (use lowercase alphanumeric and hyphens)`);
        }
        if (/^-|-$/.test(skillName)) {
          result.warnings.push(`Skill "${skillName}": name starts or ends with hyphen`);
        }
        if (/--/.test(skillName)) {
          result.warnings.push(`Skill "${skillName}": name has consecutive hyphens`);
        }
      }

      // Description is required (skills without it won't load)
      if (!skillDesc) {
        result.valid = false;
        result.errors.push(`Skill ${folderName}: missing "description" in frontmatter — skill will NOT load without it`);
      } else if (skillDesc.length > 1024) {
        result.warnings.push(`Skill "${skillName}": description exceeds 1024 characters`);
      } else {
        result.info.push(`✓ Skill "${skillName || folderName}": has description`);
      }
    }
  }

  // 6. Check dependencies and node_modules gitignore
  const nodeModulesDir = join(dir, "node_modules");
  if (pkg?.dependencies && Object.keys(pkg.dependencies).length > 0) {
    if (!existsSync(nodeModulesDir)) {
      result.valid = false;
      result.errors.push("Has dependencies but node_modules/ is missing — run npm install");
    } else {
      result.info.push(`Dependencies installed (${Object.keys(pkg.dependencies).length})`);
    }
  }

  if (existsSync(nodeModulesDir)) {
    const gitignorePath = join(dir, ".gitignore");
    let gitignoreContent = "";
    try { gitignoreContent = readFileSync(gitignorePath, "utf-8"); } catch {}
    if (!gitignoreContent.includes("node_modules")) {
      result.valid = false;
      result.errors.push("node_modules/ exists but is not in .gitignore — must be gitignored");
    } else {
      result.info.push("✓ node_modules/ is gitignored");
    }
  }

  // 7. Try jiti load for extensions (syntax/import check only)
  if (resources.extensions.length > 0) {
    try {
      const { createJiti } = await import("@mariozechner/jiti");
      const jiti = (createJiti as any)(import.meta.url);
      for (const ext of resources.extensions) {
        try {
          // Load via jiti to check syntax and imports resolve
          // This validates TypeScript compiles and dependencies are found
          jiti(ext);
          result.info.push(`✓ jiti load OK: ${shortPath(ext, dir)}`);
        } catch (e: any) {
          const msg = e.message?.split("\n")[0] || String(e);
          result.valid = false;
          result.errors.push(`jiti load failed for ${shortPath(ext, dir)}: ${msg}`);
        }
      }
    } catch {
      result.warnings.push("Could not load jiti — skipping extension load check");
    }
  }

  // 8. Check it's registered
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
