# Changelog

## [Unreleased]

### Breaking Changes

- Removed the legacy action-based operations; `seance` is spawn-only and requires `sourceSession`, with optional `name`, `model`, and `question`.

### Added

- Start a consultation immediately with an optional `question`; omit it or leave it blank to attach an idle child.
- Interactive `/seance` adds native model selection and a multiline question editor; Ctrl+Q or Ctrl+Enter submits, blank attaches idle, and canceling any dialog does not fork.

### Changed

- Allow installation on OMP 19 and newer.
- Historical-session consultations reuse OMP's scout wake-turn monitor with terminal `yield` completion per IRC turn; the child remains available for follow-ups sent with the ordinary `write agent://<id>` and `wait` flow.

### Fixed

- The no-argument `/seance` picker remains current-folder scoped (Tab searches all projects); source selection does not resume the source or switch the parent, and only a nonblank question invokes the consultant model.

- Resolve relative file reads in the historical source project; disclose an unavailable source directory instead of reading from the caller's project.
