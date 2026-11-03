"""Fast Prompt Autocomplete plugin for Hermes Agent."""

from __future__ import annotations


def register(ctx) -> None:
    """Register the `prompt_autocomplete` auxiliary task slot for fast small-model completions."""
    ctx.register_auxiliary_task(
        "prompt_autocomplete",
        display_name="Prompt Autocomplete",
        description="Fast small-model sentence continuation for the Hermes Desktop prompt composer.",
        defaults={
            "provider": "auto",
            "model": "qwen/qwen-2.5-7b-instruct",
            "timeout": 4,
            "extra_body": {},
        },
    )
