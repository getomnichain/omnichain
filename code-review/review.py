"""
omnichain code reviewer.

Drives a Claude-based review of a local feature branch against a local target
branch, using a hand-authored task card as the contract document. All branch
refs are LOCAL — nothing is fetched from origin. Run this BEFORE pushing.

Usage:
    python3 review.py --source <source-branch> --target <target-branch> --card <card-id>

Example:
    python3 review.py --source feature/verify-msg-sig --target main --card verify-message-signature

Outputs (in this directory):
    review_<card>.diff       # git diff <target>...<source> (three-dot, local refs)
    review_<card>_card.md    # the task card body from cards/<card>.md
    review_<card>.md         # Claude's verdict
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path


CURRENT_DIR = Path(__file__).resolve().parent
REPO_DIR = CURRENT_DIR.parent  # omnichain repo root
CARDS_DIR = CURRENT_DIR / "cards"
PROMPT_FILE = CURRENT_DIR / "prompt.md"


def run_git(*args: str) -> str:
    cmd = ["git", "-C", str(REPO_DIR), *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{result.stderr.strip()}")
    return result.stdout


def assert_local_ref(branch: str) -> None:
    out = run_git("rev-parse", "--verify", f"refs/heads/{branch}").strip()
    if not out:
        sys.exit(f"Local branch '{branch}' not found. This reviewer never pulls from origin.")


def main() -> int:
    parser = argparse.ArgumentParser(description="omnichain pre-push reviewer")
    parser.add_argument("--source", required=True, help="local source branch (the one with the change)")
    parser.add_argument("--target", required=True, help="local target branch (the one to merge into)")
    parser.add_argument("--card", required=True, help="task card id; reads cards/<id>.md")
    args = parser.parse_args()

    assert_local_ref(args.source)
    assert_local_ref(args.target)

    card_path = CARDS_DIR / f"{args.card}.md"
    if not card_path.exists():
        sys.exit(f"Card not found: {card_path}\nWrite the task card first, then re-run.")

    diff_path = CURRENT_DIR / f"review_{args.card}.diff"
    card_copy = CURRENT_DIR / f"review_{args.card}_card.md"
    review_path = CURRENT_DIR / f"review_{args.card}.md"

    diff_text = run_git("diff", f"{args.target}...{args.source}")
    if not diff_text.strip():
        sys.exit(
            f"Empty diff: {args.target}...{args.source} produced nothing. "
            f"Branches are identical or already merged. Aborting before review."
        )
    diff_path.write_text(diff_text, encoding="utf-8")
    print(f"[diff]  {diff_path}  ({len(diff_text.splitlines())} lines)")

    card_text = card_path.read_text(encoding="utf-8")
    card_copy.write_text(card_text, encoding="utf-8")
    print(f"[card]  {card_copy}")

    if not PROMPT_FILE.exists():
        sys.exit(f"prompt.md missing at {PROMPT_FILE}")
    prompt = PROMPT_FILE.read_text(encoding="utf-8")
    prompt = (
        prompt
        .replace("$CARD_ID", args.card)
        .replace("$SOURCE_BRANCH", args.source)
        .replace("$TARGET_BRANCH", args.target)
    )

    print(f"[claude] running review … (this can take a few minutes)")
    review = subprocess.run(["claude", "-p"], input=prompt, text=True, capture_output=True)
    if review.returncode != 0:
        sys.exit(f"claude -p failed:\n{review.stderr.strip()}")
    review_path.write_text(review.stdout, encoding="utf-8")
    print(f"[done]  {review_path}")

    body = review.stdout.lower()
    if "## critical" in body:
        after = body.split("## critical", 1)[1].split("##", 1)[0]
        findings: list[str] = []
        for line in after.splitlines():
            stripped = line.strip()
            if not stripped.startswith("-"):
                continue
            text = stripped.lstrip("- ").strip()
            head = re.split(r"[.\s]", text, 1)[0]
            if head in {"none", "nothing", "n/a", "na", ""}:
                continue
            findings.append(text)
        if findings:
            print("[gate]  CRITICAL findings present — read the review before pushing.", file=sys.stderr)
            return 1
    print("[gate]  no critical findings detected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
