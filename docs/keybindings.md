# Keybindings

Run `/hotkeys` inside an `omp` session to see the active chords for your current build. The list reflects any remaps loaded from disk and any bindings added by extensions.

## Customize keybindings

User remaps live in `~/.omp/agent/keybindings.yml`. The file is a YAML mapping whose keys are keybinding action IDs and whose values are either one chord string or an array of chord strings. It is not read from `~/.omp/agent/config.yml`, and there is no nested `keybindings` object.

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Alt+P
app.plan.toggle: Alt+Shift+P
```

Chord names are case-insensitive and use the same notation shown in the UI, such as `Ctrl+P`, `Alt+Shift+P`, `Shift+Enter`, and `Ctrl+Backspace`.

Set an action to an empty array to disable it:

```yaml
app.stt.toggle: []
```

## Common action IDs

| Action ID                   | Default                                | Meaning                                       |
| --------------------------- | -------------------------------------- | --------------------------------------------- |
| `app.model.cycleForward`    | `Ctrl+P`                               | Cycle role models forward                     |
| `app.model.cycleBackward`   | `Shift+Ctrl+P`                         | Cycle role models in temporary mode           |
| `app.model.selectTemporary` | `Alt+P`                                | Pick a model temporarily for this session     |
| `app.model.select`          | `Ctrl+L`                               | Open the model selector and set roles         |
| `app.plan.toggle`           | `Alt+Shift+P`                          | Toggle plan mode                              |
| `app.history.search`        | `Ctrl+R`                               | Search prompt history                         |
| `app.tools.expand`          | `Ctrl+O`                               | Toggle tool-output expansion                  |
| `app.thinking.toggle`       | `Ctrl+T`                               | Toggle thinking-block visibility              |
| `app.thinking.cycle`        | `Shift+Tab`                            | Cycle thinking level                          |
| `app.editor.external`       | `Ctrl+G`                               | Edit the draft in `$VISUAL` / `$EDITOR`       |
| `app.message.followUp`      | `Ctrl+Enter`                           | Queue a follow-up message                     |
| `app.message.dequeue`       | `Alt+Up`                               | Dequeue a queued message back into the editor |
| `app.clipboard.copyLine`    | `Alt+Shift+L`                          | Copy the current line                         |
| `app.clipboard.copyPrompt`  | `Alt+Shift+C`                          | Copy the whole prompt                         |
| `app.clipboard.pasteImage`  | `Ctrl+V` (`Alt+V` fallback on Windows) | Paste an image from the clipboard             |
| `app.stt.toggle`            | `Alt+H`                                | Toggle speech-to-text recording               |

On Windows Terminal, `Ctrl+V` may be handled by the terminal paste command before `omp` sees it; use the `Alt+V` fallback when clipboard image paste appears to do nothing.

Older unqualified action names are migrated when `keybindings.yml` is loaded, but new docs and new configs should use the namespaced action IDs above. Existing `keybindings.json` files are still accepted and migrated to `keybindings.yml`; `keybindings.yaml` is also accepted.
