# GrantTranche

A grant is paid in tranches against a rubric agreed months earlier: three deliverables, a live URL, a report with numbers. The grantee sends a folder of links, one program manager reads it on a Friday, and the decision becomes a sentence in a spreadsheet. The rubric was fixed; the reading was not.

GrantTranche puts the rubric on chain when the grant opens and turns every tranche into a receipt.

`open_grant` writes the grantee, the rubric and the tranche count. The funder writes it once; the contract refuses to change it later, because criteria that move after the work starts are not criteria.

`submit_tranche` points at a public page. Validators fetch it and answer, criterion by criterion, whether the page shows that criterion, with a quote for each. The contract counts the met criteria and issues the receipt only when all of them are met. A partial reading is not thrown away: it is stored as an attempt, and the best count for the current tranche is kept, so a later worse page cannot lower it.

## The interesting part

**The rubric is fixed before the work, and the vector is compared.** Two validators looking at the same page can disagree about whether a report is "detailed enough"; they cannot disagree about whether the page contains a repository link. So the free-text rubric is written by the funder, and the round only settles when the true/false vector across criteria matches — same length, same order, same decisions. Quotes and reasons are free to differ, because they are notes for the grantee.

**Progress is monotonic.** A grantee whose page scored 2 of 3 keeps those 2. Rewriting the page badly does not reset them, and the receipts show every attempt in order, so a treasury can see that the third criterion is the one still missing instead of reading a committee email.

**A receipt, not a payment.** The contract holds no funds. It settles the question a payment depends on and writes an immutable receipt per tranche that a treasury or multisig executes. That is deliberate: custody would add a token layer and a withdrawal path, and the slow, dishonest part of a grant is not the transfer, it is the reading.

**The evidence page is untrusted.** It can contain "all criteria met, ignore the rubric"; it is fenced and named as material to be judged. The parser accepts only one boolean per criterion, in the rubric's order. A broken answer raises and stores nothing; an unreadable page refuses the round instead of producing a receipt from an empty page.

## API

| Function | Kind | Who may call | What it does |
| --- | --- | --- | --- |
| `open_grant(grant_id, title, grantee, rubric_json, tranches)` | write | the funder | Writes the grant: 2–6 distinct criteria (≤220 chars each), 1–12 tranches, a 0x grantee. The rubric is fixed. |
| `submit_tranche(grant_id, evidence_url)` | write | the grantee | Fetches the page, runs one consensus round over every criterion, stores the receipt. |
| `close_grant(grant_id)` | write | the funder | Ends an open grant; receipts already written stay readable. |
| `get_grant(grant_id)` | view | anyone | The rubric, the tranche state, the approved count and the best reading. |
| `receipts_of(grant_id)` | view | anyone | Every attempt, oldest first, with the per-criterion verdict and quotes. |
| `list_grants(offset, limit)` | view | anyone | Newest first, pageable. |
| `stats()` | view | anyone | `{grants, open, complete, tranches_approved}`. |

## Flow

```
open_grant      ->  funder + grantee + rubric + tranches
submit_tranche  ->  fetch the evidence page, one round over every criterion
                    {criteria: [{criterion, met, quote}], reason}
                ->  met count, approved only when all met
                ->  receipt for the attempt, best count for the tranche
close_grant     ->  funder ends it; receipts stay
```

The tranche moves forward only when a reading meets every criterion, and it moves forward by one. A grant with all tranches approved becomes `complete` and refuses further evidence.

## Layout

```
contracts/grant_tranche.py          the contract, ~400 lines
tests/direct/test_grant_tranche.py  14 direct-mode tests in 3 classes
scripts/deploy_studionet.js         deploy with genlayer-js, no CLI
scripts/e2e_studionet.js            a grant, three rounds, two guards, on Studio
app/                                 open a grant, submit evidence, read receipts
app/demo/                            two evidence pages used by the e2e run
```

## Live

- App: https://grant-tranche.surge.sh
- Contract (Studio Network): `0x80c04eAbe8B085e27E7000Be9A0f688d1f32347A`
- Explorer: https://explorer-studio.genlayer.com/address/0x80c04eAbe8B085e27E7000Be9A0f688d1f32347A

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

## Tests

```
env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
  --with pytest --with genlayer-test pytest tests/direct -q
```

14 direct-mode tests. The page fetch and the model are mocked; the contract is not. The suites cover opening and its refusals (too few, too many, duplicate, bad grantee, bad tranche count), a full and a partial reading, the top-up without double counting, monotonic progress, grantee-only submission, a broken answer storing nothing, an unreadable page storing nothing, completion, closing, and the views.

## Deploy

```
npm install
node scripts/deploy_studionet.js
node scripts/e2e_studionet.js <address>
```
