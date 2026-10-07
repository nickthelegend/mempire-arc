// One project, three chain sections: config.yaml (Arc testnet),
// config.mainnet.yaml (Arc mainnet) and config.local.yaml (the arc-anvil fork)
// must index exactly the same contracts and events. Everything above `chains:`
// is compared, apart from comments and the local-only `rollback_on_reorg`.
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

/** The single `- id: N` under `chains:`. */
const chainIds = (yaml: string) => [...yaml.matchAll(/^\s+- id: (\d+)\b/gm)].map((m) => Number(m[1]));

describe("configs", () => {
  it("config.local.yaml and config.mainnet.yaml index the same contracts and events as config.yaml", (t) => {
    const testnet = projectSection(read("config.yaml"));
    t.expect(projectSection(read("config.local.yaml"))).toBe(testnet);
    t.expect(projectSection(read("config.mainnet.yaml"))).toBe(testnet);
  });

  it("config.yaml is Arc testnet and config.mainnet.yaml is Arc mainnet, both on HyperSync (no rpc)", (t) => {
    const testnet = read("config.yaml");
    const mainnet = read("config.mainnet.yaml");
    t.expect(chainIds(testnet)).toEqual([5042002]);
    t.expect(chainIds(mainnet)).toEqual([5042]);
    for (const yaml of [testnet, mainnet]) {
      t.expect(yaml).not.toMatch(/^\s+rpc:/m);
      t.expect(yaml.match(/address: "0x[0-9a-fA-F]{40}"/g)?.length).toBe(4);
    }
  });

  it("config.local.yaml reads the arc-anvil fork over RPC (HyperSync has no local chain)", (t) => {
    const local = read("config.local.yaml");
    t.expect(chainIds(local)).toEqual([31337]);
    t.expect(local).toMatch(/url: http:\/\/127\.0\.0\.1:8710\n\s+for: sync/);
    // Addresses are checked against shared/deployments/31337.json at run time by
    // scripts/local-indexer.sh, since a redeploy on a live fork changes them.
    t.expect(local.match(/address: "0x[0-9a-fA-F]{40}"/g)?.length).toBe(4);
  });

  it("indexes the Chainlink-era events (feeds, CCIP gateway, arena limits) and nothing oracle- or Monad-era", (t) => {
    const testnet = read("config.yaml");
    for (const e of [
      "LimitsChanged",
      "EntryGatewayChanged",
      "CoinFeedChanged",
      "CardsChanged",
      "Entered",
      "CashedOut",
      "MessageFailed",
      "MessageRecovered",
      "RemoteEntrySet",
    ]) {
      t.expect(testnet).toContain(`- event: ${e}`);
    }
    t.expect(testnet).toContain("- name: MempireCCIPGateway");
    t.expect(testnet).not.toMatch(/OracleChanged|PythChanged|Monad|MON\b|AUSD/);
  });

  it("every config event exists in its ABI", (t) => {
    const testnet = read("config.yaml");
    const blocks = testnet.split("\nchains:\n")[0]!.split(/\n  - name: /).slice(1);
    t.expect(blocks.length).toBe(4);
    for (const block of blocks) {
      const name = block.split("\n")[0]!.trim();
      const abi = JSON.parse(read(`abis/${name}.json`)) as { type: string; name?: string }[];
      const events = new Set(abi.filter((x) => x.type === "event").map((x) => x.name));
      for (const m of block.matchAll(/- event: (\w+)/g)) t.expect(events.has(m[1]), `${name}.${m[1]}`).toBe(true);
    }
  });
});
