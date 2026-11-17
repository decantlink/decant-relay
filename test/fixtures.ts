type Fixtures = Record<string, unknown>;

const byName = (modules: Record<string, unknown>): Fixtures =>
  Object.fromEntries(Object.entries(modules).map(([file, body]) => [file.split("/").pop()!.replace(".json", ""), body]));

export const valid = byName(import.meta.glob("../schema/fixtures/valid/*.json", { eager: true, import: "default" }));
export const edge = byName(import.meta.glob("../schema/fixtures/edge/*.json", { eager: true, import: "default" }));
export const invalid = byName(import.meta.glob("../schema/fixtures/invalid/*.json", { eager: true, import: "default" }));
