"""
omnichain code reviewer.

Drives a Claude-based review of a local feature branch against a local target
branch, using the card at cards/<slug>/description.md as the contract document.
All branch refs are LOCAL — nothing is fetched from origin.

Each invocation appends a new iteration to cards/<slug>/:

    cards/<slug>/
        description.md
        diff_1.diff       review_1.md       <- first run
        diff_2.diff       review_2.md       <- after a fix
        ...

so the cycle (review → fix → re-review) is logged on disk.

Usage:
    python3 code_reviewer.py --source <source-branch> --target <target-branch> --card <slug>

Example:
    python3 code_reviewer.py --source feature/verify-msg-sig --target main --card verify-message-signature

Exit codes:
    0 — review ran and the Critical section is empty.
    1 — review ran and the Critical section has at least one real finding.
        Read cards/<slug>/review_<N>.md before pushing.
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


def next_iteration(card_dir: Path) -> int:
    n = 0
    for f in card_dir.glob("review_*.md"):
        m = re.match(r"review_(\d+)\.md$", f.name)
        if m:
            n = max(n, int(m.group(1)))
    return n + 1


def critical_findings(body_lower: str) -> list[str]:
    if "## critical" not in body_lower:
        return []
    after = body_lower.split("## critical", 1)[1].split("##", 1)[0]
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
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="omnichain pre-push reviewer")
    parser.add_argument("--source", required=True, help="local source branch (the change)")
    parser.add_argument("--target", required=True, help="local target branch (merge target)")
    parser.add_argument("--card", required=True, help="card slug; reads cards/<slug>/description.md")
    args = parser.parse_args()

    assert_local_ref(args.source)
    assert_local_ref(args.target)

    card_dir = CARDS_DIR / args.card
    desc_path = card_dir / "description.md"
    if not desc_path.exists():
        sys.exit(
            f"No description at {desc_path}.\n"
            f"Create it with `make_card.py fetch` or `make_card.py draft` first."
        )

    diff_text = run_git("diff", f"{args.target}...{args.source}")
    if not diff_text.strip():
        sys.exit(
            f"Empty diff: {args.target}...{args.source} produced nothing. "
            f"Branches are identical or already merged. Aborting before review."
        )

    iteration = next_iteration(card_dir)
    diff_path = card_dir / f"diff_{iteration}.diff"
    review_path = card_dir / f"review_{iteration}.md"
    diff_path.write_text(diff_text, encoding="utf-8")
    print(f"[diff]  {diff_path}  ({len(diff_text.splitlines())} lines)")
    print(f"[card]  {desc_path}")

    if not PROMPT_FILE.exists():
        sys.exit(f"prompt.md missing at {PROMPT_FILE}")
    prompt = (
        PROMPT_FILE.read_text(encoding="utf-8")
        .replace("$CARD_ID", args.card)
        .replace("$SOURCE_BRANCH", args.source)
        .replace("$TARGET_BRANCH", args.target)
        .replace("$ITERATION", str(iteration))
        .replace("$DESCRIPTION_PATH", str(desc_path.relative_to(REPO_DIR)))
        .replace("$DIFF_PATH", str(diff_path.relative_to(REPO_DIR)))
    )

    print(f"[claude] running review (iteration {iteration}) … this can take a few minutes")
    proc = subprocess.run(["claude", "-p"], input=prompt, text=True, capture_output=True)
    if proc.returncode != 0:
        sys.exit(f"claude -p failed:\n{proc.stderr.strip()}")
    review_path.write_text(proc.stdout, encoding="utf-8")
    print(f"[done]  {review_path}")

    findings = critical_findings(proc.stdout.lower())
    if findings:
        print("[gate]  CRITICAL findings present — read the review before pushing.", file=sys.stderr)
        return 1
    print("[gate]  no critical findings detected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
