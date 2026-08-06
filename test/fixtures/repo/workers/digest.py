"""Nightly digest worker. Still on a managed prompt object."""

DIGEST_PROMPT_ID = "pmpt_ghi789"


def build_request(items):
    return {
        "prompt": {"id": DIGEST_PROMPT_ID, "version": "4", "variables": {"items": items}},
    }
