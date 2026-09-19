# Model Router Agent Rules

## Default local-project workflow

- When the task concerns this repository or another local project and WebCodex is available, use WebCodex first.
- Do not ask the user to upload files that already exist on the Runner-accessible machine.
- Reuse the existing WebCodex Project / Workflow Session when available.
- If a local path is not currently registered, first try to resolve or register it through WebCodex instead of asking the user to copy files.
- Preserve unrelated changes. Inspect Git status before broad edits.
- For actionable coding/release work, execute the work; do not replace execution with a long instruction list.

## Verification

- Never claim a test, build, package, push, CI run, notarization, release, or download check passed unless it actually ran.
- Prefer narrow checks first, then full project checks before release.
- Before release, require a clean/explained worktree and `git diff --check`.

## Release

- For macOS/public desktop releases, follow `skills/macos-release/SKILL.md`.
- Developer ID and notarytool credentials must be consumed from the macOS Keychain/profile; never print private keys or passwords.
- Final macOS public assets must be notarized/stapled when a valid profile is available.
- Windows packages must be validated on a real `windows-latest` CI runner before public release.

## Product naming

- User-facing product name: `Model Router`
- Chinese name: `模型路由助手`
- GitHub repository: `shiftshen/model-router`
- Old internal identifiers such as `local.shift.codex-model-assistant`, `~/.codex/model-assistant`, and legacy migration paths remain only for compatibility unless a migration plan explicitly changes them.
