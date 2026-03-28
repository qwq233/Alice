# Alice system commands live here.

- `irc`: IRC-like Telegram facade for system-level chat verbs (`say`, `reply`, `react`, `read`, `tail`, `who`, `topic`, `join`, `leave`)
- `self`: self-perception/memory commands (`feel`, `diary`, `note`) — routes to engine `self_*` instructions
- `engine`: bridge to engine-owned write instructions (non-self_ namespace)
- `ctl`: shell-native control flags (`expect-reply`, `stay`, `leave`, `silent`)
- `ask`: bridge to engine-owned read queries
- `alice-pkg`: Alice OS package manager (search, install, remove, upgrade, rollback)

System commands live beside installed app commands, but are engine-owned.
LLM-facing names should stay close to real chat client habits (`say`, `reply`, `react`, `read`).

Use `<command> --help` for usage details (citty auto-generated help).
