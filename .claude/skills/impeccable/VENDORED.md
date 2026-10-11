# Vendored: Impeccable

Source: https://github.com/pbakaus/impeccable at commit 6e802bd (skill version 4.5.0)
License: Apache 2.0 (see LICENSE and NOTICE.md in this folder)

Copied as the project-scope Claude Code install the upstream README describes
(`cp -r dist/claude-code/.claude your-project/`), taken from upstream's committed
`.claude/` build: this skill folder plus the four `impeccable-*` subagents in
`.claude/agents/`.

Left out on purpose: upstream's `.claude/settings.json`, which registers
SessionStart, PostToolUse and Stop hooks that run the Impeccable engine on every
session and edit. Turn them on later with `/impeccable hooks on` if wanted.

`scripts/impeccable` is a launcher that runs only when the skill calls it. On
first use it downloads the engine binary from upstream's GitHub releases into
`~/.impeccable/bin/` and refuses to run it unless its SHA-256 sidecar matches.
If that fails, the skill falls back to reading PRODUCT.md and DESIGN.md directly.

To update: re-copy `.claude/skills/impeccable` and `.claude/agents/impeccable-*.md`
from a newer upstream commit and bump the commit above.
