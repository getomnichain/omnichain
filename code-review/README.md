# omnichain code review

Pre-push code reviewer for the omnichain chain SDK. Mirrors `pluton-back-end/code-review/` and `depositron-code-review/` in spirit, but:

- Runs **inside** the omnichain repo (this directory).
- Reads **only local refs** — never `origin/*`. Always fetch / merge locally first.
- All inputs come from the CLI (source branch, target branch, card id) — no hardcoded values.
- The "task card" is a local file at `cards/<id>.md` — no YouTrack / Trello integration. omnichain is an SDK, not a service; the contract document lives next to the change.

## Usage

```bash
# From inside this directory:
python3 review.py \
  --source feature/verify-msg-sig \
  --target main \
  --card verify-message-signature
```

Outputs (gitignored):

```
review_<card>.diff       # git diff <target>...<source>  (three-dot, local refs only)
review_<card>_card.md    # snapshot of cards/<id>.md at run time
review_<card>.md         # Claude's verdict
```

Exit codes:

- `0`: review ran; no Critical-section findings detected.
- `1`: review ran; the Critical section contains at least one finding. Read `review_<card>.md` before pushing.

## Workflow

There are two ways to get a card:

### Mode A — you already have a YouTrack ticket

```bash
set -a && source .env && set +a
python3 make_card.py --from-youtrack RIN-43 --slug rin-43-adopt-submodule
```

Pulls the ticket body verbatim and writes `cards/rin-43-adopt-submodule.md`.

### Mode B — you have a description, not a ticket

```bash
python3 make_card.py \
  --from-description "Add verifyMessageSignature for EVM/Solana/BTC" \
  --slug verify-message-signature
```

(or read from a file: `--from-description @notes.txt`)

Runs `claude -p` to fill in the template at `cards/_TEMPLATE.md` from your
description. Read the result, edit, commit only when happy.

### Then: implement + pre-push review

1. Make the change on a local feature branch.
2. Run `python3 review.py --source <branch> --target main --card <slug>`.
3. Read `review_<slug>.md`. Address criticals. Re-run.
4. Once the review is clean (exit 0 + no Critical), push to main (or open a PR, per repo convention).

## Why this is separate from the consumer-side reviewers

- `pluton-back-end/code-review/` and `depositron-code-review/` review the consumer services. They diff a feature branch against the service's production branch, use the service's own conventions doc, and assume the chain SDK is correct.
- This reviewer reviews the SDK itself. It diffs an omnichain branch against omnichain's `main`, uses the local card as the contract, and focuses on cross-chain symmetry and crypto-correctness — concerns that don't fit a service reviewer's lens.

## Skill (Claude Code)

A skill definition lives at `omnichain/.claude/skills/omnichain-card/SKILL.md`.
To make it user-wide (callable from any session), copy it into your home:

```bash
mkdir -p ~/.claude/skills/omnichain-card
cp .claude/skills/omnichain-card/SKILL.md ~/.claude/skills/omnichain-card/
```

The skill briefs Claude on the two card-creation modes and the pre-push review
loop — invoke it when you start work on the SDK.

## Adding a new card

```bash
cp cards/verify-message-signature.md cards/<your-slug>.md
$EDITOR cards/<your-slug>.md
# write a summary, scope, requirements, acceptance, affected files, DoD.
```

Keep cards small and self-contained. One ticket = one card = one branch = one review.

## Prompt rules

`prompt.md` is the system prompt sent to `claude -p`. It is biased toward:

- Cross-chain consistency (EVM ↔ Solana ↔ UTXO behave the same on the same logical input).
- Crypto correctness (fail closed on malformed input, no leaks via thrown stacks).
- SDK boundary discipline (no consumer-specific assumptions leaking into the SDK).

If the reviewer produces output you disagree with, edit `prompt.md` — don't argue with it in the review file.
