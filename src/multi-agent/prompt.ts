// Mustache-lite template for participant system prompts.
//
// Supports {{path.to.value}} where the path resolves through nested objects
// and arrays. Missing paths render as empty string (and warn on stderr).

export function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_, expr: string) => {
    const path = expr.trim();
    const value = resolvePath(ctx, path);
    if (value === undefined) {
      process.stderr.write(`[template] missing key: ${path}\n`);
      return "";
    }
    if (value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  });
}

function resolvePath(ctx: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = ctx;
  for (const part of parts) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}
