// config.local.yaml (anvil) must index exactly what config.yaml (Monad testnet)
// indexes: one project, two chain sections. Everything above `chains:` is
// compared, apart from comments and the local-only `rollback_on_reorg`.
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

/** Everything before `chains:`, without comments, blank lines or local-only keys. */
function projectSection(yaml: string): string {
  return yaml
    .split("\nchains:\n")[0]!
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, ""))
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#") && !l.startsWith("rollback_on_reorg:"))
    .join("\n");
}

describe("config.local.yaml", () => {
  it("indexes the same contracts and events as config.yaml", (t) => {
    t.expect(projectSection(read("config.local.yaml"))).toBe(projectSection(read("config.yaml")));
  });

  it("reads anvil over RPC (HyperSync has no local chain)", (t) => {
    const local = read("config.local.yaml");
    t.expect(local).toMatch(/- id: 31337\b/);
    t.expect(local).toMatch(/url: http:\/\/127\.0\.0\.1:8612\n\s+for: sync/);
    // Addresses are checked against shared/deployments/31337.json at run time by
    // scripts/local-indexer.sh, since a redeploy on a live anvil changes them.
    t.expect(local.match(/address: "0x[0-9a-fA-F]{40}"/g)?.length).toBe(3);
  });
});
