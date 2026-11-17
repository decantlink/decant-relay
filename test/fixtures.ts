type Fixtures = Record<string, unknown>;

// Raw text, parsed here: Vite's own JSON loader rejects the unpaired-surrogate fixture.
const byName = (modules: Record<string, unknown>): Fixtures =>
  Object.fromEntries(
    Object.entries(modules).map(([file, text]) => [file.split("/").pop()!.replace(".json", ""), JSON.parse(text as string)]),
  );

export const valid = byName(import.meta.glob("../schema/fixtures/valid/*.json", { eager: true, query: "?raw", import: "default" }));
export const edge = byName(import.meta.glob("../schema/fixtures/edge/*.json", { eager: true, query: "?raw", import: "default" }));
export const invalid = byName(import.meta.glob("../schema/fixtures/invalid/*.json", { eager: true, query: "?raw", import: "default" }));
