# #201 (docs/omarchy/SPEC.md §5.8): wedge demo B — turn "add a menu
# entry that opens my notes in Obsidian" into a typed, validated entry
# for `~/.config/omarchy/extensions/omarchy-menu.jsonc`. Entry *kind*
# (action / link / submenu) is inferred by Omarchy's own parser from
# which of `action`/`target` are set — a malformed entry silently
# becomes the wrong thing, and a file that fails to parse contributes no
# entries at all. `menu_model_check` runs the real vendored parser
# against the merged result rather than re-implementing its inference
# rules.
#
# SECURITY (informational, #201 audit): `action` / `when` / `checked` /
# `disabled` are live bash — Omarchy's real menu shells them out
# verbatim, outside this repo (see `vendor/omarchy/menu_model.cjs`'s
# `guardScript`, never called from here, for how). Propose-only is what
# makes this gen's output safe today: a human reads and applies the
# entry, so an untrusted/hallucinated command string is caught before
# it ever runs. This constraint is NOT enforced by any code in this
# gen or its corrector — `menu_model_check` only checks JSON shape and
# kind inference, never the content of a shell string. Anything that
# later auto-applies this output (skipping human review) MUST treat
# these four fields as untrusted shell text first.

class MenuEntry < GenModel
  # Local-first by convention (DEC-200-007 precedent).
  model :default
  system :menu_entry
  temperature 0.2
  max_tokens 500

  budget per_run: { max_tokens: 800 }

  # The Omarchy menu-item vocabulary (shell/plugins/menu/MenuModel.js
  # `normalizeItem`): `id` (dotted for nesting under an existing parent),
  # `label`, then EXACTLY ONE of `action` (a shell command) / `target` (a
  # URL or path) for a leaf entry — leaving both unset describes a
  # submenu container. `when` / `checked` / `disabled` are optional bash
  # condition strings.
  returns do
    field :id, String, description: "unique entry id; dotted (e.g. \"parent.child\") to nest under an existing parent id"
    field :label, String, description: "display text for the menu row"
    field :action, String, optional: true, description: "a shell command to run — set this XOR target, never both"
    field :target, String, optional: true, description: "a URL or filesystem path to open — set this XOR action, never both"
    field :when, String, optional: true, description: "bash condition; row is hidden unless it exits 0"
    field :checked, String, optional: true, description: "bash condition; row shows a checkmark when it exits 0"
    field :disabled, String, optional: true, description: "bash condition; row is disabled when it exits 0"
  end

  # Merges the proposal into the current overlay and runs Omarchy's own
  # vendored parser against the result (DEC-201-002) — error-severity
  # issues (parse failure, or both action/target set) feed the repair
  # loop.
  corrects :menu_model_check

  def propose_entry(document)
    generate "propose a single omarchy-menu.jsonc entry for the request" do
      with context: document
    end
  end
end
