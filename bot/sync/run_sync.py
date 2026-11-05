"""Entry point for GitHub Actions:  cd bot && python -m sync.run_sync"""
from __future__ import annotations

import logging
import os
import sys

from tbl_bot.storage import open_storage

from .notion_api import NotionClient
from .sync import Syncer


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    token = os.environ.get("NOTION_TOKEN")
    if not token:
        print("NOTION_TOKEN is not set", file=sys.stderr)
        return 2
    st = open_storage()
    if hasattr(st, "ensure_schema"):
        st.ensure_schema()
    rep = Syncer(NotionClient(token), st).run()
    print(f"pulled={rep.pulled} created={rep.created} pushed={rep.pushed} archived={rep.archived}")
    for e in rep.errors:
        print("ERROR", e, file=sys.stderr)
    if hasattr(st, "close"):
        st.close()
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
