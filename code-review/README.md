# omnichain code review

Pre-push code reviewer + task-card generator for the omnichain chain SDK.

- Runs **inside** the omnichain repo (this directory).
- Reads **only local refs** — never `origin/*`.
- Every card lives in its own directory at `cards/<slug>/` holding the description and every review iteration's diff + verdict.
- Posts approved cards up to YouTrack so the ticket id matches what was implemented.

The complete workflow is encoded in [`.claude/skills/omnichain-card/SKILL.md`](../.claude/skills/omnichain-card/SKILL.md) — read that for the three modes (card-id, description-manual, description-auto). The summary below is the tool reference.

## Card directory layout

```
cards/<slug>/
    description.md     # the card body — the contract
    diff_1.diff        # git diff target...source at iteration 1
    review_1.md        # claude -p verdict at iteration 1
    diff_2.diff        # …after a fix
    review_2.md
    ...
```

## `make_card.py`

```bash
# Fetch a YouTrack issue into cards/<slug>/description.md
set -a && source .env && set +a
python3 make_card.py fetch --issue RIN-44 --slug rin-44

# Draft a card from a description via `claude -p`
python3 make_card.py draft \
  --description "Add verifyMessageSignature for EVM/Solana/BTC" \
  --slug verify-message-signature

# Post an approved local card up to YouTrack as a new issue
python3 make_card.py post \
  --slug verify-message-signature \
  --project RIN \
  --summary "Verify message signature across EVM/Solana/BTC"
```

## `code_reviewer.py`

```bash
python3 code_reviewer.py --source feature/<slug> --target main --card <slug>
```

Reads `cards/<slug>/description.md` for the contract, runs the diff against local refs only, and writes the next `diff_<N>.diff` + `review_<N>.md` into the same directory.

Exit codes:

- `0`: no Critical-section findings — safe to push (per the rules in the skill).
- `1`: at least one Critical finding — fix and re-run.

## Why this is separate from the consumer-side reviewers

- `pluton-back-end/code-review/` and `depositron-code-review/` review the consumer services. They diff a feature branch against the service's production branch and assume the chain SDK is correct.
- This reviewer reviews the SDK itself. It diffs an omnichain branch against omnichain's `main`, uses the local card as the contract, and focuses on cross-chain symmetry and crypto correctness — concerns that don't fit a service reviewer's lens.

## Skill (Claude Code)

The skill definition lives at `omnichain/.claude/skills/omnichain-card/SKILL.md`. To make it user-wide (callable from any session):

```bash
mkdir -p ~/.claude/skills/omnichain-card
cp .claude/skills/omnichain-card/SKILL.md ~/.claude/skills/omnichain-card/
```

## Prompt rules

`prompt.md` is the system prompt sent to `claude -p`. It is biased toward:

- Cross-chain consistency (EVM ↔ Solana ↔ UTXO behave the same on the same logical input).
- Crypto correctness (fail closed on malformed input, no leaks via thrown stacks).
- SDK boundary discipline (no consumer-specific assumptions leaking into the SDK).

If the reviewer produces output you disagree with, edit `prompt.md` — don't argue with it in the review file.
