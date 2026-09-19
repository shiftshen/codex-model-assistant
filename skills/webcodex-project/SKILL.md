---
name: webcodex-project
description: Automatically use this skill when the user asks to inspect, edit, continue, build, test, package, push, release, or otherwise work on a local software project that is accessible through WebCodex. Prefer direct WebCodex execution over asking the user to upload or repeat local files.
---

# WebCodex Local Project Operator

Use this skill by default for local software-project work when WebCodex is available.

## Core rule

If the requested source, build output, local path, Git repository, signing environment, or release workflow exists on the user's Runner-accessible machine, **use WebCodex to work on it directly**.

Do not first ask the user to:

- upload a project archive,
- paste files already on disk,
- repeat paths already known,
- manually run commands that WebCodex can run,
- relay Git/CI status that WebCodex can verify.

## Start of task

1. Reuse an existing WebCodex Project and Workflow Session when the project is already known.
2. Read `AGENTS.md` / project instructions if present.
3. Check Git status before non-trivial edits.
4. Read only the files needed for the next decision.
5. If the user supplied a local path, try WebCodex project resolution/registration before declaring it inaccessible.

If a path is outside the Runner's allowed roots:

1. Check whether that project is already registered on the Runner.
2. Use the registered Project if available.
3. Only ask the user for intervention when WebCodex genuinely cannot access or register the path.

## Editing

- Prefer `read_files` / `search_project_texts` for inspection.
- Prefer precise edit tools for source changes.
- Use `run_process` for one executable with literal arguments.
- Use `run_shell` only when shell semantics materially help.
- Keep edits scoped and preserve unrelated work.
- Do not treat attempted/failed edits as applied; verify real Git status.

## Build and verification

For project work, verify in increasing scope:

1. syntax/type/lint checks for changed files,
2. focused tests,
3. full relevant test suite,
4. build/package,
5. platform-specific CI or smoke test when applicable.

Never claim success from source inspection alone.

## Git and GitHub

When the user has already authorized project completion/release:

- commit verified work,
- push the intended branch,
- verify `HEAD` and `origin/<branch>` alignment,
- create/push tags only after release gates pass,
- verify GitHub Actions to terminal success,
- verify release assets are publicly downloadable.

Do not expose GitHub tokens. If Git credentials are stored in Keychain, they may be used only inside the execution process and must never be printed.

## macOS release

For public macOS desktop releases, also use the `macos-release` skill.

## Completion standard

A task is not complete because code was edited. It is complete when the requested user-visible outcome exists and the strongest practical verification has passed.

Final report should state:

- what changed,
- what was actually verified,
- commit/tag/release identifiers when relevant,
- any real remaining limitation.

Do not ask the user to repeat information that WebCodex can recover from the project, Runner, Git, or prior workflow state.
