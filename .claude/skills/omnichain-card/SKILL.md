---
name: omnichain-card
description: Drive the full omnichain SDK change workflow — write or fetch the task card, implement, run pre-push review, loop on fixes. Use when the user is starting any change against the pluton-bridge/omnichain repo. Supports three modes depending on whether a YouTrack ticket already exists and whether the user wants manual or auto-pilot iteration.
---

# omnichain-card

You drive a structured workflow for omnichain changes. Pick the mode from how the user opened the conversation, then execute the steps strictly in order. Every card has its own directory at `code-review/cards/<slug>/` holding `description.md`, plus `diff_<N>.diff` and `review_<N>.md` for each review iteration.

All branches are **local-only** — never `origin/*` for review inputs. The user can see file changes live in VS Code on the running session, so "show the user the diff" means saving the change to disk and stating which files moved.

---

## Mode A — User gives a YouTrack card id

Trigger: user names a ticket like "RIN-44".

1. Fetch:
   ```bash
   cd <omnichain-root>
   set -a && source code-review/.env && set +a
   python3 code-review/make_card.py fetch --issue <ID> --slug <slug>
   ```
   `<slug>` defaults to lowercased issue id if you omit `--slug`.
2. Read `code-review/cards/<slug>/description.md`. Confirm the scope with one sentence back to the user.
3. Branch: `git checkout -b feature/<slug>` from `main`.
4. Implement the change. Keep edits scoped to what the card lists in **Affected files** / **Scope**.
5. When the code is in a state to review, show the user the file list and a brief summary. Wait for **code approval** before proceeding.
6. On code approval, run review:
   ```bash
   python3 code-review/code_reviewer.py --source feature/<slug> --target main --card <slug>
   ```
   Output appends `cards/<slug>/diff_<N>.diff` and `cards/<slug>/review_<N>.md`. The script exits non-zero if the **Critical** section has real findings.
7. Show the user the review at `cards/<slug>/review_<N>.md`. Wait for **review approval**.
8. If the user says "fix the criticals" (or any subset), edit the code, then go back to step 5.
9. When the review is approved AND clean, push: `git push -u origin feature/<slug>` and tell the user the branch is up for merge.

---

## Mode B-manual — User gives a description, wants to drive review by hand

Trigger: user gives a free-text description of what they want and does NOT say "auto" / "autopilot".

1. Draft the card:
   ```bash
   python3 code-review/make_card.py draft \
     --description "<the user's description, or @path/to/notes.txt>" \
     --slug <slug>
   ```
2. Show the user `code-review/cards/<slug>/description.md`. **Wait for the user to approve the card.** They may ask for edits — apply them and show again. Loop until approved.
3. On card approval, post the card up to YouTrack so it has a ticket id:
   ```bash
   set -a && source code-review/.env && set +a
   python3 code-review/make_card.py post \
     --slug <slug> --project RIN --summary "<one-line title>"
   ```
   Capture the issue id the script prints (e.g. `RIN-50`) and add it to the top of `cards/<slug>/description.md` for traceability. Default project is `RIN` for the pluton org; ask the user if you're unsure.
4. From here on, follow Mode A steps 3 through 9.

---

## Mode B-auto — User gives a description AND says auto / autopilot

Trigger: user says "auto mode", "autopilot", "no approvals", or equivalent, alongside a description.

1. Draft the card (same `make_card.py draft` call). Do NOT wait for approval — the user has opted out of approvals.
2. Branch: `git checkout -b feature/<slug>` from `main`.
3. Implement.
4. Run the review (`code_reviewer.py …`). Save the iteration log.
5. If `code_reviewer.py` exit code is 0 (no Critical findings):
   - Push the branch and tell the user the branch is ready for merge. Stop.
6. If exit code is 1 (Critical findings present):
   - Read `cards/<slug>/review_<N>.md`.
   - Address every Critical finding in code.
   - Go back to step 4.
7. Hard cap: **at most 5 review iterations.** If iteration 5 still exits 1, stop, leave the branch unpushed, summarize the remaining Criticals, and tell the user manual review is needed. Do not push code that failed the gate.

Use `TodoWrite` to track the iteration count so you don't drift past 5.

---

## Important rules across all modes

- **Local refs only.** `code_reviewer.py` rejects anything that isn't a local branch. If you need fresh `main`, do `git fetch && git checkout main && git pull` first — then re-branch.
- **One slug per change.** All artifacts live under `cards/<slug>/`. Never write reviews to the repo root.
- **Never delete prior iteration logs.** They're the audit trail. `code_reviewer.py` auto-increments `<N>`.
- **Don't bypass the gate.** If `code_reviewer.py` exits 1, the code is not ready to push, regardless of whether you personally agree with the finding. Either fix it or document why it's a false positive in `cards/<slug>/review_<N>.md` and ask the user.
- **Card body lives at `description.md`.** When the user asks "what was this card?", read `cards/<slug>/description.md`, not the YouTrack copy — local is the source of truth during the change.
- **Determining the slug**: prefer the YouTrack id lowercased (`rin-44`) for Mode A. Prefer a short kebab-case noun phrase for Mode B (`verify-message-signature`).

---

## Skill self-check before starting

Before running any command, verify:

- Working directory is the omnichain repo root.
- `code-review/.env` exists and `YOUTRACK_TOKEN` is set (only needed for `fetch` / `post`).
- `python3 -c "import requests"` succeeds (the scripts depend on it).
- `claude -p` is on PATH (the scripts shell out to it).

If any check fails, fix it before starting the workflow — don't half-run and leave the user with partial state.
