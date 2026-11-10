# Ebbing Context

[![test](https://github.com/Light-EI/dsh-ebbing-context/actions/workflows/test.yml/badge.svg)](https://github.com/Light-EI/dsh-ebbing-context/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文](README.md) | **English**

**A layered context-compaction plugin for DSH that simulates memory decay.**

The model decides where to compress and writes the summaries itself; the plugin only writes session events the host already understands, degrading old content step by step into coarser representations:

```
raw text (verbatim) → L1 block (conclusions and data of a span) → L2 block → L3 block (keywords and sentences only)
```

The older it is, the coarser it gets — but **nothing is ever deleted**. The raw text stays in the session log, and with the "session search" plugin installed it can be retrieved by event number.

`ebbing` means "fading away": whether to compress, and how far, is the model's own decision under context pressure — not a scheduled job.

> **Status**: feature-complete, all tests green, and compaction has run on a real machine. What is missing is a **reproducible verification record** — the maps, logs and before/after comparisons were not archived. Target host: DSH 0.2.1-rc.3 ~ 0.2.2-alpha.2. Back up your profile first and try it in a fresh session.
> Per-version changes: [CHANGELOG](CHANGELOG.md).

---

## How it works

- **Two tools + one command**: `context_map` (layer structure and usage), `compress` (perform one compaction), `/context-status` (read-only, same map).
- **Key name = the layer to compress**: `l0` compresses raw text → L1 blocks; `l1` compresses L1 → L2; `l2` compresses L2 → L3; `l3` folds the whole L3 region into one block (the only key without `to`).
- **`to` must be copied from the map**: `l0` takes a turn number (`T` + the real turn from the map); `l1`/`l2` take the 1-based block index within that region. A wrong value is rejected, and the rejection carries a refreshed map.
- **Cascade**: when compressing a deeper layer, every shallower layer that can still be compressed must be given in the same batch, otherwise the whole batch is rejected (the prefix cache is invalidated only once).
- **Zero ledger**: no database, no state files; layers are recomputed from the session surface every turn, and a block's identity is its first line `〔L1｜T16–T19｜ev 4121–4390〕title`.
- **Reminds, never acts**: when usage hits the line, grows a lot, or a layer exceeds its quota, it wakes the model at the end of the turn with a fresh map. It never compresses by itself and never pushes you toward `/compact`.

The full design (layer model, cascade, protection boundaries, configuration, host contracts, limitations) is in [docs/SPEC.md](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md) (currently in Chinese).

---

## Install

> Published on npm: `dsh plugin add dsh-ebbing-context` (or `npm install dsh-ebbing-context`). The two methods below still work.

**Method 1: from npm (recommended)**

```bash
dsh plugin add dsh-ebbing-context
```

**Method 2: from a source checkout**

```bash
git clone https://github.com/Light-EI/dsh-ebbing-context.git
dsh plugin add ./dsh-ebbing-context
```

**Method 3: mount into the profile manually**

1. Put the repository contents into the profile's `node_modules/dsh-ebbing-context/`
2. Add a `dsh-ebbing-context:` line to the profile's `cordis.patch.yml` (path rules are in [docs/SPEC.md](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md), section "directory and development")
3. Restart DSH

After installing, confirm three things: the plugin card shows **running**, both `context_map` / `compress` tools are present, and `/context-status` renders the map.

**Uninstall** (`dsh plugin remove dsh-ebbing-context` leaves two more steps):

1. Open the profile's `cordis.patch.yml` and delete the `dsh-ebbing-context` section (including any `config` you changed in the panel). If you leave it, every start prints a warning on stderr about a patch pointing at a missing entry — harmless, but it keeps printing.
2. The log lives at `$DSH_HOME/logs/ebbing-context.log` (plus `.1` / `.2` when rotated). Uninstalling does not delete it; remove it manually once you no longer need it for troubleshooting.
**Recommended: turn off the host's built-in auto-compaction** (`compaction-basic`'s `auto`, triggered at 80% by default). Once it fires it re-flattens the layered summaries and the layered structure is gone (the original text is still in the session log and can be read back by event number). The plugin still compresses, just with a discount. Where to turn it off depends on your install method and preset.

---

## Configuration

17 items (`triggerPct`, `keepTurns`, `pruneFirst`, `foldCallRecord`, `requireSessionQuery`, `reservedTokens`, `budget.*`, `segment.*`, `title.maxTokens`, `notice.*`), edited in Settings → Ebbing Context (the dedicated settings page) or the plugin row's detail page; changes take effect only after you click "Save".

Defaults, meanings and rejection rules are in [docs/SPEC.md section 6](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md#6-配置17-项) (Chinese).

---

## Dependencies and boundaries

- Requires the host to provide `agent/pre-step`, `agent/turn-stopping`, `agent/followup` and the session-surface API.
- By default it requires a "session search" tool (`session_event_read` / `session_event_search`); if the raw text cannot be retrieved, compression is disabled.
- It only performs paired replacements or edits the body of a `tool/result`; it never deletes a single node.
- No network, no file reads, no telemetry.

## Known limitations

- Parallel tool calls are not folded (and their results are not rewritten); the summary body stays in the context as an argument (the plugin may suggest sending it separately later).
- Folding happens only before the next request goes out; a call that misses that window is not folded, and its record stays as is.
- Images cannot be retrieved; they are counted by number only.
- If the turn outline is corrupt (the log is missing a `turn/start` or out of order), that turn reports a red error and is disabled.
- Region usage is self-estimated by the plugin (about 0.6 token per Chinese character, 0.3 per English character); it tracks the host's meter closely but can differ by a few percent.

## License

MIT.

## Contributing

Issues / PRs are welcome. Before you start, read the "host contracts" section of [docs/SPEC.md](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md); those contracts are the precondition for correctness.
