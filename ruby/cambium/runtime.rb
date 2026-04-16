# frozen_string_literal: true

require 'json'

module Cambium
  class CompileError < StandardError; end

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
        raise ArgumentError, "security exec: must be a Hash" unless ex.is_a?(Hash)
        slots['exec'] = { 'allowed' => ex.fetch(:allowed) { ex.fetch('allowed', false) } }
      end
      unknown = opts.keys.map(&:to_s) - %w[network filesystem exec]
      raise ArgumentError, "unknown security keys: #{unknown.join(', ')}" unless unknown.empty?
      slots
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

    VALID_SCOPES = %w[session global].freeze

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

      def corrects(*correctors)
        _cambium_defaults[:correctors] ||= []
        _cambium_defaults[:correctors].concat(correctors.map(&:to_s))
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

      # Where to look for app/policies/<name>.policy.rb files. Same
      # search strategy used for app/systems/<name>.system.md elsewhere.
      def _cambium_policy_search_dirs
        dirs = []
        if (src = Cambium::CompilerState.current_source_file)
          pkg_dir = File.dirname(File.dirname(File.expand_path(src)))  # up from app/gens/
          dirs << File.join(pkg_dir, 'app', 'policies')
        end
        dirs << File.join('packages', 'cambium', 'app', 'policies')
        dirs.uniq
      end

      # RED-215: where to look for app/memory_pools/<name>.pool.rb.
      # Mirrors the policy-pack search (same two-dir strategy — the
      # gen's package first, then the workspace default).
      def _cambium_memory_pool_search_dirs
        dirs = []
        if (src = Cambium::CompilerState.current_source_file)
          pkg_dir = File.dirname(File.dirname(File.expand_path(src)))  # up from app/gens/
          dirs << File.join(pkg_dir, 'app', 'memory_pools')
        end
        dirs << File.join('packages', 'cambium', 'app', 'memory_pools')
        dirs.uniq
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
      def memory(name, strategy: nil, scope: nil, size: nil, top_k: nil, keyed_by: nil, embed: nil, retain: nil, **extra)
        unless extra.empty?
          raise ArgumentError,
                "memory #{name}: unknown option(s) #{extra.keys.join(', ')}. " \
                "Recognized: strategy, scope, size, top_k, keyed_by, embed, retain."
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
      def grounded_in(source, require_citations: false)
        _cambium_defaults[:grounding] = {
          'source' => source.to_s,
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
