# GrantTranche

A grant is paid in tranches against a rubric agreed months earlier: three deliverables, a live URL, a report with numbers. The grantee sends a folder of links, one program manager reads it on a Friday, and the decision becomes a sentence in a spreadsheet. The rubric was fixed; the reading was not.

GrantTranche puts the rubric on chain when the grant opens and turns every tranche into a receipt.

`open_grant` writes the grantee, the rubric and the tranche count. The funder writes it once; the contract refuses to change it later, because criteria that move after the work starts are not criteria.

`submit_tranche` points at a public page. Validators fetch it and answer, criterion by criterion, whether the page shows that criterion, with a quote for each. The contract counts the met criteria and issues the receipt only when all of them are met. A partial reading is not thrown away: it is stored as an attempt, and the best count for the current tranche is kept, so a later worse page cannot lower it.

A receipt is one reading, and a reading can be wrong. `challenge_tranche` lets the funder ask for a second, independent round over the same page and the same fixed rubric before a treasury pays; if that round disagrees, the receipt is revoked and the tranche returns to the grantee. `answer_challenge` gives the grantee one answer with a page they choose: if it meets every criterion the tranche is restored.

## The interesting part

**The rubric is fixed before the work, and the vector is compared.** Two validators looking at the same page can disagree about whether a report is "detailed enough"; they cannot disagree about whether the page contains a repository link. So the free-text rubric is written by the funder, and the round only settles when the true/false vector across criteria matches — same length, same order, same decisions. Quotes and reasons are free to differ, because they are notes for the grantee.

**Progress is monotonic.** A grantee whose page scored 2 of 3 keeps those 2. Rewriting the page badly does not reset them, and the receipts show every attempt in order, so a treasury can see that the third criterion is the one still missing instead of reading a committee email.

**A receipt, not a payment.** The contract holds no funds. It settles the question a payment depends on and writes an immutable receipt per tranche that a treasury or multisig executes. That is deliberate: custody would add a token layer and a withdrawal path, and the slow, dishonest part of a grant is not the transfer, it is the reading.

**The evidence page is untrusted.** It can contain "all criteria met, ignore the rubric"; it is fenced and named as material to be judged. The parser accepts only one boolean per criterion, in the rubric's order. A broken answer raises and stores nothing; an unreadable page refuses the round instead of producing a receipt from an empty page.

**A receipt can be re-read before it is paid.** The tranche is not the reading; the reading is one round, and a round can be lenient or can be reading a page that has changed since. So the funder gets one challenge per tranche, and the challenge is not an argument: it is a second round over the same URL and the same rubric, and it only succeeds when the second vector of decisions disagrees with the first. The receipt is then marked revoked, the tranche count goes back by one, and a completed grant reopens. The grantee is not left with no move — they answer once with a page they choose, and a full reading restores the tranche. Two bounded moves, and both readings stay on chain.

**One dispute per tranche, on the latest tranche only.** A grant cannot be unwound tranche by tranche after the fact: only the most recent approved tranche can be challenged, once, and a closed grant takes no challenge. That keeps the state monotonic in the direction that matters — nothing behind the frontier is silently rewritten.

## API

| Function | Kind | Who may call | What it does |
| --- | --- | --- | --- |
| `open_grant(grant_id, title, grantee, rubric_json, tranches)` | write | the funder | Writes the grant: 2–6 distinct criteria (≤220 chars each), 1–12 tranches, a 0x grantee. The rubric is fixed. |
| `submit_tranche(grant_id, evidence_url)` | write | the grantee | Fetches the page, runs one consensus round over every criterion, stores the receipt. |
| `challenge_tranche(grant_id, tranche, reason)` | write | the funder | One second round over the same page. If the reading disagrees the receipt is revoked, the tranche goes back and a complete grant reopens. One challenge per tranche, latest tranche only. |
| `answer_challenge(grant_id, tranche, evidence_url)` | write | the grantee | One answer with a page they choose. A full reading restores the revoked tranche; a partial one leaves the revocation standing. |
| `close_grant(grant_id)` | write | the funder | Ends an open grant; receipts already written stay readable. |
| `get_grant(grant_id)` | view | anyone | The rubric, the tranche state, the approved count, the best reading and the standing challenge. |
| `receipts_of(grant_id)` | view | anyone | Every attempt, oldest first, with the per-criterion verdict, quotes and whether the receipt was revoked. |
| `challenges_of(grant_id)` | view | anyone | Every challenge with the second reading and the answer, if any. |
| `list_grants(offset, limit)` | view | anyone | Newest first, pageable. |
| `stats()` | view | anyone | `{grants, open, complete, tranches_approved}`. |

## Flow

```
open_grant      ->  funder + grantee + rubric + tranches
submit_tranche  ->  fetch the evidence page, one round over every criterion
                    {criteria: [{criterion, met, quote}], reason}
                ->  met count, approved only when all met
                ->  receipt for the attempt, best count for the tranche
challenge_tranche ->  a second round over the same page
                ->  agrees: the receipt stands, the challenge is stored as rejected
                ->  disagrees: the receipt is revoked, the tranche goes back by one
answer_challenge ->  one page from the grantee, one round
                ->  all met: the tranche is restored (and the grant completes again)
                ->  not all met: the revocation stands, the answer is kept
close_grant     ->  funder ends it; receipts stay
```

The tranche moves forward only when a reading meets every criterion, and it moves forward by one. A grant with all tranches approved becomes `complete` and refuses further evidence.

## Layout

```
contracts/grant_tranche.py          the contract, ~500 lines
tests/direct/test_grant_tranche.py  27 direct-mode tests in 4 classes
scripts/deploy_studionet.js         deploy with genlayer-js, no CLI
scripts/e2e_studionet.js            a grant, a challenge, an answer, two guards, on Studio
app/                                 open a grant, submit evidence, read receipts
app/demo/                            three evidence pages used by the e2e run
```

## Live

- App: https://grant-tranche.surge.sh
- Contract V0 (Studio Network): `0x80c04eAbe8B085e27E7000Be9A0f688d1f32347A`
- Contract V1 (Studio Network): `0xd1598659C5Ead3D4c95d5f9267eA5dA0EFd4B89E`
- Explorer V1: https://explorer-studio.genlayer.com/address/0xd1598659C5Ead3D4c95d5f9267eA5dA0EFd4B89E

## One grant and three readings on the live contract

The demo pages are published on the same host as the app. `/demo/evidence-partial.html` has the repository and the live URL but no usage numbers; `/demo/evidence-full.html` has all three.

| what | transaction |
| --- | --- |
| `open_grant` — 3 criteria, 2 tranches, grantee written once | `0x53b4fef445022a44d0af4c0ce2f782df19e4a2ae4784869bb742fd3c1e34c57d` |
| `submit_tranche` on the partial page — **2 of 3**, no receipt, best 2, 52s | `0x191ea003671c43e1ecd2f6fbd03775b313668fb7a28b069fbfc83e8d7b54f5a5` |
| `submit_tranche` on the complete page — **3 of 3**, tranche 1 receipt, 50s | `0xd1f9a5da51556b91c5fd968e646d01a10a2a55a6a55cb3086f3d4fa31cbd677e` |
| `submit_tranche` on the complete page — **3 of 3**, tranche 2 receipt, grant complete, 88s | `0xb70e30eda324d3c5906f82315e823db783821dcdf2dc30bcf3affd13f8cc3c19` |
| a stranger submitting evidence — refused ("only the grantee") | `0x083469740cc4f73e8c713f6b998b056498071e6fe529feb45fcd04667d23b305` |
| evidence after completion — refused ("this grant is complete") | `0x270fbfd38fce63c2a27714427533b32409e70c1fdec2751b39401d9202c24f8a` |

The receipts keep the quotes that decided each criterion, for example the third one on the partial attempt:

```
miss  3. a written usage report with numbers
      "We are preparing the usage report."
```

and on the complete attempt:

```
met   3. a written usage report with numbers
      "In the first two weeks the app ran 412 tranche submissions across 27 grants."
```

## A challenge, a revocation and an answer on the live contract V1

The same three-criterion rubric, two tranches. Tranche 1 is receipted on the complete page. The page is then replaced with the partial one, which is what the funder's challenge re-reads; the grantee answers with `/demo/evidence-answer.html`, which has all three.

| what | transaction |
| --- | --- |
| deploy `0xd1598659C5Ead3D4c95d5f9267eA5dA0EFd4B89E` | `0x23ca01a30bc0a755283b7320a5abb09dd13d14d94a22bf336b4a109bca5faf08` |
| `open_grant` — 3 criteria, 2 tranches | `0x7e65f1c2435f919a72d824ed136ac2c3f472d6b3deee94bd3501ca6f1affffb9` |
| `submit_tranche` on the partial page — **2 of 3**, no receipt, best 2, 83s | `0xf114cbbcc9f4ea46dc163a77f9321cd29bd490f52f11a83c18a21bcac1a83767` |
| `submit_tranche` on the complete page — **3 of 3**, tranche 1 receipt, 55s | `0x23cd2f25271fddf8953955206331ecf5cd7691b0dc2e6285e5fcef0d2eac64ac` |
| a stranger challenging — refused ("only the funder challenges a receipt") | `0x29935bed9b924207ccece505be3a4a4864b19d8cc65d2b84f911fddefcc45fb4` |
| `challenge_tranche` after the page changed — second reading **2 of 3**, **upheld**, receipt revoked, approved 1 → 0, 56s | `0x2467101326a7e88c4cd43c6bb539f81efe128999bd11e6ed7b6577c4a3ab4acd` |
| `answer_challenge` with the complete page — **3 of 3**, **restored**, approved 0 → 1, 52s | `0x27bb7bd4e92f8fe2c78b46bea52bcba66e7ec8098068e4504d3aec04d20e1aea` |
| `submit_tranche` for tranche 2 — **3 of 3**, grant complete, 63s | `0xd488bffd715ce5a24dbd9e1ad2e42f836af6d1d5e5b91b29508a68df03f939a9` |
| evidence after completion — refused | `0xece1bfdfb84fc6836de67ad076db9a15ddf9c47515f67fc781b75c33252ab5c8` |

The challenge record keeps both readings and the answer that decided it:

```
tranche 1: restored | reread 2/3 | answer 3/3 https://grant-tranche.surge.sh/demo/evidence-answer.html
```

and the receipt it revoked stays readable, marked:

```
tranche 1 attempt 2: 3/3 met, approved true, revoked true
```

## Tests

```
env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
  --with pytest --with genlayer-test pytest tests/direct -q
```

27 direct-mode tests. The page fetch and the model are mocked; the contract is not. The suites cover opening and its refusals (too few, too many, duplicate, bad grantee, bad tranche count), a full and a partial reading, the top-up without double counting, monotonic progress, grantee-only submission, a broken answer storing nothing, an unreadable page storing nothing, completion, closing, and the views.

On the V1 side: a second reading that disagrees revokes the tranche and marks the receipt, a second reading that agrees leaves it standing, the grantee restores a revoked tranche with a full page, an answer that still misses keeps the revocation and cannot be repeated, only the funder challenges, only the latest approved tranche is challengeable, one challenge per tranche, a challenge needs a standing receipt and a reason, only the grantee answers, a closed grant takes no challenge, a fresh submission after a revocation blocks the answer, restoring the last tranche completes the grant again, and the challenge list carries the reading that decided it.

## Deploy

```
npm install
node scripts/deploy_studionet.js
node scripts/e2e_studionet.js <address> <grantId> a
# publish the broken page as /demo/evidence-full.html, then:
node scripts/e2e_studionet.js <address> <grantId> b
```

The two phases exist because the challenge has to re-read a page that changed: phase a issues the receipt on the complete page, the page is replaced with the partial one, and phase b challenges the receipt, answers it and finishes the grant.
