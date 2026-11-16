"""Direct-mode tests for GrantTranche.

    env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
        --with pytest --with genlayer-test pytest tests/direct -q

The evidence page and the model are mocked; the contract is not.
"""

import json

CONTRACT = "contracts/grant_tranche.py"
PROMPT = r"reviewing a grant tranche"
EVIDENCE = "https://grantee.example.org/report"

RUBRIC = [
    "a public code repository with the contract source",
    "a live application URL that calls the contract",
    "a written usage report with numbers",
]


def who(addr):
    from genlayer import Address

    return str(Address(bytes(addr))).lower()


def deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def opened(contract, direct_vm, funder, grantee, grant_id="grant-1", tranches=2, rubric=RUBRIC):
    direct_vm.sender = funder
    return contract.open_grant(grant_id, "Docs tooling grant", who(grantee), json.dumps(rubric), tranches)


def review(met_flags, quotes=None, reason="the page shows what the rubric asks for"):
    quotes = list(quotes or [])
    quotes += [""] * (len(met_flags) - len(quotes))
    rows = []
    for index, met in enumerate(met_flags):
        quote = quotes[index]
        rows.append({"criterion": index + 1, "met": met, "quote": quote})
    return {"criteria": rows, "reason": reason}


def submit(contract, direct_vm, sender, payload, evidence=EVIDENCE, page="the evidence page", grant_id="grant-1"):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"grantee\.example\.org", {"status": 200, "body": page})
    direct_vm.mock_llm(PROMPT, payload if isinstance(payload, str) else json.dumps(payload))
    direct_vm.sender = sender
    return contract.submit_tranche(grant_id, evidence)


def challenge(contract, direct_vm, sender, payload, tranche=1, reason="the live URL is not on the page", grant_id="grant-1"):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"grantee\.example\.org", {"status": 200, "body": "the evidence page"})
    direct_vm.mock_llm(PROMPT, payload if isinstance(payload, str) else json.dumps(payload))
    direct_vm.sender = sender
    return contract.challenge_tranche(grant_id, tranche, reason)


def answer(contract, direct_vm, sender, payload, tranche=1, evidence="https://grantee.example.org/answer", grant_id="grant-1"):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"grantee\.example\.org", {"status": 200, "body": "the answered page"})
    direct_vm.mock_llm(PROMPT, payload if isinstance(payload, str) else json.dumps(payload))
    direct_vm.sender = sender
    return contract.answer_challenge(grant_id, tranche, evidence)


class TestOpen:
    def test_the_rubric_and_the_tranche_count_are_written_once(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        out = opened(contract, direct_vm, direct_alice, direct_bob)

        assert out["grant_id"] == "grant-1"
        assert out["funder"] == who(direct_alice)
        assert out["grantee"] == who(direct_bob)
        assert out["tranches"] == 2
        assert out["criteria"] == 3
        assert out["status"] == "open"

        grant = contract.get_grant("grant-1")
        assert grant["rubric"] == RUBRIC
        assert grant["approved"] == 0
        assert grant["current_tranche"] == 1
        assert grant["next_tranche"] == 1
        assert grant["best"] == 0
        assert contract.stats() == {"grants": 1, "open": 1, "complete": 0, "tranches_approved": 0}

    def test_a_rubric_needs_two_to_six_distinct_criteria(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        grantee = who(direct_bob)

        with direct_vm.expect_revert("at least 2 criteria"):
            contract.open_grant("g", "T", grantee, json.dumps(["only one"]), 1)
        with direct_vm.expect_revert("at most 6 criteria"):
            contract.open_grant("g", "T", grantee, json.dumps([f"c{i}" for i in range(7)]), 1)
        with direct_vm.expect_revert("two rubric criteria are identical"):
            contract.open_grant("g", "T", grantee, json.dumps(["same", "same"]), 1)

    def test_the_grantee_must_be_an_address_and_tranches_are_bounded(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        rubric = json.dumps(RUBRIC)

        with direct_vm.expect_revert("must be a 0x address"):
            contract.open_grant("g1", "T", "not-an-address", rubric, 2)
        with direct_vm.expect_revert("1 to 12 tranches"):
            contract.open_grant("g2", "T", who(direct_alice), rubric, 0)
        with direct_vm.expect_revert("1 to 12 tranches"):
            contract.open_grant("g3", "T", who(direct_alice), rubric, 13)

    def test_a_grant_id_is_single_use(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        with direct_vm.expect_revert("is taken"):
            opened(contract, direct_vm, direct_alice, direct_bob)


class TestSubmit:
    def test_a_full_reading_issues_the_tranche_receipt(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)

        out = submit(
            contract, direct_vm, direct_bob,
            review([True, True, True], ["https://github.com/acme/tool", "https://tool.example.org", "600 users"]),
        )

        assert out["tranche"] == 1
        assert out["met"] == 3
        assert out["approved"] is True
        assert out["verdict"][0]["quote"] == "https://github.com/acme/tool"
        assert out["caller"] == who(direct_bob)

        grant = contract.get_grant("grant-1")
        assert grant["approved"] == 1
        assert grant["best"] == 0
        assert grant["current_tranche"] == 2
        assert contract.stats()["tranches_approved"] == 1

    def test_a_partial_reading_is_kept_and_tops_up(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)

        first = submit(contract, direct_vm, direct_bob, review([True, False, False], ["repo only"]))
        assert first["approved"] is False
        assert contract.get_grant("grant-1")["best"] == 1

        second = submit(contract, direct_vm, direct_bob, review([True, True, False], ["repo", "live url"]))
        assert second["approved"] is False
        grant = contract.get_grant("grant-1")
        assert grant["best"] == 2
        assert grant["approved"] == 0

        third = submit(contract, direct_vm, direct_bob, review([True, True, True], ["repo", "url", "report"]))
        assert third["approved"] is True
        assert contract.get_grant("grant-1")["approved"] == 1

        receipts = contract.receipts_of("grant-1")
        assert [r["met"] for r in receipts] == [1, 2, 3]
        assert [r["approved"] for r in receipts] == [False, False, True]

    def test_progress_never_moves_backwards(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)

        submit(contract, direct_vm, direct_bob, review([True, True, False]))
        submit(contract, direct_vm, direct_bob, review([False, False, False], reason="the page was rewritten"))

        grant = contract.get_grant("grant-1")
        assert grant["best"] == 2
        assert grant["approved"] == 0
        assert len(contract.receipts_of("grant-1")) == 2

    def test_only_the_grantee_submits_evidence(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        stranger = bytes([0x33] * 20)
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = stranger

        with direct_vm.expect_revert("only the grantee"):
            contract.submit_tranche("grant-1", EVIDENCE)
        assert contract.get_grant("grant-1")["attempts"] == 0

    def test_a_broken_answer_stores_nothing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)

        with direct_vm.expect_revert("criteria but the rubric has"):
            submit(contract, direct_vm, direct_bob, review([True, True]))
        with direct_vm.expect_revert("boolean met value"):
            submit(contract, direct_vm, direct_bob, {"criteria": [{"met": "yes"}, {"met": True}, {"met": False}]})

        grant = contract.get_grant("grant-1")
        assert grant["attempts"] == 0
        assert grant["best"] == 0
        assert contract.receipts_of("grant-1") == []

    def test_an_unreadable_page_stores_nothing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.clear_mocks()
        direct_vm.mock_web(r"grantee\.example\.org", {"status": 200, "body": "  "})
        direct_vm.mock_llm(PROMPT, json.dumps(review([True, True, True])))
        direct_vm.sender = direct_bob

        with direct_vm.expect_revert("no readable text"):
            contract.submit_tranche("grant-1", EVIDENCE)
        assert contract.get_grant("grant-1")["attempts"] == 0

    def test_the_evidence_url_must_be_http(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("not an http"):
            contract.submit_tranche("grant-1", "grantee.example.org/report")


class TestLifecycle:
    def test_a_grant_completes_after_its_last_tranche(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob, tranches=2)

        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        submit(contract, direct_vm, direct_bob, review([True, True, True]))

        grant = contract.get_grant("grant-1")
        assert grant["status"] == "complete"
        assert grant["approved"] == 2
        assert grant["next_tranche"] == 0

        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("no tranche can be submitted"):
            contract.submit_tranche("grant-1", EVIDENCE)
        assert contract.stats() == {"grants": 1, "open": 0, "complete": 1, "tranches_approved": 2}

    def test_only_the_funder_closes_and_a_closed_grant_takes_no_evidence(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        stranger = bytes([0x33] * 20)
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)

        direct_vm.sender = stranger
        with direct_vm.expect_revert("only the funder"):
            contract.close_grant("grant-1")

        direct_vm.sender = direct_alice
        out = contract.close_grant("grant-1")
        assert out["status"] == "closed"

        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("is closed"):
            contract.submit_tranche("grant-1", EVIDENCE)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("already closed"):
            contract.close_grant("grant-1")

    def test_grants_are_listed_newest_first(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob, "grant-a")
        direct_vm.sender = direct_alice
        contract.open_grant("grant-b", "Second grant", who(direct_bob), json.dumps(RUBRIC), 3)

        listed = contract.list_grants(0, 10)
        assert [g["id"] for g in listed] == ["grant-b", "grant-a"]
        assert listed[0]["tranches"] == 3


class TestChallenge:
    def test_a_second_reading_that_disagrees_revokes_the_tranche(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        assert contract.get_grant("grant-1")["approved"] == 1

        out = challenge(contract, direct_vm, direct_alice, review([True, True, False], reason="no live URL on the page"))

        assert out["state"] == "upheld"
        assert out["tranche"] == 1
        assert out["reread_met"] == 2 and out["reread_total"] == 3
        grant = contract.get_grant("grant-1")
        assert grant["approved"] == 0
        assert grant["best"] == 2
        assert grant["next_tranche"] == 1
        assert grant["status"] == "open"
        assert grant["challenge"]["state"] == "upheld"
        assert grant["can_challenge"] is False
        assert contract.receipts_of("grant-1")[0]["revoked"] is True
        assert contract.stats()["tranches_approved"] == 0

    def test_a_second_reading_that_agrees_leaves_the_receipt_standing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))

        out = challenge(contract, direct_vm, direct_alice, review([True, True, True]))

        assert out["state"] == "rejected"
        grant = contract.get_grant("grant-1")
        assert grant["approved"] == 1
        assert grant["challenge"]["state"] == "rejected"
        assert grant["can_challenge"] is False
        assert contract.receipts_of("grant-1")[0]["revoked"] is False

    def test_the_grantee_answers_a_revocation_with_a_page_they_choose(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        challenge(contract, direct_vm, direct_alice, review([True, False, False]))

        out = answer(contract, direct_vm, direct_bob, review([True, True, True]))

        assert out["state"] == "restored"
        assert out["answer_url"] == "https://grantee.example.org/answer"
        assert out["answer_met"] == 3
        grant = contract.get_grant("grant-1")
        assert grant["approved"] == 1
        assert grant["best"] == 0
        assert grant["current_tranche"] == 2

    def test_an_answer_that_still_misses_keeps_the_revocation(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        challenge(contract, direct_vm, direct_alice, review([True, False, False]))

        out = answer(contract, direct_vm, direct_bob, review([True, True, False]))

        assert out["state"] == "upheld"
        assert out["answer_met"] == 2
        grant = contract.get_grant("grant-1")
        assert grant["approved"] == 0
        assert grant["best"] == 1

        with direct_vm.expect_revert("answered once already"):
            answer(contract, direct_vm, direct_bob, review([True, True, True]))

    def test_only_the_funder_challenges(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        stranger = bytes([0x33] * 20)
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))

        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the funder"):
            contract.challenge_tranche("grant-1", 1, "the URL is dead")
        direct_vm.sender = stranger
        with direct_vm.expect_revert("only the funder"):
            contract.challenge_tranche("grant-1", 1, "the URL is dead")
        assert contract.get_grant("grant-1")["approved"] == 1

    def test_only_the_latest_approved_tranche_can_be_challenged(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob, tranches=2)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        assert contract.get_grant("grant-1")["status"] == "complete"

        with direct_vm.expect_revert("only the latest approved tranche"):
            challenge(contract, direct_vm, direct_alice, review([False, False, False]), tranche=1)

        out = challenge(contract, direct_vm, direct_alice, review([True, True, False]), tranche=2)
        assert out["state"] == "upheld"
        grant = contract.get_grant("grant-1")
        assert grant["approved"] == 1
        assert grant["status"] == "open"
        assert grant["best"] == 2

    def test_a_tranche_is_challenged_once(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        challenge(contract, direct_vm, direct_alice, review([True, True, True]))

        with direct_vm.expect_revert("already challenged once"):
            challenge(contract, direct_vm, direct_alice, review([False, False, False]))

    def test_a_challenge_needs_a_standing_receipt_and_a_reason(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)

        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("has no standing receipt"):
            contract.challenge_tranche("grant-1", 1, "premature")

        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("needs a reason"):
            contract.challenge_tranche("grant-1", 1, "  ")

    def test_only_the_grantee_answers_and_only_an_upheld_challenge(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        challenge(contract, direct_vm, direct_alice, review([True, True, True]))

        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("nothing to answer"):
            contract.answer_challenge("grant-1", 1, EVIDENCE)

        opened2 = contract.get_grant("grant-1")
        assert opened2["challenge"]["state"] == "rejected"

    def test_a_closed_grant_takes_no_challenge(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob, tranches=2)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        direct_vm.sender = direct_alice
        contract.close_grant("grant-1")

        with direct_vm.expect_revert("is closed"):
            challenge(contract, direct_vm, direct_alice, review([False, False, False]))

    def test_a_new_submission_after_revocation_blocks_the_answer(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        challenge(contract, direct_vm, direct_alice, review([False, False, False]))
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        assert contract.get_grant("grant-1")["approved"] == 1

        with direct_vm.expect_revert("already has a standing receipt"):
            answer(contract, direct_vm, direct_bob, review([True, True, True]))

    def test_restoring_the_last_tranche_completes_the_grant(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob, tranches=1)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        assert contract.get_grant("grant-1")["status"] == "complete"

        challenge(contract, direct_vm, direct_alice, review([False, True, True]))
        grant = contract.get_grant("grant-1")
        assert grant["status"] == "open"
        assert grant["approved"] == 0

        answer(contract, direct_vm, direct_bob, review([True, True, True]))
        grant = contract.get_grant("grant-1")
        assert grant["status"] == "complete"
        assert grant["approved"] == 1
        assert contract.stats() == {"grants": 1, "open": 0, "complete": 1, "tranches_approved": 1}

    def test_challenges_are_listed_with_the_reading_that_decided_them(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, direct_bob)
        submit(contract, direct_vm, direct_bob, review([True, True, True]))
        challenge(contract, direct_vm, direct_alice, review([True, True, False]))

        listed = contract.challenges_of("grant-1")
        assert len(listed) == 1
        assert listed[0]["tranche"] == 1
        assert listed[0]["caller"] == who(direct_alice)
        assert listed[0]["reason"] == "the live URL is not on the page"
        assert listed[0]["reread_verdict"][2]["met"] is False
