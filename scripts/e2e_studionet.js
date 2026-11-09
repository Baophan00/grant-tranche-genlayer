#!/usr/bin/env node
/**
 * End to end run of GrantTranche on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress>
 *
 * One real grant: a funder writes a three-criterion rubric and two tranches, the
 * grantee submits a page that meets two criteria, then a page that meets all
 * three, then repeats it for the second tranche. A stranger cannot submit, and
 * a complete grant takes no more evidence.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}

const KEYFILE = process.env.GT_KEYS || path.join("/tmp", `grant-tranche-keys-${Date.now().toString(36)}.json`);
function keys() {
  if (fs.existsSync(KEYFILE)) return JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const k = { funder: generatePrivateKey(), grantee: generatePrivateKey(), stranger: generatePrivateKey() };
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}
const k = keys();
const clients = {};
for (const role of ["funder", "grantee", "stranger"]) {
  clients[role] = createClient({ chain: studionet, account: createAccount(k[role]) });
}
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i.test(msg)) throw e;
      console.log(`  ${label}: rpc hiccup, retry ${i + 1}`);
      await sleep(4000);
    }
  }
  throw last;
}

function refused(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function send(role, functionName, args) {
  console.log(`\n[${role}] ${functionName}(${args.map((a) => JSON.stringify(a).slice(0, 70)).join(", ")})`);
  const hash = await withRetry(
    () => clients[role].writeContract({ address: ADDRESS, functionName, args, value: 0n }),
    "send"
  );
  console.log(`  tx ${hash}`);
  const receipt = await withRetry(
    () => clients[role].waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 }),
    "receipt"
  );
  console.log(`  ${receipt.status_name || receipt.status}  (${refused(receipt) ? "refused by the contract" : "executed"})`);
  return { hash, refused: refused(receipt) };
}

async function write(role, functionName, args) {
  const { hash, refused: reverted } = await send(role, functionName, args);
  if (reverted) throw new Error(`${functionName} failed inside the contract`);
  return hash;
}

const read = (functionName, args) =>
  withRetry(() => reader.readContract({ address: ADDRESS, functionName, args }), "read");

const BASE = "https://grant-tranche.surge.sh/demo";
const PARTIAL = `${BASE}/evidence-partial.html`;
const FULL = `${BASE}/evidence-full.html`;
const RUBRIC = [
  "a public code repository with the contract source",
  "a live application URL that calls the contract",
  "a written usage report with numbers",
];

(async () => {
  const grantId = process.argv[3] || `grant-${Date.now().toString(36)}`;
  const grantee = createAccount(k.grantee).address;
  console.log("contract", ADDRESS);
  console.log("grant   ", grantId);
  console.log("grantee ", grantee);

  await write("funder", "open_grant", [grantId, "Docs tooling, two tranches", grantee, JSON.stringify(RUBRIC), 2]);

  let grant = await read("get_grant", [grantId]);
  console.log(`\n  opened with ${grant.rubric.length} criteria and ${grant.tranches} tranches | current tranche ${grant.current_tranche}`);

  console.log("\n[grantee] submit a page that meets two of the three criteria");
  let t0 = Date.now();
  await write("grantee", "submit_tranche", [grantId, PARTIAL]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  grant = await read("get_grant", [grantId]);
  console.log(`  best ${grant.best}/${grant.rubric.length} | approved ${grant.approved} | status ${grant.status}`);
  if (grant.approved !== 0 || grant.best !== 2) {
    throw new Error(`the partial page was read as best ${grant.best}, approved ${grant.approved}`);
  }

  console.log("\n[grantee] submit the complete page");
  t0 = Date.now();
  await write("grantee", "submit_tranche", [grantId, FULL]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  grant = await read("get_grant", [grantId]);
  console.log(`  approved ${grant.approved}/${grant.tranches} | current tranche ${grant.current_tranche} | status ${grant.status}`);
  if (grant.approved !== 1) throw new Error(`the complete page did not issue the receipt (approved ${grant.approved})`);

  console.log("\n[grantee] the same complete page for tranche 2");
  t0 = Date.now();
  await write("grantee", "submit_tranche", [grantId, FULL]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  grant = await read("get_grant", [grantId]);
  console.log(`  approved ${grant.approved}/${grant.tranches} | status ${grant.status}`);
  if (grant.status !== "complete" || grant.approved !== 2) {
    throw new Error(`the grant did not complete (status ${grant.status}, approved ${grant.approved})`);
  }

  console.log("\n[guard] a stranger cannot submit evidence");
  const stranger = await send("stranger", "submit_tranche", [grantId, FULL]);
  if (!stranger.refused) throw new Error("a stranger submitted evidence");

  console.log("\n[guard] a complete grant takes no more evidence");
  const late = await send("grantee", "submit_tranche", [grantId, FULL]);
  if (!late.refused) throw new Error("a complete grant accepted another tranche");

  console.log("\nreceipts");
  for (const row of await read("receipts_of", [grantId])) {
    console.log(`  tranche ${row.tranche} attempt ${row.seq}: ${row.met}/${row.total} met, approved ${row.approved}`);
    for (const criterion of row.verdict) {
      console.log(`    ${criterion.met ? "met " : "miss"} ${criterion.criterion}. ${criterion.text.slice(0, 46)}${criterion.quote ? ` | "${criterion.quote.slice(0, 60)}"` : ""}`);
    }
  }

  console.log("\nstats");
  console.log(JSON.stringify(await read("stats", []), null, 2));

  console.log(
    "\nRESULT: a fixed rubric, a partial reading that did not issue a receipt, a complete reading that did, a second tranche, and both guards refused"
  );
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.cause) console.error(String(e.cause).slice(0, 900));
  process.exit(1);
});
