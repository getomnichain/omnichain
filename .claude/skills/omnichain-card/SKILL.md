---
name: omnichain-card
description: Generate or fetch an omnichain task card, then drive the pre-push reviewer. Use when the user wants to start a change on the omnichain chain SDK — either they have a YouTrack ticket id (Mode A) or they have a description and want a card drafted (Mode B). The skill is two scripts: `make_card.py` to produce the card, then `review.py` to run a pre-push code review against local branches.
---

# omnichain-card

Run from the omnichain repo root.

## Mode A — user has a YouTrack ticket id

```bash
set -a && source code-review/.env && set +a
python3 code-review/make_card.py --from-youtrack <ISSUE-ID> --slug <slug>
```

Writes `code-review/cards/<slug>.md` from the ticket body.

## Mode B — user has a description, no ticket

```bash
python3 code-review/make_card.py \
  --from-description "<one-line description or @path/to/notes.txt>" \
  --slug <slug>
```

Drafts a full card matching `code-review/cards/_TEMPLATE.md`. Show the
result to the user; only proceed once they approve.

## After the card exists — implement, then review BEFORE pushing

1. `git checkout -b feature/<slug>` from `main`.
2. Make the change.
3. `python3 code-review/review.py --source feature/<slug> --target main --card <slug>`.
4. Read `code-review/review_<slug>.md`. Address Critical findings before push.
5. Push once the review is clean.

## Notes

- The reviewer reads ONLY local refs — never `origin/*`. Fetch/merge upstream first if you need fresh `main`.
- The card lives under version control at `code-review/cards/<slug>.md`. The
  `review_*` outputs are gitignored — regenerate them on every run.
- Never commit the YouTrack token. Use `code-review/.env` (gitignored).
