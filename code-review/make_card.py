"""
omnichain task-card generator.

Each card lives in its own directory under cards/<slug>/, holding the
description plus every review iteration's diff and verdict:

    code-review/cards/<slug>/
        description.md     # the card body
        diff_<N>.diff      # snapshot of git diff at review N
        review_<N>.md      # Claude's verdict at review N

Three subcommands:

    fetch    Pull a YouTrack issue body into cards/<slug>/description.md.
    draft    Draft a card from a description, via `claude -p`.
    post     Post an already-drafted local card up to YouTrack as a new issue.

Examples:

    # Mode A — fetch
    set -a && source .env && set +a
    python3 make_card.py fetch --issue RIN-44 --slug rin-44

    # Mode B — draft from a description
    python3 make_card.py draft \\
        --description "Add Chain.verifyMessageSignature for EVM/Solana/BTC" \\
        --slug verify-message-signature
    # ...user reviews cards/verify-message-signature/description.md...

    # Mode B (continued) — push the approved card to YouTrack
    python3 make_card.py post \\
        --slug verify-message-signature \\
        --project RIN \\
        --summary "Verify message signature across EVM/Solana/BTC"

The skill at .claude/skills/omnichain-card drives the full workflow.
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


def card_dir_for(slug: str) -> Path:
    return CARDS_DIR / slug


def description_path(slug: str) -> Path:
    return card_dir_for(slug) / "description.md"


def youtrack_token() -> str:
    token = os.environ.get("YOUTRACK_TOKEN", "").strip()
    if not token:
        sys.exit(
            "YOUTRACK_TOKEN is not set. Export it before running:\n"
            "  set -a && source .env && set +a"
        )
    return token


def read_text_arg(value: str) -> str:
    if value.startswith("@"):
        path = Path(value[1:]).expanduser().resolve()
        if not path.exists():
            sys.exit(f"file not found: {path}")
        return path.read_text(encoding="utf-8")
    return value


def write_card(slug: str, body: str, *, overwrite: bool) -> Path:
    card_dir_for(slug).mkdir(parents=True, exist_ok=True)
    out = description_path(slug)
    if out.exists() and not overwrite:
        sys.exit(f"refusing to overwrite {out} (pass --overwrite to replace)")
    out.write_text(body.rstrip() + "\n", encoding="utf-8")
    return out


def cmd_fetch(args: argparse.Namespace) -> int:
    token = youtrack_token()
    resp = requests.get(
        f"{YOUTRACK_BASE_URL}/api/issues/{args.issue}",
        params={"fields": "idReadable,summary,description"},
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        timeout=15,
    )
    if resp.status_code == 404:
        sys.exit(f"YouTrack issue {args.issue} not found (404). Check the ID.")
    resp.raise_for_status()
    issue = resp.json()
    summary = issue.get("summary") or args.issue
    description = (issue.get("description") or "").strip()
    if not description:
        sys.exit(
            f"YouTrack issue {args.issue} has an empty description. "
            f"Write the body in YouTrack first, or use `draft`."
        )
    body = f"# {summary}\n\n{description}\n"
    slug = slugify(args.slug or args.issue)
    out = write_card(slug, body, overwrite=args.overwrite)
    print(f"[fetch] {out}  (from YouTrack {args.issue})")
    print(f"[next]  python3 review.py --source <branch> --target main --card {slug}")
    return 0


def cmd_draft(args: argparse.Namespace) -> int:
    if not TEMPLATE_FILE.exists():
        sys.exit(f"template not found at {TEMPLATE_FILE}")
    template = TEMPLATE_FILE.read_text(encoding="utf-8")
    description = read_text_arg(args.description)
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
    slug = slugify(args.slug)
    out = write_card(slug, body, overwrite=args.overwrite)
    print(f"[draft] {out}  (drafted by claude -p)")
    print(f"[next]  review the card with the user.")
    print(f"        on approval: python3 make_card.py post --slug {slug} --project <KEY> --summary '<title>'")
    return 0


def cmd_post(args: argparse.Namespace) -> int:
    token = youtrack_token()
    desc_path = description_path(args.slug)
    if not desc_path.exists():
        sys.exit(f"no description at {desc_path}. Run `fetch` or `draft` first.")
    body = desc_path.read_text(encoding="utf-8")
    payload = {
        "project": {"shortName": args.project},
        "summary": args.summary,
        "description": body,
    }
    resp = requests.post(
        f"{YOUTRACK_BASE_URL}/api/issues",
        params={"fields": "idReadable,id"},
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=20,
    )
    if not resp.ok:
        sys.exit(f"YouTrack create failed: {resp.status_code} {resp.text}")
    issue = resp.json()
    issue_id = issue.get("idReadable") or issue.get("id") or "?"
    print(f"[post]  created YouTrack issue {issue_id} in project {args.project}")
    print(f"        {YOUTRACK_BASE_URL}/issue/{issue_id}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="omnichain card generator")
    sub = parser.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="fetch a card from YouTrack")
    f.add_argument("--issue", required=True, help="YouTrack issue id, e.g. RIN-44")
    f.add_argument("--slug", default=None, help="output slug (defaults to lowercase issue id)")
    f.add_argument("--overwrite", action="store_true", help="replace existing description.md")
    f.set_defaults(func=cmd_fetch)

    d = sub.add_parser("draft", help="draft a card from a description")
    d.add_argument("--description", required=True, help="description text, or @file")
    d.add_argument("--slug", required=True, help="output slug")
    d.add_argument("--overwrite", action="store_true", help="replace existing description.md")
    d.set_defaults(func=cmd_draft)

    p = sub.add_parser("post", help="post an approved local card up to YouTrack")
    p.add_argument("--slug", required=True, help="local card slug")
    p.add_argument("--project", required=True, help="YouTrack project shortName, e.g. RIN")
    p.add_argument("--summary", required=True, help="issue title (one line)")
    p.set_defaults(func=cmd_post)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
