# #200 (spec docs/omarchy/SPEC.md §5.2): "the wedge demo" — turn a
# DEC-200-001 swatch-list document into a complete, valid Quattro
# `colors.toml` proposal (26 keys, spec §8.2). Local model, no network
# egress; hex + contrast correctors feed the repair loop rather than
# shipping an unreadable desktop.

class ThemePalette < GenModel
  # Local-first by convention (DEC-200-007).
  model :default
  system :theme_palette
  temperature 0.2
  max_tokens 1200

  budget per_run: { max_tokens: 2_000 }

  # Declare the output schema inline (RED-419). 26 keys total: 1 mode +
  # 25 colors, in spec §8.2 order. Note the asymmetry — no
  # `bright_orange` / `bright_brown` — that's the demo's teeth: a
  # free-form prompt invents them; a closed schema cannot.
  returns do
    field :mode, String, enum: %w[dark light]

    field :accent, String
    field :selection, String
    field :muted, String

    field :background, String
    field :dark_background, String
    field :darker_background, String
    field :lighter_background, String

    field :foreground, String
    field :dark_foreground, String
    field :light_foreground, String
    field :bright_foreground, String

    field :red, String
    field :yellow, String
    field :orange, String
    field :green, String
    field :cyan, String
    field :blue, String
    field :magenta, String
    field :brown, String

    field :bright_red, String
    field :bright_yellow, String
    field :bright_green, String
    field :bright_cyan, String
    field :bright_blue, String
    field :bright_magenta, String
  end

  # DEC-200-005: hex_normalize before contrast_floor — contrast math
  # requires canonical `#rrggbb`.
  corrects :hex_normalize
  corrects :contrast_floor

  def generate_palette(document)
    generate "assign extracted swatches to the Quattro theme role schema" do
      with context: document
    end
  end
end
