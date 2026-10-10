# claude-mods

Personal Claude Code mods, published as a single plugin marketplace (`eduardo-mods`).

| Plugin | Description |
| --- | --- |
| [clean-view](plugins/clean-view) | Hides tool calls and shows a calm checklist above the prompt (plan, current step, progress), in Catppuccin colors. Toggle with `/simple on\|off` or the band's button |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install clean-view --marketplace eduardopicolli/claude-mods
```

Answer `y` to add the marketplace, then pick the **user** scope. The plugin is active right away and in every later session.

The repository is private: the machine needs GitHub access to it (e.g. `gh auth login`).

Or from a local clone:

```
/plugin install clean-view --marketplace ~/claude-mods
```

## Update

```bash
claude plugin update clean-view@eduardo-mods
```

then `/reload-plugins` in the session.

## Developing

Add the local clone as a marketplace; plugins with a relative `source` are read straight from this folder, so an edit only needs `/reload-plugins`:

```bash
claude plugin marketplace add ~/claude-mods
```

Check and test a plugin:

```bash
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```

## Adding a plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/register.tsx`.
2. Add `{ "name": "<name>", "source": "./plugins/<name>" }` to `plugins` in `.claude-plugin/marketplace.json`.
3. Add a row to the table above.
