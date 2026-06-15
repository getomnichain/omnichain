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

1. Write the card at `cards/<short-slug>.md`. This is the contract — what the change is supposed to do, what's in scope, what's not, what done looks like.
2. Make the change on a local feature branch.
3. Run `python3 review.py --source <branch> --target main --card <slug>`.
4. Read `review_<slug>.md`. Address criticals. Re-run.
5. Once the review is clean (exit 0 + no Critical), push to main (or open a PR, per repo convention).

## Why this is separate from the consumer-side reviewers

- `pluton-back-end/code-review/` and `depositron-code-review/` review the consumer services. They diff a feature branch against the service's production branch, use the service's own conventions doc, and assume the chain SDK is correct.
- This reviewer reviews the SDK itself. It diffs an omnichain branch against omnichain's `main`, uses the local card as the contract, and focuses on cross-chain symmetry and crypto-correctness — concerns that don't fit a service reviewer's lens.

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
