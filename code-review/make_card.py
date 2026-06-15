"""
omnichain task-card generator.

Two modes:

  1. --from-youtrack <ISSUE-ID>
     Fetch the YouTrack issue body and save it verbatim to cards/<slug>.md.
     Use when the card is already written upstream and you only have the ID.

  2. --from-description <text-or-@file>
     Run Claude to draft a card matching the template at cards/_TEMPLATE.md,
     using your description as the seed. Use when you have the idea but not
     the formal card.

Either way the output lands at code-review/cards/<slug>.md, where the reviewer
(`review.py --card <slug>`) reads it.

Examples:

    # Mode A — fetch from YouTrack (token must be exported as YOUTRACK_TOKEN)
    python3 make_card.py --from-youtrack RIN-43 --slug rin-43-adopt-submodule

    # Mode B — let Claude draft from your description
    python3 make_card.py \\
        --from-description "Add verifyMessageSignature for EVM/Solana/BTC" \\
        --slug verify-message-signature

    # Mode B — read description from a file
    python3 make_card.py --from-description @notes.txt --slug some-feature
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

import requests


CURRENT_DIR = Path(__file__).resolve().parent
CARDS_DIR = CURRENT_DIR / "cards"
TEMPLATE_FILE = CARDS_DIR / "_TEMPLATE.md"

YOUTRACK_BASE_URL = "https://rango.youtrack.cloud"


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or "card"


def read_description(value: str) -> str:
    if value.startswith("@"):
        path = Path(value[1:]).expanduser().resolve()
        if not path.exists():
            sys.exit(f"description file not found: {path}")
        return path.read_text(encoding="utf-8")
    return value


def fetch_youtrack_issue(issue_id: str) -> str:
    token = os.environ.get("YOUTRACK_TOKEN", "").strip()
    if not token:
        sys.exit(
            "YOUTRACK_TOKEN is not set. Export it before running --from-youtrack:\n"
            "  export YOUTRACK_TOKEN=perm-..."
        )
    resp = requests.get(
        f"{YOUTRACK_BASE_URL}/api/issues/{issue_id}",
        params={"fields": "idReadable,summary,description"},
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        timeout=15,
    )
    if resp.status_code == 404:
        sys.exit(f"YouTrack issue {issue_id} not found (404). Check the ID.")
    resp.raise_for_status()
    issue = resp.json()
    summary = issue.get("summary") or issue_id
    description = issue.get("description") or ""
    if not description.strip():
        sys.exit(
            f"YouTrack issue {issue_id} has an empty description. "
            f"Write the card body in YouTrack first, or use --from-description."
        )
    return f"# {summary}\n\n{description}\n"


def draft_via_claude(description: str) -> str:
    if not TEMPLATE_FILE.exists():
        sys.exit(f"template not found at {TEMPLATE_FILE}")
    template = TEMPLATE_FILE.read_text(encoding="utf-8")
    prompt = (
        "You are drafting a task card for the omnichain chain SDK.\n\n"
        "Fill out EVERY section of the template below using the user's description.\n"
        "Never leave a placeholder like 'Item 1' or '<Title Goes Here>'. If a section\n"
        "genuinely doesn't apply, write 'Not applicable — <one-sentence reason>'.\n"
        "Keep the section order and the markdown structure intact.\n\n"
        "User description:\n"
        "-----\n"
        f"{description.strip()}\n"
        "-----\n\n"
        "Template to fill:\n"
        "-----\n"
        f"{template}\n"
        "-----\n\n"
        "Output ONLY the filled card body. No preamble, no trailing prose, no questions."
    )
    result = subprocess.run(["claude", "-p"], input=prompt, text=True, capture_output=True)
    if result.returncode != 0:
        sys.exit(f"claude -p failed:\n{result.stderr.strip()}")
    body = result.stdout.strip()
    if not body:
        sys.exit("claude returned empty output")
    return body + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="omnichain card generator")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--from-youtrack", metavar="ISSUE-ID", help="fetch the card from YouTrack")
    mode.add_argument(
        "--from-description",
        metavar="TEXT or @FILE",
        help="draft the card from a description (prefix with @ to read from a file)",
    )
    parser.add_argument("--slug", required=True, help="slug for the output file: cards/<slug>.md")
    parser.add_argument("--overwrite", action="store_true", help="replace an existing cards/<slug>.md")
    args = parser.parse_args()

    slug = slugify(args.slug)
    out_path = CARDS_DIR / f"{slug}.md"
    if out_path.exists() and not args.overwrite:
        sys.exit(f"refusing to overwrite {out_path} (pass --overwrite to replace)")

    if args.from_youtrack:
        body = fetch_youtrack_issue(args.from_youtrack)
        source = f"YouTrack {args.from_youtrack}"
    else:
        description = read_description(args.from_description)
        body = draft_via_claude(description)
        source = "description (drafted by claude -p)"

    out_path.write_text(body, encoding="utf-8")
    print(f"[card] wrote {out_path} from {source}")
    print(f"[next] review the card, then run:")
    print(f"       python3 review.py --source <branch> --target main --card {slug}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
