# Changelog

## [Unreleased]

### Breaking Changes

- Replaced the action-based `seance` schema with an import-only contract: `sourceSession` is required; `name` and `model` are optional.

### Added

- Add import-only historical-session consultations with completed replies routed back to their sender.

### Changed

- Historical-session consultations reuse OMP's scout wake-turn monitor with terminal `yield` completion per IRC turn; the child remains available for follow-ups sent with the ordinary `write agent://<id>` and `wait` flow.

### Fixed

- Open the native searchable session picker for `/seance` with no arguments, scoped to the current folder with Tab for all projects; selection forks without resuming the source, switching the main session, or invoking a model.

- Resolve relative file reads in the historical source project; disclose an unavailable source directory instead of reading from the caller's project.
