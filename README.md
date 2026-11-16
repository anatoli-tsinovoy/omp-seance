# omp-seance

`omp-seance` adds read-only session consultants to OMP. It forks a saved session into a read-only child, registers it as a live Agent Hub child, and uses OMP's scout wake-turn monitor to route completed answers back to their sender.

## Requirements

- OMP 18.20.3 or newer
- Bun 1.4.4 or newer

## Install

```sh
omp plugin install github:anatoli-tsinovoy/omp-seance
```

## Use

With no arguments in the interactive TUI, `/seance` opens the native searchable session picker, scoped to the current folder. Use the arrow keys and Enter to select a source, Tab to search all projects, or Esc to cancel. The selected session is forked into an idle consultant, not resumed; the current session remains active, and selecting or attaching alone does not invoke a model. For advanced or automated use, `/seance <id-or-JSONL-path>` still attaches an idle consultant; the entire argument is accepted as a path, including spaces. There is no `current` alias, and the current session cannot be used as a source.

Loading the plugin advertises the `seance` tool and its consultation instructions to the main model through the tool catalog; it does not inject a separate system-prompt paragraph.

The tool is import-only: `sourceSession` is required, while `name` and `model` are optional. Each call returns metadata for an idle child and does not invoke the consultant model.

After importing, send questions with the ordinary `write` tool to `agent://<id>` and then use `wait`. Reuse the same child ID for follow-ups.

The source can be a JSONL path (including `~` paths), a known live registry ID, or a saved session ID/prefix. Saved IDs are resolved in the current project and then globally; ambiguous or missing sources are rejected. The caller and source must both have persistent session files. Current-session sources are rejected even when specified by ID or path. A source is also rejected if its canonical artifact directory contains the fork destination; this includes self and ancestor sources, with symlink aliases accounted for, to prevent copying an artifact tree into itself.

Consultants use the caller's current model by default. Set `model` to select an exact available provider/model identifier; an unavailable override does not silently fall back.

Relative file paths are resolved in the historical session's recorded working directory, not the caller's project. If that directory no longer exists, consultation uses an empty fallback directory and reports `sourceCwdAvailable: false`; the consultant is told not to treat that empty directory as evidence about the original project.

## Isolation and storage

The consultant is given only the read-only `read`, `grep`, and `glob` tools. It does not inherit ambient extensions, custom tools, hooks, MCP or LSP access, context files, skills, or rules. This is not an operating-system sandbox, and file reads are not confined to the source session or project: the consultant can read files available through OMP's file access.

The child transcript (`<consultant-id>.jsonl`) and a full copy of the source artifacts (`<consultant-id>/`) are stored under the caller session's artifact tree. The extension reuses OMP's scout wake-turn monitor and normal agent registry location; the child appears in Agent Hub, and no OMP core changes are required. The source session is not modified. Inherited spend starts at zero, so only the consultant's new work counts toward its own usage. Interrupted tool-call repair applies only to the fork; unresolved calls are never replayed. Attachment disposal does not delete its transcript or copied artifacts.

Attachments are runtime-scoped and disposed on session switch or shutdown. They are not restored after restart and do not support standard `task` resume; use IRC for follow-ups.

Inherited `history://` and `agent://` identifiers are not explicitly rebound to the historical source. Use concrete transcript or artifact paths when those short references are ambiguous.

## Development

```sh
bun install
bun check
bun test
```
