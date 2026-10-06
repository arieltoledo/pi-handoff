# Release checklist

For a future release. This checklist does not publish, tag, or push automatically.

- [ ] Confirm the intended version in `package.json`, `package-lock.json`, and `CHANGELOG.md`.
- [ ] Confirm release notes describe shipped behavior only.
- [ ] Verify `LICENSE` and the `package.json` license metadata are present and aligned.
- [ ] Start from a clean working tree and inspect the final diff.
- [ ] Run `npm test`, `npm run typecheck`, and `git diff --check`.
- [ ] Run `pi-handoff doctor` with a supported Pi installation.
- [ ] Run `npm pack --dry-run` and inspect the included files.
- [ ] Manually validate `pi-handoff init`, `start`, and `update` in a disposable project.
- [ ] After owner review, commit and create the intended tag.
- [ ] Publish and create any hosted release only as a separately authorized step.
