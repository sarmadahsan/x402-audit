/**
 * Keyword categorizer. The table lives in config/categories.yaml so every assignment is
 * auditable: resources.category_reason records which source and keyword decided it.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CATEGORIES = ["inference", "data", "scraping", "compute", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

const CategoryEnum = z.enum(CATEGORIES);
const RulesSchema = z.object({
  order: z.array(CategoryEnum).min(1),
  fallback: CategoryEnum.default("other"),
  categories: z.partialRecord(CategoryEnum, z.array(z.string().min(1))),
});
export type CategoryRules = z.infer<typeof RulesSchema>;

export const DEFAULT_CATEGORIES_PATH = new URL("../../config/categories.yaml", import.meta.url);

export function loadCategoryRules(path: string | URL = DEFAULT_CATEGORIES_PATH): CategoryRules {
  return RulesSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

let cached: CategoryRules | undefined;
function defaultRules(): CategoryRules {
  cached ??= loadCategoryRules();
  return cached;
}

export interface CategorizeInput {
  tags?: readonly string[] | undefined;
  serviceName?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
}
export interface CategoryResult {
  category: Category;
  /** "tag:llm" | "name:scraper" | "desc:weather" | "url:/scrape" | "none" */
  reason: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const regexCache = new Map<string, RegExp>();
function keywordRegex(kw: string): RegExp {
  let re = regexCache.get(kw);
  if (!re) {
    const body = kw
      .toLowerCase()
      .split(/[-_\s]+/)
      .map(escape)
      .join("[-_\\s]");
    re = new RegExp(`(?:^|[^a-z0-9])${body}(?:s|es)?(?:$|[^a-z0-9])`);
    regexCache.set(kw, re);
  }
  return re;
}

function urlPath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    return undefined;
  }
}

export function categorize(input: CategorizeInput, rules: CategoryRules = defaultRules()): CategoryResult {
  const tags = (input.tags ?? []).map((t) => t.toLowerCase());
  const name = input.serviceName?.toLowerCase();
  const desc = input.description?.toLowerCase();
  const path = urlPath(input.url);
  for (const cat of rules.order) {
    const kws = rules.categories[cat] ?? [];
    for (const kw of kws) if (tags.some((t) => keywordRegex(kw).test(t))) return { category: cat, reason: `tag:${kw}` };
    if (name) for (const kw of kws) if (keywordRegex(kw).test(name)) return { category: cat, reason: `name:${kw}` };
    if (desc) for (const kw of kws) if (keywordRegex(kw).test(desc)) return { category: cat, reason: `desc:${kw}` };
    if (path) for (const kw of kws) if (keywordRegex(kw).test(path)) return { category: cat, reason: `url:/${kw}` };
  }
  return { category: rules.fallback, reason: "none" };
}
