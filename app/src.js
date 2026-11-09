import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const CONTRACT = "0x80c04eAbe8B085e27E7000Be9A0f688d1f32347A";
const EXPLORER = `https://explorer-studio.genlayer.com/address/${CONTRACT}`;
const KEY_SLOT = "granttranche.keys";
const DEMO = {
  rubric: [
    "a public code repository with the contract source",
    "a live application URL that calls the contract",
    "a written usage report with numbers",
  ],
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "");

let logTimer;
function log(msg) {
  const box = $("log");
  box.textContent = msg;
  box.style.display = "block";
  clearTimeout(logTimer);
  logTimer = setTimeout(() => (box.style.display = "none"), 9000);
}

function loadKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_SLOT) || "[]");
    return Array.isArray(raw) ? raw.filter((k) => typeof k === "string" && k) : [];
  } catch {
    return [];
  }
}

let keys = loadKeys();
if (!keys.length) {
  keys = [generatePrivateKey()];
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
}
let active = 0;
let account = createAccount(keys[0]);
let me = String(account.address).toLowerCase();
let client = createClient({ chain: studionet, account });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

function useKey(i) {
  active = i;
  account = createAccount(keys[i]);
  me = String(account.address).toLowerCase();
  client = createClient({ chain: studionet, account });
  paintKey();
  refresh();
}

function paintKey() {
  const sel = $("acting");
  sel.replaceChildren();
  keys.forEach((k, i) => {
    const o = el("option", "", `key ${i + 1} · ${short(String(createAccount(k).address))}`);
    o.value = String(i);
    sel.append(o);
  });
  sel.value = String(active);
  $("walletchip").textContent = `key ${active + 1} · ${short(me)}`;
  $("ggrantee").placeholder = me ? `${me.slice(0, 8)}… (my key)` : "0x…";
}

$("contractlink").textContent = short(CONTRACT);
$("contractlink").href = EXPLORER;

$("acting").onchange = (e) => useKey(Number(e.target.value) || 0);
$("genkey").onclick = () => {
  keys.push(generatePrivateKey());
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
  useKey(keys.length - 1);
  log("new key added — grantee can be this key");
};
$("importkey").onclick = () => {
  const k = prompt("Private key (0x…)");
  if (!k) return;
  keys.push(k.trim());
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
  useKey(keys.length - 1);
};
$("usemekey").onclick = () => {
  $("ggrantee").value = me;
  log("grantee set to the active key");
};
$("sample").onclick = () => {
  $("grubric").value = DEMO.rubric.join("\n");
  if (!$("gid").value) $("gid").value = `grant-${Date.now().toString(36)}`;
  $("gtitle").value = $("gtitle").value || "Docs tooling, two tranches";
  log("demo rubric loaded: two demo evidence pages are linked on the right");
};

async function read(functionName, args) {
  return reader.readContract({ address: CONTRACT, functionName, args });
}

async function send(functionName, args) {
  log(`${functionName}: signing`);
  const hash = await client.writeContract({ address: CONTRACT, functionName, args, value: 0n });
  log(`${functionName}: ${hash.slice(0, 12)}… waiting for the consensus round`);
  const receipt = await client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 });
  const leader = (receipt && receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  if (String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR") {
    throw new Error("the contract refused this call — check the log or the amount");
  }
  log(`${functionName}: done`);
  await refresh();
  return hash;
}

$("open").onclick = async () => {
  const id = $("gid").value.trim();
  const title = $("gtitle").value.trim();
  const grantee = $("ggrantee").value.trim() || me;
  const tranches = Number($("gtranches").value);
  const rubric = $("grubric").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!id || !title) return log("grant id and title are required");
  if (rubric.length < 2 || rubric.length > 6) return log("the rubric needs 2 to 6 criteria, one per line");
  try {
    await send("open_grant", [id, title, grantee, JSON.stringify(rubric), tranches]);
  } catch (e) {
    log(String((e && e.message) || e).slice(0, 160));
  }
};

function statusPill(status) {
  return el("span", `pill ${status}`, status);
}

function rubricLines(grant, latest) {
  const box = el("div", "");
  grant.rubric.forEach((text, index) => {
    const row = latest ? latest.verdict[index] : null;
    const cls = row ? (row.met ? "crit met" : "crit miss") : "crit";
    const line = el("div", cls);
    line.append(el("b", "", `${index + 1}. `));
    line.append(document.createTextNode(`${text}${row ? (row.met ? " — met" : " — not met") : ""}`));
    box.append(line);
    if (row && row.quote) box.append(el("div", "quote", `“${row.quote}”`));
  });
  return box;
}

async function receipts(card, grantId) {
  const box = el("div", "");
  card.append(box);
  try {
    const rows = await read("receipts_of", [grantId]);
    if (!rows.length) box.append(el("div", "kv", "no submissions yet"));
    for (const row of rows) {
      const line = el("div", "kv");
      line.append(
        document.createTextNode(
          `tranche ${row.tranche} · attempt ${row.seq} · ${row.met}/${row.total} met · ${row.approved ? "receipt issued" : "not approved"} · ${new Date(row.created_at * 1000).toLocaleString()}`
        )
      );
      box.append(line);
      if (row.reason) box.append(el("div", "quote", row.reason));
    }
  } catch (e) {
    box.append(el("div", "kv", String((e && e.message) || e).slice(0, 160)));
  }
}

function grantCard(grant, latest) {
  const card = el("div", "grant");
  const meta = el("div", "meta");
  meta.append(statusPill(grant.status));
  meta.append(el("span", "pill", `tranche ${grant.current_tranche} of ${grant.tranches}`));
  meta.append(el("span", "pill", `${grant.approved} approved`));
  if (grant.status === "open") meta.append(el("span", "pill", `best ${grant.best}/${grant.rubric.length}`));
  card.append(meta);
  card.append(el("h3", "", grant.title));
  card.append(el("div", "kv", `id ${grant.id} · funder ${short(grant.funder)} → grantee ${short(grant.grantee)}`));

  const bar = el("div", "bar");
  bar.style.setProperty("--n", String(grant.tranches));
  const fill = el("span");
  fill.style.width = `${Math.round((grant.approved / grant.tranches) * 100)}%`;
  bar.append(fill);
  card.append(bar);
  card.append(el("div", "kv", `${grant.approved} of ${grant.tranches} tranches have a receipt`));

  card.append(rubricLines(grant, latest));
  if (latest) {
    card.append(el("div", "kv", `last reading: ${latest.met}/${latest.total} met — ${latest.approved ? "the tranche was approved" : "the tranche stays open"}`));
  }

  const actions = el("div", "actions");
  const input = el("input");
  input.placeholder = "https://evidence.example.org/report";
  input.value = "https://grant-tranche.surge.sh/demo/evidence-full.html";
  input.style.maxWidth = "320px";
  actions.append(input);
  const submit = el("button", "primary", `Submit evidence for tranche ${grant.current_tranche}`);
  const isGrantee = me === grant.grantee;
  submit.disabled = grant.status !== "open" || !isGrantee;
  if (!isGrantee) submit.title = "only the grantee submits evidence";
  submit.onclick = async () => {
    const url = input.value.trim();
    if (!url) return log("an evidence URL is required");
    submit.disabled = true;
    try {
      await send("submit_tranche", [grant.id, url]);
    } catch (e) {
      log(String((e && e.message) || e).slice(0, 160));
    } finally {
      submit.disabled = false;
    }
  };
  actions.append(submit);
  const hist = el("button", "", "Receipts");
  hist.onclick = () => receipts(card, grant.id);
  actions.append(hist);
  if (grant.status === "open" && me === grant.funder) {
    const close = el("button", "", "Close grant");
    close.onclick = async () => {
      try {
        await send("close_grant", [grant.id]);
      } catch (e) {
        log(String((e && e.message) || e).slice(0, 160));
      }
    };
    actions.append(close);
  }
  card.append(actions);
  return card;
}

async function refresh() {
  try {
    const [stats, grants] = await Promise.all([read("stats", []), read("list_grants", [0, 30])]);
    $("s-grants").textContent = stats.grants;
    $("s-open").textContent = stats.open;
    $("s-complete").textContent = stats.complete;
    $("s-approved").textContent = stats.tranches_approved;
    const box = $("grants");
    box.replaceChildren();
    if (!grants.length) box.append(el("div", "kv", "no grants yet"));
    for (const grant of grants) {
      const rows = await read("receipts_of", [grant.id]);
      const latest = rows.filter((r) => r.tranche === grant.current_tranche).slice(-1)[0] || null;
      box.append(grantCard(grant, latest));
    }
  } catch (e) {
    setTimeout(refresh, 3000);
    if (!$("grants").childElementCount) {
      $("grants").replaceChildren(el("div", "kv", String((e && e.message) || e).slice(0, 180)));
    }
  }
}

refresh();
setInterval(refresh, 25000);
