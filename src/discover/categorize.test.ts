import { describe, expect, it } from "vitest";
import { categorize, loadCategoryRules } from "./categorize.js";

const rules = loadCategoryRules();

describe("categorize", () => {
  const cases: [string, Parameters<typeof categorize>[0], string, string][] = [
    ["llm tag", { tags: ["ai", "inference", "llm", "gateway"], url: "https://blockrun.ai/api/v1/chat/completions" }, "inference", "tag:llm"],
    ["chat path only", { url: "https://x.com/v1/chat/completions" }, "inference", "url:/chat"],
    ["weather in description", { description: "Current weather for any city" }, "data", "desc:weather"],
    ["scrape path", { url: "https://s.dev/api/scrape?u=1" }, "scraping", "url:/scrape"],
    ["crawling tag beats token tag (scraping > data)", { tags: ["automation", "crawling", "token"] }, "scraping", "tag:crawling"],
    ["screenshot via service name", { serviceName: "Screenshot API" }, "scraping", "name:screenshot"],
    ["gpu compute", { description: "Rent a GPU for a minute" }, "compute", "desc:gpu"],
    ["sandbox path", { url: "https://run.dev/sandbox/session" }, "compute", "url:/sandbox"],
    ["verdict tag", { tags: ["agents", "token", "verdict"] }, "data", "tag:token"],
    ["plural price tag", { tags: ["crypto", "prices"] }, "data", "tag:price"],
    ["hyphenated keyword", { tags: ["image_gen"] }, "inference", "tag:image-gen"],
    ["no match", { tags: ["ping"], description: "Health check", url: "https://a.com/x402/ping" }, "other", "none"],
    ["word boundary: 'chatter' is not chat", { description: "chatter box" }, "other", "none"],
    ["host is ignored for url rules", { url: "https://scrape.example.com/v1/thing" }, "other", "none"],
    ["inference wins over data", { tags: ["search"], description: "Create embeddings for search" }, "inference", "desc:embedding"],
    ["generic generate is not inference", { description: "Generate a random UUID v4" }, "other", "none"],
  ];
  for (const [name, input, cat, reason] of cases) {
    it(name, () => expect(categorize(input, rules)).toEqual({ category: cat, reason }));
  }
});
