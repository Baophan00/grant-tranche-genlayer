#!/usr/bin/env node
/**
 * End to end run of GrantTranche on GenLayer Studio Network, in two phases so the
 * evidence page can change between the receipt and the challenge.
 *
 *   node scripts/e2e_studionet.js <contractAddress> <grantId> a
 *   (flip app/demo/evidence-full.html to the broken page and redeploy the demo)
 *   node scripts/e2e_studionet.js <contractAddress> <grantId> b
 *
 * Phase a: one grant, a partial page that issues no receipt, then a complete page
 * that issues tranche 1. Phase b: the funder challenges that receipt, the second
 * reading of the same URL now misses a criterion, the tranche is revoked, the
 * grantee answers with a new page and the tranche is restored, then tranche 2
 * completes the grant. Both guards are checked.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
const GRANT_ID = process.argv[3];
const PHASE = (process.argv[4] || "a").toLowerCase();
if (!ADDRESS || !GRANT_ID) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress> <grantId> [a|b]");
  process.exit(1);
}

const KEYFILE = process.env.GT_KEYS || path.join("/tmp", "grant-tranche-keys.json");
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
const ANSWER = `${BASE}/evidence-answer.html`;
const RUBRIC = [
  "a public code repository with the contract source",
  "a live application URL that calls the contract",
  "a written usage report with numbers",
];

(async () => {
  const grantId = GRANT_ID;
  const grantee = createAccount(k.grantee).address;
  console.log("contract", ADDRESS);
  console.log("grant   ", grantId);
  console.log("phase   ", PHASE);
  console.log("grantee ", grantee);

  if (PHASE === "a") {
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

    console.log("\nPHASE A DONE: tranche 1 has a receipt. Flip the evidence page, then run phase b.");
    return;
  }

  let grant = await read("get_grant", [grantId]);
  console.log(`\n  before the challenge: approved ${grant.approved}/${grant.tranches} | best ${grant.best} | status ${grant.status}`);
  if (grant.approved !== 1) throw new Error(`phase a left approved at ${grant.approved}`);

  console.log("\n[guard] a stranger cannot challenge a receipt");
  const stranger = await send("stranger", "challenge_tranche", [grantId, 1, "not my grant"]);
  if (!stranger.refused) throw new Error("a stranger challenged a receipt");

  console.log("\n[funder] challenge tranche 1: the page no longer shows the live URL");
  let t0 = Date.now();
  await write("funder", "challenge_tranche", [grantId, 1, "the page no longer shows the live app"]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  grant = await read("get_grant", [grantId]);
  console.log(`  approved ${grant.approved} | best ${grant.best} | status ${grant.status} | challenge ${grant.challenge.state}`);
  if (grant.approved !== 0 || grant.challenge.state !== "upheld") {
    throw new Error(`the challenge was ${grant.challenge.state}, approved ${grant.approved}`);
  }
  const revoked = (await read("receipts_of", [grantId])).filter((r) => r.revoked);
  if (revoked.length !== 1) throw new Error(`expected one revoked receipt, found ${revoked.length}`);

  console.log("\n[grantee] answer the revocation with a page that meets every criterion");
  t0 = Date.now();
  await write("grantee", "answer_challenge", [grantId, 1, ANSWER]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  grant = await read("get_grant", [grantId]);
  console.log(`  approved ${grant.approved} | best ${grant.best} | challenge ${grant.challenge.state}`);
  if (grant.approved !== 1 || grant.challenge.state !== "restored") {
    throw new Error(`the answer did not restore the tranche (approved ${grant.approved}, ${grant.challenge.state})`);
  }

  console.log("\n[grantee] submit the answered page for tranche 2");
  t0 = Date.now();
  await write("grantee", "submit_tranche", [grantId, ANSWER]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);
  grant = await read("get_grant", [grantId]);
  console.log(`  approved ${grant.approved}/${grant.tranches} | status ${grant.status}`);
  if (grant.status !== "complete" || grant.approved !== 2) {
    throw new Error(`the grant did not complete (status ${grant.status}, approved ${grant.approved})`);
  }

  console.log("\n[guard] a complete grant takes no more evidence");
  const late = await send("grantee", "submit_tranche", [grantId, ANSWER]);
  if (!late.refused) throw new Error("a complete grant accepted another tranche");

  console.log("\nchallenges");
  for (const row of await read("challenges_of", [grantId])) {
    console.log(`  tranche ${row.tranche}: ${row.state} | reread ${row.reread_met}/${row.reread_total} | answer ${row.answer_met}/${row.answer_total} ${row.answer_url}`);
  }

  console.log("\nreceipts");
  for (const row of await read("receipts_of", [grantId])) {
    console.log(`  tranche ${row.tranche} attempt ${row.seq}: ${row.met}/${row.total} met, approved ${row.approved}, revoked ${row.revoked}`);
    for (const criterion of row.verdict) {
      console.log(`    ${criterion.met ? "met " : "miss"} ${criterion.criterion}. ${criterion.text.slice(0, 46)}${criterion.quote ? ` | "${criterion.quote.slice(0, 60)}"` : ""}`);
    }
  }

  console.log("\nstats");
  console.log(JSON.stringify(await read("stats", []), null, 2));

  console.log(
    "\nRESULT: a receipt, a second reading that disagreed and revoked it, an answer that restored the tranche, a completed grant, and both guards refused"
  );
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.cause) console.error(String(e.cause).slice(0, 900));
  process.exit(1);
});
