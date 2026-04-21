# frozen_string_literal: true

require 'json'
require_relative './cron'    # RED-305: cron expression support

module Cambium
  class CompileError < StandardError; end

  # Engine-mode sentinel (RED-220 / RED-246). A directory containing
  # this file is an engine folder — discovery walks stop here and do
  # not climb back into a host project. Used by the compiler's
  # discovery helpers and by ModelAliases/MemoryPolicy (RED-287) to
  # refuse accidental pickup of an ancestor workspace's config.
  ENGINE_SENTINEL = 'cambium.engine.json'.freeze

  # Flatten the {slots:, sources:, packs:} accumulator (built by
  # _cambium_add_slots) into the IR-facing shape: the slot hash with
  # an optional `_packs` metadata field naming any policy packs that
  # contributed slots. Returns nil for an empty/missing accumulator so
  # downstream JSON omits the key.
  def self.flatten_slot_state(state)
    return nil if state.nil?
    slots = state['slots'] || {}
    return nil if slots.empty?
    out = slots.dup
    packs = state['packs'] || []
    out['_packs'] = packs unless packs.empty?
    out
  end

  # Used to represent unresolved constants in the DSL (e.g., `returns AnalysisReport`).
  class ConstRef
    attr_reader :name

    def initialize(name)
      @name = name
    end

    def to_s
      @name
    end
  end

  # Shared validation/normalization for security and budget shapes.
  # Used by the gen-side DSL methods AND by the policy-pack builder so
  # the two paths can never drift on what's accepted.
  module Normalize
    module_function

    # Return a hash of {slot_name => normalized_value} for the recognized
    # security slots (network/filesystem/exec). Raises on unknown keys.
    def security_slots(opts)
      slots = {}
      if (net = opts[:network] || opts['network'])
        raise ArgumentError, "security network: must be a Hash" unless net.is_a?(Hash)
        slots['network'] = {
          'allowlist'      => Array(net[:allowlist] || net['allowlist']),
          'denylist'       => Array(net[:denylist]  || net['denylist']),
          'block_private'  => net.fetch(:block_private)  { net.fetch('block_private',  true) },
          'block_metadata' => net.fetch(:block_metadata) { net.fetch('block_metadata', true) },
        }
      end
      if (fs = opts[:filesystem] || opts['filesystem'])
        raise ArgumentError, "security filesystem: must be a Hash" unless fs.is_a?(Hash)
        slots['filesystem'] = { 'roots' => Array(fs[:roots] || fs['roots']) }
      end
      if (ex = opts[:exec] || opts['exec'])
        slots['exec'] = normalize_exec(ex)
      end
      unknown = opts.keys.map(&:to_s) - %w[network filesystem exec]
      raise ArgumentError, "unknown security keys: #{unknown.join(', ')}" unless unknown.empty?
      slots
    end

    # RED-248: Normalize the `security exec:` slot. Accepts two shapes:
    #
    #   Legacy (back-compat):
    #     security exec: { allowed: true }
    #   Resolves to { 'allowed' => true, 'runtime' => 'native' }.
    #   The :native substrate is the deprecated fig-leaf path; gens
    #   using this shape run unsandboxed with a stderr warning emitted
    #   at runtime.
    #
    #   New (RED-213):
    #     security exec: {
    #       runtime: :wasm | :firecracker | :native,
    #       cpu: 0.5,            # cores, 0.1–4.0
    #       memory: 256,         # MB, 16–4096
    #       timeout: 30,         # seconds, 1–600
    #       network: :none | :inherit | { allowlist: [...] },
    #       filesystem: :none | :inherit | { allowlist_paths: [...] },
    #       max_output_bytes: 50_000,
    #     }
    #
    # Required in the new shape: `runtime`. Everything else has defaults
    # applied by the TS-side policy parser; compile-time validation
    # covers the ranges and enumerations authors commonly get wrong.
    KNOWN_EXEC_KEYS     = %w[allowed runtime cpu memory timeout network filesystem max_output_bytes].freeze
    KNOWN_EXEC_RUNTIMES = %w[wasm firecracker native].freeze

    def normalize_exec(ex)
      raise ArgumentError, "security exec: must be a Hash" unless ex.is_a?(Hash)
      ex_str = ex.transform_keys(&:to_s)
      unknown = ex_str.keys - KNOWN_EXEC_KEYS
      unless unknown.empty?
        raise ArgumentError,
              "unknown security exec keys: #{unknown.join(', ')} (allowed: #{KNOWN_EXEC_KEYS.join(', ')})"
      end

      out = { 'allowed' => ex_str.fetch('allowed', false) == true }

      if ex_str.key?('runtime')
        rt = ex_str['runtime'].to_s
        unless KNOWN_EXEC_RUNTIMES.include?(rt)
          raise ArgumentError,
                "security exec runtime: must be one of :#{KNOWN_EXEC_RUNTIMES.join(', :')}; got :#{rt}"
        end
        out['runtime'] = rt
      elsif out['allowed']
        # Back-compat: `{ allowed: true }` with no runtime → :native.
        # Emits a deprecation warning at runtime (RED-249).
        out['runtime'] = 'native'
      end

      # RED-249 strict-mode flag. When CAMBIUM_STRICT_EXEC=1, resolving
      # to :native is a hard compile error (rather than a runtime
      # warning). Off by default; opt-in for shops that want to block
      # the fig-leaf path across the board.
      if out['runtime'] == 'native' && ENV['CAMBIUM_STRICT_EXEC'] == '1'
        raise CompileError,
              "security exec runtime: :native is blocked by CAMBIUM_STRICT_EXEC=1. " \
              "Set runtime: :wasm or :firecracker explicitly."
      end

      if ex_str.key?('cpu')
        cpu = ex_str['cpu']
        unless cpu.is_a?(Numeric) && cpu >= 0.1 && cpu <= 4.0
          raise ArgumentError,
                "security exec cpu: must be a number in 0.1..4.0 (cores); got #{cpu.inspect}"
        end
        out['cpu'] = cpu.to_f
      end

      if ex_str.key?('memory')
        mem = ex_str['memory']
        unless mem.is_a?(Integer) && mem >= 16 && mem <= 4096
          raise ArgumentError,
                "security exec memory: must be an integer in 16..4096 (MB); got #{mem.inspect}"
        end
        out['memory'] = mem
      end

      if ex_str.key?('timeout')
        to = ex_str['timeout']
        # Require Integer (same as memory:) so `timeout: 30.9` doesn't
        # silently truncate to 30. Fractional seconds aren't a pattern
        # we expect; if they become one we can add them explicitly.
        unless to.is_a?(Integer) && to >= 1 && to <= 600
          raise ArgumentError,
                "security exec timeout: must be an integer in 1..600 (seconds); got #{to.inspect}"
        end
        out['timeout'] = to
      end

      if ex_str.key?('network')
        out['network'] = normalize_exec_scoped('network', ex_str['network'])
      end

      if ex_str.key?('filesystem')
        out['filesystem'] = normalize_exec_scoped('filesystem', ex_str['filesystem'])
      end

      if ex_str.key?('max_output_bytes')
        mob = ex_str['max_output_bytes']
        unless mob.is_a?(Integer) && mob.positive?
          raise ArgumentError,
                "security exec max_output_bytes: must be a positive integer; got #{mob.inspect}"
        end
        out['max_output_bytes'] = mob
      end

      out
    end

    # RED-248: normalize the per-call scoped `network:` / `filesystem:`
    # on `security exec:`. Accepts a sentinel symbol (`:inherit`, `:none`)
    # which stays as a string, or a Hash whose keys are stringified.
    # Inheritance resolution happens on the TS side at parse time;
    # this just normalizes the shape.
    def normalize_exec_scoped(field, value)
      case value
      when :inherit, 'inherit' then 'inherit'
      when :none,    'none'    then 'none'
      when Hash                then value.transform_keys(&:to_s)
      else
        raise ArgumentError,
              "security exec #{field}: must be :inherit, :none, or a Hash; got #{value.inspect}"
      end
    end

    # Return a hash of {slot_name => value} for the budget slots
    # (per_tool / per_run). Slot semantics chosen so the same per-slot
    # mixing rule used by `security` works for `budget`.
    def budget_slots(opts)
      allowed_metrics = %w[max_calls]
      slots = {}
      if (per_tool = opts[:per_tool] || opts['per_tool'])
        raise ArgumentError, "budget per_tool: must be a Hash" unless per_tool.is_a?(Hash)
        slots['per_tool'] = per_tool.each_with_object({}) do |(tool, limits), h|
          raise ArgumentError, "budget per_tool[#{tool}] must be a Hash" unless limits.is_a?(Hash)
          limits_str = limits.transform_keys(&:to_s)
          unknown = limits_str.keys - allowed_metrics
          raise ArgumentError, "unsupported budget metric(s) for #{tool}: #{unknown.join(', ')}" unless unknown.empty?
          h[tool.to_s] = limits_str
        end
      end
      if (per_run = opts[:per_run] || opts['per_run'])
        raise ArgumentError, "budget per_run: must be a Hash" unless per_run.is_a?(Hash)
        per_run_str = per_run.transform_keys(&:to_s)
        unknown = per_run_str.keys - allowed_metrics
        raise ArgumentError, "unsupported budget metric(s) for per_run: #{unknown.join(', ')}" unless unknown.empty?
        slots['per_run'] = per_run_str
      end
      unknown = opts.keys.map(&:to_s) - %w[per_tool per_run]
      raise ArgumentError, "unknown budget keys: #{unknown.join(', ')}" unless unknown.empty?
      slots
    end
  end

  # A loaded policy pack — read from app/policies/<name>.policy.rb.
  # Holds named exports (security and budget) that gens can pull in by
  # symbol via `security :pack_name` / `budget :pack_name`.
  class PolicyPack
    attr_reader :name, :exports

    def initialize(name)
      @name = name.to_s
      @exports = { 'security' => {}, 'budget' => {} }
    end

    # Return the set of slots for the requested export, or nil if the
    # pack didn't declare anything in that group.
    def export(group)
      slots = @exports[group.to_s]
      slots.nil? || slots.empty? ? nil : slots
    end

    # Resolve a pack name to a file in one of the search dirs, eval it
    # inside a PolicyPackBuilder, return the populated PolicyPack.
    def self.load(name, search_dirs)
      # Restrict pack names to a safe identifier shape so a Symbol like
      # `:"../secret"` can't be interpolated into a path that escapes
      # the policies dir. Compile-time on trusted source, but cheap to
      # harden — the check matches the implicit assumption elsewhere
      # (system: + tool: names follow the same convention).
      name_str = name.to_s
      unless name_str =~ /\A[a-z][a-z0-9_]*\z/
        raise CompileError,
              "Invalid policy pack name '#{name}'. Pack names must be lowercase " \
              "identifiers matching /\\A[a-z][a-z0-9_]*\\z/ (e.g. :research_defaults)."
      end

      candidates = search_dirs.map { |d| File.join(d, "#{name_str}.policy.rb") }
      file = candidates.find { |f| File.exist?(f) }
      if file.nil?
        raise CompileError,
              "Policy pack '#{name}' not found. Looked for:\n  " + candidates.join("\n  ")
      end

      pack = new(name)
      builder = PolicyPackBuilder.new(pack)
      begin
        builder.instance_eval(File.read(file), file)
      rescue CompileError
        raise # already structured — preserve as-is
      rescue ScriptError, StandardError => e
        raise CompileError,
              "Failed to load policy pack '#{name}' from #{file}: " \
              "#{e.class}: #{e.message}"
      end
      pack
    end
  end

  # RED-237: workspace-configurable model aliases — one file per
  # workspace at `app/config/models.rb` mapping symbolic names like
  # `:default` / `:fast` / `:embedding` to literal provider:model
  # ids. Gens and pools reference aliases by symbol
  # (`model :default`, `embed: :embedding`); the compiler resolves
  # them to literals before emitting IR so the runner always sees
  # a concrete `"omlx:name"` string.
  #
  # File syntax is flat, same convention as `.policy.rb` and
  # `.pool.rb` — each line is `<name> "<literal>"`:
  #
  #   default   "omlx:Qwen3.5-27B-4bit"
  #   fast      "omlx:gemma-4-31b-it-8bit"
  #   embedding "omlx:bge-small-en"
  #
  # A workspace with no `app/config/models.rb` is valid; gens that
  # only reference literals (never a Symbol) work identically. Only
  # gens that reference a Symbol require the file, and an undefined
  # alias raises a clear CompileError listing the available names.
  class ModelAliases
    NAME_RE = /\A[a-z][a-z0-9_]*\z/

    attr_reader :aliases, :source_file

    def initialize(aliases, source_file)
      @aliases = aliases
      @source_file = source_file
    end

    def lookup(name)
      @aliases[name.to_s]
    end

    def keys
      @aliases.keys
    end

    def self.search_candidates(source_file)
      # RED-287: engine-mode gens do not pull config from an ancestor
      # workspace. A cambium.engine.json sentinel next to the gen
      # suppresses the walk-up; the engine folder owns its own model
      # choices (and doesn't currently ship a models.rb of its own —
      # aliases are a workspace-level concept).
      if source_file && File.exist?(File.join(File.dirname(File.expand_path(source_file)), Cambium::ENGINE_SENTINEL))
        return []
      end
      candidates = []
      if source_file
        pkg_dir = File.dirname(File.dirname(File.expand_path(source_file)))
        candidates << File.join(pkg_dir, 'app', 'config', 'models.rb')
      end
      candidates << File.join('packages', 'cambium', 'app', 'config', 'models.rb')
      candidates.uniq
    end

    # Load the workspace's model aliases. Returns an empty ModelAliases
    # if no file is present — not an error; a workspace using only
    # literals doesn't need the file.
    def self.load
      src = Cambium::CompilerState.current_source_file
      file = search_candidates(src).find { |f| File.exist?(f) }
      return new({}, nil) if file.nil?

      builder = ModelAliasesBuilder.new
      begin
        builder.instance_eval(File.read(file), file)
      rescue CompileError
        raise
      rescue ScriptError, StandardError => e
        raise CompileError,
              "Failed to load model aliases from #{file}: #{e.class}: #{e.message}"
      end
      new(builder.aliases, file)
    end

    # Resolve a user-supplied model reference into a literal string.
    # Rules:
    #   - Already-literal (contains `:`) — pass through unchanged.
    #   - String without `:` — treated as an alias name; must be defined.
    #   - Symbol — alias name; must be defined.
    # Raises CompileError with the available alias list on miss.
    def resolve(ref, context:)
      case ref
      when Symbol
        resolve_symbol(ref, context)
      when String
        ref.include?(':') ? ref : resolve_symbol(ref.to_sym, context)
      when nil
        nil
      else
        raise CompileError,
              "#{context}: model reference must be a String or Symbol (got #{ref.class})"
      end
    end

    private

    def resolve_symbol(sym, context)
      name = sym.to_s
      hit = @aliases[name]
      return hit if hit

      avail = @aliases.keys.sort
      hint = avail.empty? ? " (no aliases defined — create app/config/models.rb)" : ""
      raise CompileError,
            "#{context}: unknown model alias :#{name}. " \
            "Available: [#{avail.join(', ')}]#{hint}" \
            "#{@source_file ? " (from #{@source_file})" : ''}"
    end
  end

  # Eval context for `app/config/models.rb`. Each top-level call like
  # `default "omlx:..."` captures a (name, literal) pair into the
  # builder's aliases dict. Uses method_missing so the set of alias
  # names is open — the file owner picks them — while still enforcing
  # the identifier-shape regex so a Symbol ref can't interpolate into
  # anything surprising.
  class ModelAliasesBuilder
    attr_reader :aliases

    def initialize
      @aliases = {}
    end

    def method_missing(name, *args, **kwargs)
      unless args.length == 1 && kwargs.empty?
        super
        return
      end
      literal = args[0]
      unless literal.is_a?(String)
        raise CompileError,
              "model alias :#{name} must map to a String literal (got #{literal.class})"
      end
      name_str = name.to_s
      unless name_str =~ ModelAliases::NAME_RE
        raise CompileError,
              "model alias name :#{name} must match #{ModelAliases::NAME_RE.inspect}"
      end
      if @aliases.key?(name_str)
        raise CompileError, "duplicate model alias :#{name_str} in models.rb"
      end
      @aliases[name_str] = literal
    end

    def respond_to_missing?(_name, _include_private = false)
      true
    end
  end

  # RED-239: parse and normalize `retain:` values into a canonical
  # IR hash. Accepted forms:
  #
  #   retain: "30d"                         # duration string → ttl_seconds
  #   retain: { max_entries: 1000 }         # entry cap only
  #   retain: { ttl: "7d", max_entries: 500 }  # both
  #
  # Always emits `{ "ttl_seconds" => Integer? , "max_entries" => Integer? }`
  # — whichever keys were set. The runner's prune path then reads one
  # or both keys without having to re-parse duration strings.
  module Retention
    module_function

    DURATION_RE = /\A(\d+)([smhdw])\z/
    UNIT_SECONDS = { 's' => 1, 'm' => 60, 'h' => 3600, 'd' => 86_400, 'w' => 604_800 }.freeze
    ALLOWED_HASH_KEYS = %w[ttl max_entries].freeze

    def parse(value, context:)
      case value
      when nil
        nil
      when String
        ttl_seconds = parse_duration!(value, context: context)
        { 'ttl_seconds' => ttl_seconds }
      when Integer
        raise ArgumentError,
              "#{context}: bare integer retain (#{value}) is ambiguous. " \
              "Use retain: \"#{value}s\" for a TTL or retain: { max_entries: #{value} } for a cap."
      when Hash
        str_keys = value.transform_keys(&:to_s)
        unknown = str_keys.keys - ALLOWED_HASH_KEYS
        unless unknown.empty?
          raise ArgumentError,
                "#{context}: unknown retain key(s) #{unknown.join(', ')}. " \
                "Allowed: #{ALLOWED_HASH_KEYS.join(', ')}."
        end
        out = {}
        if str_keys['ttl']
          out['ttl_seconds'] = parse_duration!(str_keys['ttl'], context: "#{context} ttl")
        end
        if (cap = str_keys['max_entries'])
          unless cap.is_a?(Integer) && cap > 0
            raise ArgumentError,
                  "#{context} max_entries must be a positive Integer (got #{cap.inspect})."
          end
          out['max_entries'] = cap
        end
        raise ArgumentError, "#{context}: retain hash must set at least one of #{ALLOWED_HASH_KEYS.join(', ')}." if out.empty?
        out
      else
        raise ArgumentError,
              "#{context}: retain must be a duration string (e.g. \"30d\") or a hash " \
              "(got #{value.class})."
      end
    end

    # Upper bound on retain TTLs. Ten years in seconds. Protects the TS
    # prune path — `Date.now() - ttl_seconds * 1000` exceeds
    # Number.MAX_SAFE_INTEGER for values above ~285000 years and crashes
    # with RangeError on `toISOString()`. Ten years is comfortably under
    # that and covers every legitimate retention period. Tighten the cap
    # if a stricter policy is ever needed; don't loosen without also
    # widening the TS arithmetic.
    MAX_TTL_SECONDS = 10 * 365 * 86_400

    def parse_duration!(str, context:)
      m = str.match(DURATION_RE)
      unless m
        raise ArgumentError,
              "#{context}: duration '#{str}' must match /\\A\\d+[smhdw]\\z/ " \
              "(e.g. \"30d\", \"7h\", \"90m\")."
      end
      seconds = m[1].to_i * UNIT_SECONDS[m[2]]
      if seconds <= 0
        raise ArgumentError,
              "#{context}: duration '#{str}' must be positive (got #{seconds}s). " \
              "A zero TTL would silently no-op at runtime."
      end
      if seconds > MAX_TTL_SECONDS
        raise ArgumentError,
              "#{context}: duration '#{str}' (#{seconds}s) exceeds the 10-year cap. " \
              "Ten years is the maximum supported retention. Shorten the duration or " \
              "delete the bucket manually for longer-term storage."
      end
      seconds
    end
  end

  # RED-239 v2: workspace-level memory policy. One file per workspace
  # at `app/config/memory_policy.rb`, loaded at compile time and
  # enforced against every memory decl + resolved pool in the IR.
  # Parallel to RED-237's ModelAliases (workspace-wide model aliases)
  # but for constraints rather than names.
  #
  # File syntax is flat directives:
  #
  #   max_ttl        "90d"              # enforce: no retain > 90d
  #   default_ttl    "30d"              # apply: gens without retain get this
  #   max_entries    10_000             # enforce: no bucket over 10k rows
  #   require_keyed_by_for scope: :global  # enforce: global scope needs keyed_by
  #   ban_scope      :global            # enforce: :global scope disallowed
  #   allowed_pools  :support_team, :billing  # enforce: pool allowlist
  #
  # A workspace with no `app/config/memory_policy.rb` is valid — v1
  # retention (per-decl) still works. The policy layer is opt-in.
  #
  # Policy is enforced at compile time only; there is no per-gen
  # override mechanism. If an author needs an exception, they edit
  # the policy file. This matches the RED-214 policy-pack stance:
  # policy is policy.
  class MemoryPolicy
    attr_reader :source_file, :rules

    def initialize(rules, source_file)
      @rules = rules
      @source_file = source_file
    end

    def self.search_candidates(source_file)
      # RED-287: same engine-suppression stance as ModelAliases — an
      # engine folder owns its own memory discipline and doesn't pull
      # policy from an ancestor workspace.
      if source_file && File.exist?(File.join(File.dirname(File.expand_path(source_file)), Cambium::ENGINE_SENTINEL))
        return []
      end
      candidates = []
      if source_file
        pkg_dir = File.dirname(File.dirname(File.expand_path(source_file)))
        candidates << File.join(pkg_dir, 'app', 'config', 'memory_policy.rb')
      end
      candidates << File.join('packages', 'cambium', 'app', 'config', 'memory_policy.rb')
      candidates.uniq
    end

    def self.load
      src = Cambium::CompilerState.current_source_file
      file = search_candidates(src).find { |f| File.exist?(f) }
      return new({}, nil) if file.nil?

      builder = MemoryPolicyBuilder.new
      begin
        builder.instance_eval(File.read(file), file)
      rescue CompileError
        raise
      rescue ScriptError, StandardError => e
        raise CompileError,
              "Failed to load memory policy from #{file}: #{e.class}: #{e.message}"
      end

      rules = builder.rules
      # Cross-rule consistency: default_ttl must not exceed max_ttl.
      if rules['default_ttl'] && rules['max_ttl'] && rules['default_ttl'] > rules['max_ttl']
        raise CompileError,
              "memory_policy.rb: default_ttl (#{rules['default_ttl']}s) exceeds max_ttl " \
              "(#{rules['max_ttl']}s). A default that violates the ceiling is a contradiction."
      end
      new(rules, file)
    end

    # Apply enforce+default rules to the set of resolved memory decls
    # and the pools they reference. Mutates the decls in place (to
    # inject defaults) and raises CompileError on any violation with
    # a precise pointer to the offending declaration.
    def apply!(decls, pools)
      return if @rules.empty?

      # ── Defaults ────────────────────────────────────────────────
      # default_ttl fills in retain.ttl_seconds on any decl (and any
      # resolved pool view) that didn't declare retention at all.
      if (default_ttl = @rules['default_ttl'])
        decls.each do |d|
          d['retain'] ||= { 'ttl_seconds' => default_ttl }
        end
      end

      # ── Enforce ─────────────────────────────────────────────────
      # Pools first: a pool-side retain violation should surface as
      # "memory_pool :support_team retain.*" rather than the decl-level
      # message a merged-in copy would produce. More useful error for
      # the pool author.
      pools.each do |name, slots|
        enforce_on_pool!(name, slots)
      end
      decls.each do |d|
        enforce_on_decl!(d)
      end
    end

    private

    def enforce_on_decl!(d)
      name = d['name']
      ctx = "memory '#{name}'"

      if @rules['ban_scope'] && d['scope'] == @rules['ban_scope'].to_s
        raise CompileError,
              "#{ctx}: scope :#{d['scope']} is banned by workspace policy (#{@source_file})."
      end

      if @rules['require_keyed_by_for'] &&
         d['scope'] == @rules['require_keyed_by_for'].to_s &&
         d['keyed_by'].nil?
        raise CompileError,
              "#{ctx}: scope :#{d['scope']} requires `keyed_by:` per workspace policy (#{@source_file}). " \
              "Declare keyed_by on the memory decl (or the pool, if scoped to one)."
      end

      if @rules['allowed_pools'] &&
         !%w[session global].include?(d['scope']) &&
         !@rules['allowed_pools'].include?(d['scope'])
        raise CompileError,
              "#{ctx}: scope :#{d['scope']} is not in the workspace pool allowlist " \
              "[#{@rules['allowed_pools'].join(', ')}] (#{@source_file})."
      end

      check_retain_bounds!(d['retain'], ctx) if d['retain']
    end

    def enforce_on_pool!(name, slots)
      ctx = "memory_pool :#{name}"
      check_retain_bounds!(slots['retain'], ctx) if slots['retain']
    end

    def check_retain_bounds!(retain, ctx)
      if (max_ttl = @rules['max_ttl']) && retain['ttl_seconds'] && retain['ttl_seconds'] > max_ttl
        raise CompileError,
              "#{ctx} retain.ttl_seconds (#{retain['ttl_seconds']}s) exceeds workspace " \
              "max_ttl (#{max_ttl}s) per #{@source_file}."
      end
      if (max_entries = @rules['max_entries']) && retain['max_entries'] && retain['max_entries'] > max_entries
        raise CompileError,
              "#{ctx} retain.max_entries (#{retain['max_entries']}) exceeds workspace " \
              "max_entries cap (#{max_entries}) per #{@source_file}."
      end
    end
  end

  # Eval context for `app/config/memory_policy.rb`. Each directive
  # captures one rule into the builder. Unknown directives raise via
  # method_missing so typos surface immediately instead of silently
  # no-op'ing.
  class MemoryPolicyBuilder
    attr_reader :rules

    VALID_SCOPES = %w[session global schedule].freeze

    def initialize
      @rules = {}
    end

    def max_ttl(duration)
      @rules['max_ttl'] = Retention.parse_duration!(duration, context: "memory_policy max_ttl")
    end

    def default_ttl(duration)
      @rules['default_ttl'] = Retention.parse_duration!(duration, context: "memory_policy default_ttl")
    end

    def max_entries(n)
      unless n.is_a?(Integer) && n > 0
        raise CompileError, "memory_policy max_entries must be a positive Integer (got #{n.inspect})."
      end
      @rules['max_entries'] = n
    end

    def ban_scope(sym)
      unless sym.is_a?(Symbol)
        raise CompileError, "memory_policy ban_scope must be a Symbol (got #{sym.class})."
      end
      @rules['ban_scope'] = sym.to_s
    end

    def require_keyed_by_for(**opts)
      scope = opts[:scope] || opts['scope']
      unless scope.is_a?(Symbol)
        raise CompileError,
              "memory_policy require_keyed_by_for must take `scope: :<name>` (got #{opts.inspect})."
      end
      @rules['require_keyed_by_for'] = scope.to_s
    end

    def allowed_pools(*names)
      if names.empty?
        raise CompileError, "memory_policy allowed_pools requires at least one pool name."
      end
      @rules['allowed_pools'] = names.map { |n|
        unless n.is_a?(Symbol)
          raise CompileError, "memory_policy allowed_pools entries must be Symbols (got #{n.class})."
        end
        n.to_s
      }
    end

    def method_missing(name, *_args, **_opts)
      raise CompileError,
            "memory_policy.rb: unknown directive `#{name}`. " \
            "Allowed: max_ttl, default_ttl, max_entries, ban_scope, require_keyed_by_for, allowed_pools."
    end

    def respond_to_missing?(_name, _include_private = false)
      false
    end
  end

  # RED-215: a loaded memory pool — read from
  # app/memory_pools/<name>.pool.rb. Named pools hold the "shared"
  # parts of a memory declaration (strategy, embed, keyed_by) so
  # multiple gens can opt in without duplicating the config.
  #
  # Per the decisions locked in the design note (doc ID
  # gen-dsl/primitives/memory): the pool is authoritative on
  # strategy/embed/keyed_by; referencing gens can only set reader
  # knobs (size, top_k). Any gen-side attempt to override a
  # pool-owned slot is a compile error. This mirrors the per-slot
  # mixing rule from RED-214.
  class MemoryPool
    # Slots the pool owns. A gen referencing the pool cannot set any
    # of these — they belong to the shared definition. Reader knobs
    # like `size` and `top_k` stay on the memory decl because they
    # vary per use site.
    POOL_OWNED_SLOTS = %w[strategy embed keyed_by retain].freeze

    attr_reader :name, :slots, :file

    def initialize(name)
      @name  = name.to_s
      @slots = {}
      @file  = nil
    end

    # Resolve a pool name to a file in one of the search dirs, eval
    # it inside a MemoryPoolBuilder, return the populated MemoryPool.
    def self.load(name, search_dirs)
      # Same safety regex as PolicyPack.load — a Symbol like
      # `:"../secret"` must not be interpolable into a path that
      # escapes the memory_pools dir. Compile-time on trusted source,
      # but cheap to harden.
      name_str = name.to_s
      unless name_str =~ /\A[a-z][a-z0-9_]*\z/
        raise CompileError,
              "Invalid memory pool name '#{name}'. Pool names must be lowercase " \
              "identifiers matching /\\A[a-z][a-z0-9_]*\\z/ (e.g. :support_team)."
      end

      candidates = search_dirs.map { |d| File.join(d, "#{name_str}.pool.rb") }
      file = candidates.find { |f| File.exist?(f) }
      if file.nil?
        raise CompileError,
              "Memory pool '#{name}' not found. Looked for:\n  " + candidates.join("\n  ")
      end

      pool = new(name)
      pool.instance_variable_set(:@file, file)
      builder = MemoryPoolBuilder.new(pool)
      begin
        builder.instance_eval(File.read(file), file)
      rescue CompileError
        raise # already structured — preserve as-is
      rescue ScriptError, StandardError => e
        raise CompileError,
              "Failed to load memory pool '#{name}' from #{file}: " \
              "#{e.class}: #{e.message}"
      end

      # After eval, every pool must at least declare a strategy so we
      # know how to read it. A semantic pool must additionally declare
      # an embed: model (alias or literal) — without it there's
      # nothing to embed with, and a latent error at first use is worse
      # than a clear one at compile time.
      if pool.slots['strategy'].nil?
        raise CompileError,
              "Memory pool '#{name}' at #{file} is missing `strategy`. " \
              "One of :sliding_window, :semantic, :log is required."
      end
      if pool.slots['strategy'] == 'semantic' && pool.slots['embed'].nil?
        raise CompileError,
              "Memory pool '#{name}' at #{file} declares strategy :semantic " \
              "but has no `embed` model. Add `embed \"omlx:bge-small-en\"` or `embed :embedding`."
      end

      pool
    end
  end

  # Eval context for .pool.rb files. Each directive captures one slot
  # on the MemoryPool. Mirrors PolicyPackBuilder's flat, filename-is-
  # the-name layout so an author working in one file type knows how
  # the other works.
  class MemoryPoolBuilder
    VALID_STRATEGIES = %w[sliding_window semantic log].freeze

    def initialize(pool)
      @pool = pool
    end

    def strategy(value)
      value_str = value.to_s
      unless VALID_STRATEGIES.include?(value_str)
        raise CompileError,
              "memory pool strategy must be one of #{VALID_STRATEGIES.map { |s| ":#{s}" }.join(', ')} " \
              "(got :#{value_str})"
      end
      @pool.slots['strategy'] = value_str
    end

    # Embedding model reference. Can be either a provider-prefix
    # literal (`"omlx:bge-small-en"`) or a bare symbol/string naming
    # a RED-237 alias (`:embedding`). Both forms serialize to a
    # string; the runner (phase 3+) resolves aliases via the model
    # alias table, and anything containing a `:` is treated as a
    # literal provider id.
    def embed(model)
      @pool.slots['embed'] = model.to_s
    end

    def keyed_by(key)
      @pool.slots['keyed_by'] = key.to_s
    end

    # RED-239: retention policy for this pool. Accepts a duration
    # string ("30d"), an entries cap ({max_entries: 1000}), or both
    # ({ttl: "7d", max_entries: 500}). Normalized into a canonical
    # `{ttl_seconds?, max_entries?}` hash at parse time so the IR
    # carries a single shape the TS runner can act on without
    # re-parsing.
    def retain(value)
      @pool.slots['retain'] = Retention.parse(value, context: "memory pool retain")
    end
  end

  # Eval context for .policy.rb files. Provides `network`, `filesystem`,
  # `exec`, and `budget` directives that capture into the PolicyPack's
  # exports. Validation is delegated to Normalize so pack-side and
  # gen-side accept the same shapes.
  class PolicyPackBuilder
    def initialize(pack)
      @pack = pack
    end

    def network(**opts)
      slots = Normalize.security_slots(network: opts)
      @pack.exports['security'].merge!(slots)
    end

    def filesystem(**opts)
      slots = Normalize.security_slots(filesystem: opts)
      @pack.exports['security'].merge!(slots)
    end

    def exec(**opts)
      slots = Normalize.security_slots(exec: opts)
      @pack.exports['security'].merge!(slots)
    end

    def budget(**opts)
      slots = Normalize.budget_slots(opts)
      @pack.exports['budget'].merge!(slots)
    end
  end

  # RED-282: named log profile bundling destinations + field configuration
  # + granularity. Gens reference a profile by symbol (`log :app_default`);
  # the compiler resolves it to fully-inlined destinations before IR
  # emission. Mirrors the PolicyPack + MemoryPool load/builder pattern.
  #
  # File layout: `app/log_profiles/<name>.log_profile.rb`. Each file eval'd
  # inside LogProfileBuilder. Name regex + realpath guards match the
  # RED-214/215 stance.
  class LogProfile
    attr_reader :name, :destinations, :includes, :granularity

    def initialize(name)
      @name = name.to_s
      @destinations = []
      @includes = []
      @granularity = 'run'
    end

    def self.load(name, search_dirs)
      name_str = name.to_s
      unless name_str =~ /\A[a-z][a-z0-9_]*\z/
        raise CompileError,
              "Invalid log profile name '#{name}'. Profile names must be lowercase " \
              "identifiers matching /\\A[a-z][a-z0-9_]*\\z/ (e.g. :app_default)."
      end

      candidates = search_dirs.map { |d| File.join(d, "#{name_str}.log_profile.rb") }
      file = candidates.find { |f| File.exist?(f) }
      if file.nil?
        raise CompileError,
              "Log profile '#{name}' not found. Looked for:\n  " + candidates.join("\n  ")
      end

      profile = new(name)
      builder = LogProfileBuilder.new(profile)
      begin
        builder.instance_eval(File.read(file), file)
      rescue CompileError
        raise
      rescue ScriptError, StandardError => e
        raise CompileError,
              "Failed to load log profile '#{name}' from #{file}: " \
              "#{e.class}: #{e.message}"
      end

      if profile.destinations.empty?
        raise CompileError,
              "Log profile '#{name}' at #{file} declares no destinations. " \
              "Add at least one `destination :name, ...` directive."
      end

      profile
    end
  end

  # Eval context for .log_profile.rb files. Provides `destination`,
  # `include`, and `granularity` directives. Matches the flat filename-
  # is-the-name layout of .policy.rb / .pool.rb so an author working
  # in one file type knows how the others work.
  class LogProfileBuilder
    VALID_INCLUDES = %w[signals output_summary tool_calls repair_attempts errors].freeze
    VALID_GRANULARITIES = %w[run step].freeze

    def initialize(profile)
      @profile = profile
    end

    # destination :datadog, endpoint: ENV["DD_URL"], api_key_env: "CAMBIUM_DATADOG_API_KEY"
    # destination :stdout
    #
    # Destination name is NOT validated against a known set here —
    # plugin backends (RED-282 app/logs/<name>.log.ts) are unknown at
    # compile time. The runner validates at dispatch and errors clearly
    # if a name doesn't resolve to a registered sink.
    def destination(name, endpoint: nil, api_key_env: nil, **extra)
      unless extra.empty?
        raise CompileError,
              "destination #{name}: unknown option(s) #{extra.keys.join(', ')}. " \
              "Recognized: endpoint, api_key_env."
      end
      entry = { 'destination' => name.to_s }
      entry['endpoint']    = endpoint    unless endpoint.nil?
      entry['api_key_env'] = api_key_env unless api_key_env.nil?
      @profile.destinations << entry
    end

    # include :signals, :usage, :output_summary
    #
    # Opt into richer payload fields beyond the framework-always set
    # (run_id, ok, duration_ms, usage, trace_ref, etc.).
    def include(*fields)
      fields.each do |f|
        f_str = f.to_s
        unless VALID_INCLUDES.include?(f_str)
          raise CompileError,
                "log profile include: unknown field :#{f_str}. " \
                "Recognized: #{VALID_INCLUDES.map { |v| ":#{v}" }.join(', ')}."
        end
        @profile.includes << f_str unless @profile.includes.include?(f_str)
      end
    end

    # granularity :run | :step
    #
    # :run emits one event per run (default, lean). :step emits one
    # event per trace step, mirroring the C-Trace vocabulary. Step-level
    # is the opt-in firehose.
    def granularity(g)
      g_str = g.to_s
      unless VALID_GRANULARITIES.include?(g_str)
        raise CompileError,
              "log profile granularity: must be :run or :step (got :#{g_str})"
      end
      @profile.instance_variable_set(:@granularity, g_str)
    end
  end

  # Internal builder used while a GenModel method runs.
  class PlanBuilder
    attr_reader :steps

    def initialize
      @steps = []
    end

    def add(step)
      @steps << step
    end
  end

  module CompilerState
    def self.current_builder
      Thread.current[:cambium_builder]
    end

    def self.current_builder=(b)
      Thread.current[:cambium_builder] = b
    end

    def self.current_source_file
      Thread.current[:cambium_source_file]
    end

    def self.current_source_file=(f)
      Thread.current[:cambium_source_file] = f
    end
  end

  class GenModel
    class << self
      attr_reader :_cambium_defaults

      def inherited(sub)
        super
        Cambium::Registry.register_model_class(sub)
        sub.instance_variable_set(:@_cambium_defaults, {})
      end

      def model(id)
        _cambium_defaults[:model] = id
      end

      # Mode: :agentic enables multi-turn tool-use loop in generate.
      # Without it, generate is a single LLM call (default).
      def mode(m)
        _cambium_defaults[:mode] = m.to_s
      end

      # System prompt: symbol resolves to app/systems/<name>.system.md, string is inline.
      def system(prompt_or_name)
        _cambium_defaults[:system] = prompt_or_name
      end

      def temperature(v)
        _cambium_defaults[:temperature] = v
      end

      def max_tokens(v)
        _cambium_defaults[:max_tokens] = v
      end

      def returns(schema_const)
        # schema_const might be a constant; we store the symbol name
        _cambium_defaults[:returnSchema] = schema_const.to_s
      end

      def uses(*tools)
        _cambium_defaults[:tools] ||= []
        _cambium_defaults[:tools].concat(tools.map(&:to_s))
      end

      # RED-298: each declared corrector carries its own repair budget.
      # `corrects :math` → 1 attempt (today's contract, unchanged).
      # `corrects :regex_x, max_attempts: 3` → up to 3 repair iterations.
      # Ceiling is 3 — compile-time enforced to match RED-239's memory-TTL
      # stance (opinionated Rails-style cap; lift via a follow-up if a real
      # case surfaces). `max_attempts` applies to every symbol in THIS call
      # — `corrects :a, :b, max_attempts: 2` gives both a and b 2 attempts.
      def corrects(*correctors, max_attempts: 1)
        unless max_attempts.is_a?(Integer) && (1..3).cover?(max_attempts)
          raise ArgumentError,
                "corrects max_attempts must be an Integer in 1..3, got #{max_attempts.inspect}"
        end
        _cambium_defaults[:correctors] ||= []
        correctors.each do |c|
          _cambium_defaults[:correctors] << {
            'name' => c.to_s,
            'max_attempts' => max_attempts,
          }
        end
      end

      def constrain(key, **opts)
        _cambium_defaults[:constraints] ||= {}
        _cambium_defaults[:constraints][key.to_s] = opts
      end

      # Security: declare tool-execution policy.
      #
      # Two forms — see RED-214 design note for the per-slot mixing rule.
      #
      # Inline:
      #   security network:    { allowlist: ["api.tavily.com"], ... },
      #            filesystem: { roots: ["./examples"] },
      #            exec:       { allowed: true }
      #
      # From a policy pack (resolves to app/policies/<name>.policy.rb):
      #   security :research_defaults
      #
      # The two can coexist across calls so long as no slot
      # (network / filesystem / exec) is set by more than one source.
      def security(*args, **opts)
        removed = opts.keys.map(&:to_s) & %w[allow_network allow_filesystem allow_exec network_hosts_allowlist]
        unless removed.empty?
          raise ArgumentError,
                "security #{removed.join(', ')} was removed in RED-137. " \
                "Use the nested form: security network: { allowlist: [...] }. " \
                "See docs/GenDSL Docs/S - Tool Sandboxing (RED-137).md"
        end

        if args.length > 1
          raise ArgumentError, "security takes at most one positional arg (a pack symbol)"
        end
        if args.length == 1 && !opts.empty?
          raise ArgumentError,
                "security: cannot mix pack symbol and inline keys in one call. " \
                "Use two calls (one for the pack, one inline) or move it all into the pack."
        end

        if args.length == 1
          pack_name = args.first
          unless pack_name.is_a?(Symbol)
            raise ArgumentError, "security: positional arg must be a Symbol pack name (got #{pack_name.class})"
          end
          pack = Cambium::PolicyPack.load(pack_name, _cambium_policy_search_dirs)
          slots = pack.export(:security)
          if slots.nil?
            declared = pack.exports.reject { |_, v| v.nil? || v.empty? }.keys
            raise ArgumentError,
                  "Pack '#{pack_name}' does not export 'security' " \
                  "(only declares: #{declared.join(', ').then { |s| s.empty? ? '(nothing)' : s }})"
          end
          _cambium_add_slots(:security, slots, source: "pack:#{pack_name}")
        else
          slots = Cambium::Normalize.security_slots(opts)
          _cambium_add_slots(:security, slots, source: 'inline')
        end
      end

      # Budget: per-tool and per-run resource caps for tool execution.
      #
      # Inline:
      #   budget per_tool: { web_search: { max_calls: 5 } },
      #          per_run:  { max_calls: 100 }
      #
      # From a policy pack:
      #   budget :research_defaults
      #
      # Slots: per_tool, per_run. Same per-slot mixing rule as `security`.
      # Metric supported in v1: max_calls only.
      def budget(*args, **opts)
        if args.length > 1
          raise ArgumentError, "budget takes at most one positional arg (a pack symbol)"
        end
        if args.length == 1 && !opts.empty?
          raise ArgumentError,
                "budget: cannot mix pack symbol and inline keys in one call. " \
                "Use two calls (one for the pack, one inline) or move it all into the pack."
        end

        if args.length == 1
          pack_name = args.first
          unless pack_name.is_a?(Symbol)
            raise ArgumentError, "budget: positional arg must be a Symbol pack name (got #{pack_name.class})"
          end
          pack = Cambium::PolicyPack.load(pack_name, _cambium_policy_search_dirs)
          slots = pack.export(:budget)
          if slots.nil?
            declared = pack.exports.reject { |_, v| v.nil? || v.empty? }.keys
            raise ArgumentError,
                  "Pack '#{pack_name}' does not export 'budget' " \
                  "(only declares: #{declared.join(', ').then { |s| s.empty? ? '(nothing)' : s }})"
          end
          _cambium_add_slots(:budget, slots, source: "pack:#{pack_name}")
        else
          slots = Cambium::Normalize.budget_slots(opts)
          _cambium_add_slots(:budget, slots, source: 'inline')
        end
      end

      # Log: declare trace-fan-out destinations for this gen. See
      # RED-282 and docs/GenDSL Docs/N - Log Primitive (RED-282).md.
      #
      # Profile form (resolves from app/log_profiles/<name>.log_profile.rb):
      #   log :app_default
      #
      # Inline form:
      #   log :datadog, include: [:signals, :usage], granularity: :run
      #   log :stdout
      #
      # Multiple calls accumulate destinations — same stance as
      # `uses :a, :b`. Profile and inline opts are mutually exclusive
      # within a single call (per-slot mixing rule from RED-214).
      #
      # Resolution: if `<name>.log_profile.rb` exists in any search dir,
      # the arg is treated as a profile reference. Otherwise it's an
      # inline destination name; the runner validates it against
      # registered sinks (framework built-ins + app plugins) at dispatch.
      # RED-273 / RED-305: declare a cron schedule for this gen. Cambium
      # owns the declaration + runtime semantics (memory scope, fire_id,
      # observability) but NOT the lifecycle — the operator's scheduler
      # (crontab, k8s CronJob, etc.) fires `cambium run ... --fired-by
      # schedule:<id>` at the declared cadence.
      #
      # Named vocabulary:
      #   cron :daily, at: "9:00"
      #   cron :weekly, at: "8:00"           # Sunday 8am
      #   cron :weekdays, at: "9:00"         # Mon-Fri 9am
      #   cron :hourly
      #   cron :every_minute                 # for testing
      #
      # Raw crontab for anything the vocabulary doesn't cover:
      #   cron "30 14 * * 1,3,5"
      #
      # Options:
      #   method: — which method to invoke (defaults to the gen's
      #             single public method; required when multiple exist)
      #   tz:     — time zone for the expression (default "UTC")
      #   id:     — explicit slug override; must match /^[a-z][a-z0-9_]*$/
      #
      # Multi-schedule gens declare multiple `cron` calls; duplicates
      # (same id) raise at class-load time.
      def cron(expr_or_name, at: nil, tz: nil, method: nil, id: nil, **extra)
        unless extra.empty?
          raise ArgumentError,
                "cron: unknown option(s) #{extra.keys.join(', ')}. " \
                "Recognized: at, tz, method, id."
        end

        if expr_or_name.is_a?(Symbol)
          named = expr_or_name.to_s
          expression = Cambium::Cron.expand_named(named, at: at)
        elsif expr_or_name.is_a?(String)
          named = nil
          if at
            raise ArgumentError,
                  "cron: `at:` kwarg not valid with a raw crontab expression " \
                  "(use `at:` only with the named vocabulary :daily/:weekly/:weekdays)."
          end
          expression = Cambium::Cron.validate_expression(expr_or_name)
        else
          raise ArgumentError,
                "cron: first arg must be a Symbol (named vocab) or String (crontab), " \
                "got #{expr_or_name.class}"
        end

        # Slug: explicit id > named vocab > hash of crontab expression.
        if id
          id_str = id.to_s
          unless id_str =~ /\A[a-z][a-z0-9_]*\z/
            raise ArgumentError,
                  "cron id: must match /^[a-z][a-z0-9_]*$/ (got :#{id_str})."
          end
          slug = id_str
        elsif named
          slug = named
        else
          slug = Cambium::Cron.slug_from_expression(expression)
        end

        # Method is resolved at compile.rb time (after class body fully
        # evaluates, so `instance_methods(false)` returns all user-def
        # methods). Store method as a Symbol or nil.
        method_sym = method.nil? ? nil : method.to_s

        # Store an entry with everything except the final id + method;
        # compile.rb finishes the resolution. We track `slug` here so
        # duplicate detection inside the same class body works even
        # before method is resolved.
        _cambium_defaults[:schedules] ||= []
        entry = {
          'slug' => slug,
          'expression' => expression,
          'tz' => (tz || 'UTC').to_s,
          'method' => method_sym,
        }
        entry['named'] = named if named
        entry['at'] = at if at

        # Duplicate (slug, method) pair check — raised here rather than
        # at compile.rb so the error points at the failing line.
        if _cambium_defaults[:schedules].any? { |s| s['slug'] == slug && s['method'] == method_sym }
          raise ArgumentError,
                "cron: duplicate schedule declaration (slug='#{slug}'" +
                (method_sym ? ", method=:#{method_sym}" : '') + "). " \
                "Use `id:` to disambiguate, or combine into one declaration."
        end

        _cambium_defaults[:schedules] << entry
      end

      def log(*args, include: nil, granularity: nil, endpoint: nil, api_key_env: nil, **extra)
        unless extra.empty?
          raise ArgumentError,
                "log: unknown option(s) #{extra.keys.join(', ')}. " \
                "Recognized: include, granularity, endpoint, api_key_env."
        end
        if args.length != 1
          raise ArgumentError,
                "log takes exactly one positional arg (destination or profile name), got #{args.length}"
        end
        name = args.first
        unless name.is_a?(Symbol)
          raise ArgumentError, "log: positional arg must be a Symbol (got #{name.class})"
        end

        # Profile-vs-inline discrimination: if a file exists, it's a
        # profile reference. The Ruby name regex enforced by
        # LogProfile.load catches path-traversal even though we're
        # pre-walking the search dirs with a literal basename here.
        name_str = name.to_s
        profile_file = nil
        if name_str =~ /\A[a-z][a-z0-9_]*\z/
          profile_file = _cambium_log_profile_search_dirs.map do |d|
            File.join(d, "#{name_str}.log_profile.rb")
          end.find { |f| File.exist?(f) }
        end

        _cambium_defaults[:log] ||= []
        _cambium_defaults[:log_profiles] ||= []

        if profile_file
          if !include.nil? || !granularity.nil? || !endpoint.nil? || !api_key_env.nil?
            raise ArgumentError,
                  "log :#{name}: cannot mix profile reference and inline options " \
                  "(include/granularity/endpoint/api_key_env) in one call. " \
                  "Either override via the profile file or use a separate inline log call."
          end
          profile = Cambium::LogProfile.load(name, _cambium_log_profile_search_dirs)
          profile.destinations.each do |dest|
            entry = dest.dup
            entry['include'] = profile.includes.dup
            entry['granularity'] = profile.granularity
            entry['_profile'] = profile.name
            _cambium_defaults[:log] << entry
          end
          unless _cambium_defaults[:log_profiles].include?(profile.name)
            _cambium_defaults[:log_profiles] << profile.name
          end
        else
          entry = { 'destination' => name_str }
          inc = (include || []).map(&:to_s)
          bad = inc.reject { |f| Cambium::LogProfileBuilder::VALID_INCLUDES.include?(f) }
          unless bad.empty?
            raise ArgumentError,
                  "log :#{name} include: unknown field(s) #{bad.map { |f| ":#{f}" }.join(', ')}. " \
                  "Recognized: #{Cambium::LogProfileBuilder::VALID_INCLUDES.map { |v| ":#{v}" }.join(', ')}."
          end
          entry['include'] = inc
          g = (granularity || :run).to_s
          unless Cambium::LogProfileBuilder::VALID_GRANULARITIES.include?(g)
            raise ArgumentError,
                  "log :#{name} granularity: must be :run or :step (got :#{g})"
          end
          entry['granularity'] = g
          entry['endpoint']    = endpoint    unless endpoint.nil?
          entry['api_key_env'] = api_key_env unless api_key_env.nil?
          _cambium_defaults[:log] << entry
        end
      end

      # Internal: accumulate slots into _cambium_defaults[primitive], tracking
      # which source set each slot. Two sources for the same slot → error.
      def _cambium_add_slots(primitive, new_slots, source:)
        state = _cambium_defaults[primitive] ||= { 'slots' => {}, 'sources' => {}, 'packs' => [] }
        new_slots.each do |slot, value|
          if state['slots'].key?(slot)
            existing = state['sources'][slot]
            raise ArgumentError,
                  "#{primitive}: slot '#{slot}' is set by both #{existing} and #{source}. " \
                  "Pick one source per slot."
          end
          state['slots'][slot]   = value
          state['sources'][slot] = source
        end
        if source.start_with?('pack:') && !state['packs'].include?(source.sub('pack:', ''))
          state['packs'] << source.sub('pack:', '')
        end
      end

      # Back-compat alias — the canonical constant is Cambium::ENGINE_SENTINEL.
      # Promoted to module scope in RED-287 so ModelAliases/MemoryPolicy
      # can reference it without reaching into GenModel's singleton.
      ENGINE_SENTINEL = Cambium::ENGINE_SENTINEL

      # RED-245: shared discovery walk used by every search-dir method.
      # Three layers, in priority order:
      #
      #   1. Gen-local — `<gen_dir>/<name>.<ext>`. Always tried first so
      #      engine-mode authoring (files co-located with the gen) works
      #      without a workspace `app/<subdir>/`.
      #   2. Package-app — `<gen_dir>/../<subdir>/<name>.<ext>`. The
      #      established app-mode convention: gens at `<pkg>/app/gens/`
      #      look in `<pkg>/app/<subdir>/`.
      #   3. Workspace fallback — `packages/cambium/app/<subdir>/`,
      #      cwd-relative. Resolves the in-tree default package for any
      #      gen invoked from the repo root.
      #
      # If `cambium.engine.json` sits next to the gen, only layer 1 is
      # returned. The walk-up is suppressed so a sentinel-marked engine
      # cannot accidentally pick up an unrelated `<host>/policies/` or
      # an in-cwd `packages/cambium/app/policies/` that happens to exist.
      def _cambium_discovery_dirs(subdir)
        dirs = []
        if (src = Cambium::CompilerState.current_source_file)
          gen_dir = File.dirname(File.expand_path(src))
          if File.exist?(File.join(gen_dir, ENGINE_SENTINEL))
            return [gen_dir]
          end
          dirs << gen_dir
          # The original code did File.dirname twice from the gen file
          # (landing at <pkg>/app, then re-joining 'app' on top — net
          # <pkg>/app/app/<subdir>, which silently missed and was rescued
          # by layer 3). One File.dirname from gen_dir lands at the gen's
          # parent; we then join `<subdir>` directly. For an app-mode gen
          # at <pkg>/app/gens/<file>.cmb.rb, this resolves to <pkg>/app/<subdir>.
          dirs << File.join(File.dirname(gen_dir), subdir)
        end
        dirs << File.join('packages', 'cambium', 'app', subdir)
        dirs.uniq
      end

      # Where to look for app/policies/<name>.policy.rb files.
      def _cambium_policy_search_dirs
        _cambium_discovery_dirs('policies')
      end

      # RED-215: where to look for app/memory_pools/<name>.pool.rb.
      def _cambium_memory_pool_search_dirs
        _cambium_discovery_dirs('memory_pools')
      end

      # RED-282: where to look for app/log_profiles/<name>.log_profile.rb.
      def _cambium_log_profile_search_dirs
        _cambium_discovery_dirs('log_profiles')
      end

      # RED-215: declare a memory slot the gen wants read-injected
      # before generation (and, when a memory agent is wired up via
      # `write_memory_via`, written to after generation).
      #
      #   memory :conversation, strategy: :sliding_window, size: 20
      #   memory :activity_log, strategy: :log,            scope: :global
      #   memory :user_facts,   scope: :support_team, top_k: 5
      #
      # Scope rules:
      # - :session (default)  — per-run-chain; gen owns strategy + opts.
      # - :global             — workspace-wide; gen owns strategy + opts.
      # - <named pool symbol> — loaded from app/memory_pools/<name>.pool.rb;
      #   the pool is authoritative on strategy/embed/keyed_by. Setting
      #   any of those at the call site is a compile error (the pool is
      #   the shared source of truth).
      #
      # Phase 2 (this ticket) parses + validates and emits IR under
      # policies.memory. The TS runner ignores memory entries until
      # phase 3 wires up the sqlite-vec backend.
      def memory(name, strategy: nil, scope: nil, size: nil, top_k: nil, keyed_by: nil, embed: nil, retain: nil, query: nil, arg_field: nil, **extra)
        unless extra.empty?
          raise ArgumentError,
                "memory #{name}: unknown option(s) #{extra.keys.join(', ')}. " \
                "Recognized: strategy, scope, size, top_k, keyed_by, embed, retain, query, arg_field."
        end

        entry = { 'name' => name.to_s, 'scope' => (scope || :session).to_s }
        if strategy
          s = strategy.to_s
          unless Cambium::MemoryPoolBuilder::VALID_STRATEGIES.include?(s)
            raise ArgumentError,
                  "memory #{name}: strategy must be one of " \
                  "#{Cambium::MemoryPoolBuilder::VALID_STRATEGIES.map { |v| ":#{v}" }.join(', ')} " \
                  "(got :#{s})"
          end
          entry['strategy'] = s
        end
        entry['size']     = size              unless size.nil?
        entry['top_k']    = top_k             unless top_k.nil?
        entry['keyed_by'] = keyed_by.to_s     unless keyed_by.nil?
        entry['embed']    = embed.to_s        unless embed.nil?
        unless retain.nil?
          entry['retain'] = Cambium::Retention.parse(retain, context: "memory #{name} retain")
        end

        # RED-238: configurable query source for :semantic reads.
        # `query:` is a literal string anchor; `arg_field:` plucks a
        # top-level field out of ctx.input (parsed as JSON at run time).
        # The Symbol form of `query:` (e.g. `query: :last_signal_value`)
        # is reserved for RED-241's prior-run state accessor and raises
        # here so an author who tries it gets a clear pointer to that
        # ticket rather than a silent no-op.
        if !query.nil? && !arg_field.nil?
          raise ArgumentError,
                "memory #{name}: `query:` and `arg_field:` are mutually exclusive — pick one. " \
                "Both configure the nearest-neighbor query source for a :semantic read."
        end
        unless query.nil?
          case query
          when String
            entry['query'] = query
          when Symbol
            raise Cambium::CompileError,
                  "memory #{name}: symbolic `query:` values (e.g. `query: :#{query}`) are reserved " \
                  "for prior-run state accessors (RED-241, not yet shipped). Use a literal string " \
                  "(`query: \"...\"`) or `arg_field: :name` for now."
          else
            raise ArgumentError,
                  "memory #{name}: `query:` must be a literal String (got #{query.class})."
          end
        end
        unless arg_field.nil?
          unless arg_field.is_a?(String) || arg_field.is_a?(Symbol)
            raise ArgumentError,
                  "memory #{name}: `arg_field:` must be a Symbol or String (got #{arg_field.class})."
          end
          entry['arg_field'] = arg_field.to_s
        end
        # Strategy-explicitly-not-semantic is a compile-time error right
        # here. Pool-scoped decls don't know their strategy until after
        # resolution — that check lands in compile.rb below.
        if (!entry['query'].nil? || !entry['arg_field'].nil?) &&
           entry['strategy'] && entry['strategy'] != 'semantic'
          raise ArgumentError,
                "memory #{name}: `#{entry['query'].nil? ? 'arg_field' : 'query'}:` is only " \
                "valid on strategy :semantic (got :#{entry['strategy']})."
        end

        _cambium_defaults[:memory] ||= []
        if _cambium_defaults[:memory].any? { |m| m['name'] == entry['name'] }
          raise ArgumentError,
                "memory #{name}: a memory slot with this name is already declared on this gen. " \
                "Each memory name must be unique per gen — the runner addresses slots by name."
        end
        _cambium_defaults[:memory] << entry
      end

      # RED-215: declare the retro "memory agent" that runs after the
      # primary gen and decides what to commit to memory. Value is the
      # class name (or snake_case form) of another GenModel; phase 4
      # wires the runtime scheduling.
      def write_memory_via(agent_name)
        _cambium_defaults[:write_memory_via] = agent_name.to_s
      end

      # RED-215: for a retro-mode memory agent, declare which primary
      # gen's trace it reads. Parsed now; execution lands in phase 4.
      def reads_trace_of(agent_name)
        _cambium_defaults[:reads_trace_of] = agent_name.to_s
      end

      # Grounding: declare that outputs must be grounded in a source.
      #   grounded_in :document, require_citations: true
      #
      # RED-283: the source symbol becomes the key under `ir.context`
      # (via RED-276) and the prompt's DOCUMENT: section. Enforce the
      # same `/^[a-z][a-z0-9_]*$/` regex every other named-symbol
      # surface in Cambium uses (RED-214 pack names, RED-215 pool names,
      # RED-215 phase 3 memory keys, RED-275 corrector basenames). A
      # typo like `grounded_in :"has space"` or a silly choice like
      # `grounded_in :__proto__` is rejected at compile time instead of
      # producing a brittle IR.
      GROUNDING_SOURCE_REGEX = /\A[a-z][a-z0-9_]*\z/
      def grounded_in(source, require_citations: false)
        source_str = source.to_s
        unless source_str.match?(GROUNDING_SOURCE_REGEX)
          raise ArgumentError,
                "grounded_in source must match /^[a-z][a-z0-9_]*$/, got: #{source.inspect}"
        end
        _cambium_defaults[:grounding] = {
          'source' => source_str,
          'require_citations' => require_citations
        }
      end

      # Signals: declare a typed extraction from the output.
      #   extract :latency_ms, type: :number, path: "metrics.latency_ms_samples"
      def extract(name, type: :any, unit: nil, path: nil)
        _cambium_defaults[:signals] ||= []
        _cambium_defaults[:signals] << {
          'name' => name.to_s,
          'type' => type.to_s,
          'unit' => unit&.to_s,
          'path' => path&.to_s
        }.compact
      end

      # Enrich: pre-generate context enrichment via sub-agent.
      #   enrich :datadog_logs do
      #     agent :LogSummarizer, method: :summarize
      #   end
      def enrich(context_field, &block)
        _cambium_defaults[:enrichments] ||= []
        dsl = EnrichDSL.new(context_field.to_s)
        dsl.instance_eval(&block) if block
        _cambium_defaults[:enrichments] << dsl._enrichment
      end

      # Triggers: declare a deterministic action when a signal has values.
      #   on :latency_ms do
      #     tool :calculator, operation: "avg", target: "metrics.avg_latency_ms"
      #   end
      def on(signal_name, &block)
        _cambium_defaults[:triggers] ||= []
        dsl = TriggerDSL.new(signal_name.to_s)
        dsl.instance_eval(&block) if block
        _cambium_defaults[:triggers].concat(dsl._actions)
      end
    end

    def generate(prompt)
      builder = Cambium::CompilerState.current_builder
      raise Cambium::CompileError, 'generate called outside compilation context' unless builder

      @_step_counter = (@_step_counter || 0) + 1
      g = {
        'id' => "generate_#{@_step_counter}",
        'type' => 'Generate',
        'prompt' => prompt,
        'with' => {},
        'returns' => self.class._cambium_defaults[:returnSchema]
      }

      dsl = GenerateDSL.new(g)
      dsl.instance_eval(&Proc.new) if block_given?

      builder.add(g)
      g
    end

    class GenerateDSL
      def initialize(gen_step)
        @gen_step = gen_step
      end

      def with(**kwargs)
        @gen_step['with'].merge!(stringify_keys(kwargs))
      end

      def returns(schema_const)
        @gen_step['returns'] = schema_const.to_s
      end

      private

      def stringify_keys(h)
        h.transform_keys(&:to_s)
      end
    end
  end

  class EnrichDSL
    attr_reader :_enrichment

    def initialize(context_field)
      @_enrichment = { 'field' => context_field }
    end

    def agent(name, method: nil)
      @_enrichment['agent'] = name.to_s
      @_enrichment['method'] = method.to_s if method
    end
  end

  class TriggerDSL
    attr_reader :_actions

    def initialize(signal_name)
      @signal_name = signal_name
      @_actions = []
    end

    # Invoke a tool handler when the signal has values. The existing
    # post-generation trigger surface — pure/bounded computations
    # (e.g. `tool :calculator, operation: :avg, target: "metrics.avg"`)
    # whose return value is written back into the gen's output at
    # `target`. Counts against the gen's tool budget.
    def tool(name, **opts)
      action = {
        'on' => @signal_name,
        'action' => 'tool_call',
        'tool' => name.to_s,
        'args' => stringify_keys(opts.reject { |k, _| k == :target }),
        'target' => opts[:target]&.to_s
      }.compact
      @_actions << action
    end

    # RED-212: invoke a custom action handler when the signal has
    # values. Actions are side-effects declared at compile time
    # (`action :notify_stderr`, `action :webhook, url: ...`) — same
    # handler shape as tools (`execute(input, ctx)`), same
    # permissions model, but addressed through the parallel
    # ActionRegistry rather than the ToolRegistry. Unlike tools,
    # actions don't need a `uses :name` allowlist — the author
    # hard-codes which actions fire where, so there's no "did the
    # model pick something it shouldn't" concern.
    def action(name, **opts)
      act = {
        'on' => @signal_name,
        'action' => 'action_call',
        'name' => name.to_s,
        'args' => stringify_keys(opts.reject { |k, _| k == :target }),
        'target' => opts[:target]&.to_s
      }.compact
      @_actions << act
    end

    private

    def stringify_keys(h)
      h.transform_keys(&:to_s)
    end
  end

  class Registry
    def self.register_model_class(klass)
      model_classes << klass
    end

    def self.model_classes
      @model_classes ||= []
    end
  end
end
