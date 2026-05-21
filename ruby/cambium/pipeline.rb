# frozen_string_literal: true

require 'json'
require_relative './runtime'

module Cambium
  # A typed reference to a value flowing through the pipeline.
  #
  #   bind(:input).incident           → { input: 'incident' }
  #   bind(:triage)                   → { step:  'triage' }
  #   bind(:triage).severity          → { step:  'triage', field: 'severity' }
  #   bind(:triage).meta.user_id      → { step:  'triage', field: 'meta.user_id' }
  #
  # Field access is captured via method_missing as a dotted path string.
  # Compile-time resolution (RED-381 Phase A.3) walks every BindRef against
  # the pipeline's `input` block and the referenced step's `returns` schema
  # to catch typos before runtime.
  class BindRef
    # Ruby's `**` splat and `*` splat will call `to_hash` / `to_ary` on
    # a positional arg when the receiving method accepts kwargs / array
    # splat — both probe via `respond_to?` and then invoke. Because
    # BindRef.method_missing is catch-all, those probes would return
    # another BindRef instead of a Hash/Array, and Ruby raises a
    # confusing "can't convert BindRef to Hash" inside the DSL block.
    # Excluding the conversion-protocol set from method_missing /
    # respond_to_missing? keeps BindRef chainable for legitimate field
    # access (`bind(:triage).summary`) without lying to Ruby's
    # internal coercion checks.
    RUBY_PROTOCOL_METHODS = %i[
      to_hash to_ary to_a to_proc to_str to_int to_io to_path coerce
    ].freeze

    attr_reader :target, :path

    def initialize(target, path = nil)
      @target = target.to_s
      @path   = path
    end

    def method_missing(name, *args, **kwargs)
      return super if RUBY_PROTOCOL_METHODS.include?(name)
      unless args.empty? && kwargs.empty?
        raise NoMethodError,
              "bind(:#{@target}).#{name}: chained field access doesn't accept arguments"
      end
      BindRef.new(@target, @path ? "#{@path}.#{name}" : name.to_s)
    end

    def respond_to_missing?(name, _include_private = false)
      !RUBY_PROTOCOL_METHODS.include?(name)
    end

    # IR encoding. Pipeline `input` slots and step results have distinct
    # encodings so the runner can resolve them through different paths
    # (input → ir.context, step → prior operator output).
    def to_ir
      if @target == 'input'
        @path.nil? ? { 'input' => true } : { 'input' => @path }
      else
        out = { 'step' => @target }
        out['field'] = @path if @path
        out
      end
    end

    def inspect
      @path ? "bind(:#{@target}).#{@path}" : "bind(:#{@target})"
    end
    alias to_s inspect
  end

  # DSL helpers used inside `fan_out` blocks.
  class FanOutDSL
    attr_reader :_branches, :_concurrency, :_on_branch_failure, :_require_threshold, :_pass_context,
                :_homogeneous

    def initialize
      @_branches            = []
      @_concurrency         = nil
      @_on_branch_failure   = 'continue'
      @_require_threshold   = { 'kind' => 'all' }
      @_pass_context        = nil
      @_homogeneous         = nil  # set when `agent ...; over ...` sugar is used
    end

    # Heterogeneous form: one explicit branch per call.
    #   branch :security, agent: SecurityReviewer, method: :review
    def branch(name, agent:, method: nil)
      entry = { 'id' => name.to_s, 'agent' => agent.to_s }
      entry['method'] = method.to_s if method
      @_branches << entry
    end

    # Homogeneous-fan-out sugar:
    #   agent DocumentReviewer, method: :review
    #   over [:legal, :financial, :technical], as: :aspect
    #
    # The compiler expands `agent` + `over` into N branch entries at IR
    # emission time. Stored here as a struct; expansion is centralized in
    # the compiler so the IR has the same shape either way.
    def agent(klass, method: nil)
      @_homogeneous ||= {}
      @_homogeneous['agent']  = klass.to_s
      @_homogeneous['method'] = method.to_s if method
    end

    def over(values, as:)
      @_homogeneous ||= {}
      @_homogeneous['over'] = values.map(&:to_s)
      @_homogeneous['as']   = as.to_s
    end

    def concurrency(n)
      raise ArgumentError, "concurrency: must be a positive Integer (got #{n.inspect})" unless n.is_a?(Integer) && n.positive?
      @_concurrency = n
    end

    def on_branch_failure(mode)
      m = mode.to_s
      unless %w[continue fail_fast].include?(m)
        raise ArgumentError, "on_branch_failure: must be :continue or :fail_fast (got :#{m})"
      end
      @_on_branch_failure = m
    end

    # require :all                  → every branch must succeed
    # require :at_least, 3          → ≥3 branches must succeed
    def require(kind, n = nil)
      case kind
      when :all
        raise ArgumentError, "require :all takes no second argument" unless n.nil?
        @_require_threshold = { 'kind' => 'all' }
      when :at_least
        unless n.is_a?(Integer) && n.positive?
          raise ArgumentError, "require :at_least, N — N must be a positive Integer (got #{n.inspect})"
        end
        @_require_threshold = { 'kind' => 'at_least', 'n' => n }
      else
        raise ArgumentError, "require: must be :all or :at_least, N (got #{kind.inspect})"
      end
    end

    # pass_context :surface_map, :other_field — copy these fields from
    # the upstream step's output into every branch's input context.
    def pass_context(*fields)
      @_pass_context = fields.map(&:to_s)
    end
  end

  # DSL helpers used inside `branch_on` blocks.
  class BranchOnDSL
    attr_reader :_branches, :_default

    def initialize
      @_branches = []
      @_default  = nil
    end

    # on :critical do ... end — value(s) match this branch.
    # on :low, :info do ... end — multiple values fold into the same branch.
    def on(*values, &block)
      raise ArgumentError, "branch_on on() requires at least one value" if values.empty?
      raise ArgumentError, "branch_on on() requires a block" unless block

      body = BranchBodyDSL.new
      body.instance_eval(&block)
      @_branches << {
        'values'    => values.map(&:to_s),
        'operators' => body._operators
      }
    end

    # default do ... end — explicit catch-all.
    def default(&block)
      raise ArgumentError, "branch_on default() requires a block" unless block
      raise ArgumentError, "branch_on: only one default block per branch_on" unless @_default.nil?

      body = BranchBodyDSL.new
      body.instance_eval(&block)
      @_default = body._operators
    end
  end

  # Shared operator-building shape, used inside `branch_on` `on`/`default`
  # blocks AND inside `fan_out` (when fan_out grows nested operators in v1.5+).
  # The Pipeline class also recapitulates these methods so its class body
  # records into _cambium_pipeline_defaults['operators'].
  class BranchBodyDSL
    attr_reader :_operators

    def initialize
      @_operators = []
    end

    # bind() must be available inside this block — nested `step :foo, with:
    # { ctx: bind(:upstream).field }` calls evaluate inside an instance_eval
    # on this DSL, so the class-level bind() helper on Pipeline isn't in
    # scope. Defining it here keeps the call site identical.
    def bind(target)
      BindRef.new(target)
    end

    def step(name, gen:, method: nil, with: nil)
      op = { 'kind' => 'Step', 'id' => name.to_s, 'gen' => gen.to_s }
      op['method'] = method.to_s if method
      op['with']   = Cambium::Pipeline._cambium_normalize_with(with) if with && !with.empty?
      @_operators << op
    end

    def fan_out(name, collect_into:, &block)
      dsl = FanOutDSL.new
      dsl.instance_eval(&block) if block
      @_operators << Cambium::Pipeline._cambium_build_fan_out_op(name, collect_into, dsl)
    end

    def branch_on(signal_ref, &block)
      unless signal_ref.is_a?(BindRef)
        raise ArgumentError, "branch_on: signal must be a bind(...) reference (got #{signal_ref.class})"
      end
      dsl = BranchOnDSL.new
      dsl.instance_eval(&block) if block
      @_operators << Cambium::Pipeline._cambium_build_branch_on_op(signal_ref, dsl)
    end
  end

  # DSL helper for the `output do ... end` composition block.
  #
  #   output do
  #     severity bind(:triage).severity
  #     plan     bind(:remediate).plan
  #   end
  #
  # Field-name method calls capture a (name, bind_ref) pair. Each capture
  # becomes an entry in the pipeline IR's `output.fields` array. The
  # output's TypeBox shape is assembled from the referenced steps'
  # `returns` schemas at compile time (Phase A.3 will wire this).
  class OutputDSL
    attr_reader :_fields

    def initialize
      @_fields = []
    end

    # bind() needs to be in scope inside `output do ... end` since the
    # block is instance_eval'd on this DSL.
    def bind(target)
      BindRef.new(target)
    end

    def method_missing(name, *args, **kwargs)
      if args.length != 1 || !kwargs.empty?
        raise ArgumentError,
              "output field '#{name}' takes exactly one arg (a bind(...) reference)"
      end
      ref = args.first
      unless ref.is_a?(BindRef)
        raise ArgumentError,
              "output field '#{name}': must be a bind(...) reference (got #{ref.class})"
      end
      if @_fields.any? { |f| f['name'] == name.to_s }
        raise ArgumentError, "output field '#{name}' declared more than once"
      end
      @_fields << { 'name' => name.to_s, 'from' => ref.to_ir }
    end

    def respond_to_missing?(_name, _include_private = false)
      true
    end
  end

  # Pipeline — the orchestration-layer primitive (RED-374 design,
  # RED-381 impl). Composes multiple sub-gens via three operators
  # (`step`, `fan_out`, `branch_on`) with rollup IR / trace / budget
  # owned by the framework.
  #
  # Load-bearing invariant: zero inference at the orchestration layer.
  # The DSL compiles to a deterministic IR DAG; the runner executes
  # operators that are pure code; LLM calls happen only inside sub-gens.
  class Pipeline
    NAME_RE = /\A[a-z][a-z0-9_]*\z/.freeze

    class << self
      attr_reader :_cambium_pipeline_defaults

      def inherited(sub)
        super
        Cambium::Registry.register_pipeline_class(sub)
        sub.instance_variable_set(:@_cambium_pipeline_defaults, {
          'inputs'        => {},
          'operators'     => [],
          'bind_defaults' => 'explicit',
          'budget'        => {},
          'security'      => nil,
          'memory'        => [],
          'schedules'     => [],
          'log'           => [],
          'log_profiles'  => [],
          'output'        => nil
        })
      end

      # ===== Input declarations =====

      # input :incident, schema: Incident
      #
      # Declares a typed input slot at the pipeline class level. Steps
      # reference it via `bind(:input).incident`. The schema is resolved
      # against the package's contracts.ts at compile time (same path as
      # `returns` on GenModel).
      def input(name, schema:)
        name_str = name.to_s
        unless name_str =~ NAME_RE
          raise ArgumentError,
                "input name must match /#{NAME_RE.source}/, got #{name.inspect}"
        end
        if _cambium_pipeline_defaults['inputs'].key?(name_str)
          raise ArgumentError, "duplicate input :#{name_str} on #{self.name}"
        end
        _cambium_pipeline_defaults['inputs'][name_str] = { 'schema' => schema.to_s }
      end

      # ===== Bind defaults =====

      VALID_BIND_DEFAULTS = %w[explicit pass_through].freeze

      # bind_defaults :explicit | :pass_through
      #
      # :explicit (shipped default) — every step's inputs are named at the
      # call site via `with: { ... }`.
      # :pass_through — prior step's output flows into the next step's
      # primary input slot automatically (when no explicit with:).
      def bind_defaults(mode)
        m = mode.to_s
        unless VALID_BIND_DEFAULTS.include?(m)
          raise ArgumentError,
                "bind_defaults must be one of :#{VALID_BIND_DEFAULTS.join(', :')} (got :#{m})"
        end
        _cambium_pipeline_defaults['bind_defaults'] = m
      end

      # ===== Pipeline-level budget cap =====

      VALID_BUDGET_KEYS = %i[tokens tool_calls].freeze

      # budget tokens: 50_000, tool_calls: 100
      #
      # Top-level cap monitoring total spend across all sub-gens. Per-gen
      # budgets enforce themselves independently. No implicit splitting —
      # the cap is a ceiling. See N - Orchestration Layer § Budget
      # enforcement.
      def budget(**opts)
        unknown = opts.keys - VALID_BUDGET_KEYS
        unless unknown.empty?
          raise ArgumentError,
                "budget: unknown keys #{unknown.join(', ')}. " \
                "Recognized: #{VALID_BUDGET_KEYS.join(', ')}."
        end
        opts.each do |k, v|
          unless v.is_a?(Integer) && v.positive?
            raise ArgumentError, "budget #{k}: must be a positive Integer (got #{v.inspect})"
          end
          _cambium_pipeline_defaults['budget'][k.to_s] = v
        end
      end

      # ===== Security (inherits into sub-gens) =====

      # security :pack_name           — bundled pack
      # security network: { ... }      — inline (same shape as GenModel)
      #
      # Pipeline-level security flows into sub-gens by default; sub-gen
      # `security` blocks override per-slot. Per-slot mixing rule (RED-214)
      # is enforced here at the pipeline-class level.
      def security(*args, **opts)
        if args.length > 1
          raise ArgumentError, "security takes at most one positional arg (a pack symbol)"
        end
        if args.length == 1 && !opts.empty?
          raise ArgumentError,
                "security: cannot mix pack symbol and inline keys in one call."
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
                  "(declares: #{declared.empty? ? '(nothing)' : declared.join(', ')})"
          end
          _cambium_add_slots(:security, slots, source: "pack:#{pack_name}")
        else
          slots = Cambium::Normalize.security_slots(opts)
          _cambium_add_slots(:security, slots, source: 'inline')
        end
      end

      # ===== Pipeline-level shared memory =====

      # memory :findings, strategy: :semantic, top_k: 10
      #
      # Declares an intra-run scratchpad shared across sub-gens. Sub-gens
      # opt in by declaring `memory :findings, scope: :pipeline_run`. The
      # default scope is :pipeline_run (intra-run only); authors can set
      # :session / :named_pool for cross-run sharing through the same
      # surface.
      def memory(name, strategy: nil, scope: nil, size: nil, top_k: nil, embed: nil, retain: nil, keyed_by: nil, **extra)
        unless extra.empty?
          raise ArgumentError,
                "memory #{name}: unknown option(s) #{extra.keys.join(', ')}. " \
                "Recognized: strategy, scope, size, top_k, embed, retain, keyed_by."
        end

        name_str = name.to_s
        unless name_str =~ NAME_RE
          raise ArgumentError, "memory name must match /#{NAME_RE.source}/, got #{name.inspect}"
        end

        scope_str = (scope || :pipeline_run).to_s
        entry = { 'name' => name_str, 'scope' => scope_str }

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
        entry['embed']    = embed.to_s        unless embed.nil?
        entry['keyed_by'] = keyed_by.to_s     unless keyed_by.nil?
        unless retain.nil?
          entry['retain'] = Cambium::Retention.parse(retain, context: "memory #{name} retain")
        end

        if _cambium_pipeline_defaults['memory'].any? { |m| m['name'] == name_str }
          raise ArgumentError,
                "memory #{name}: a memory slot with this name is already declared on #{self.name}."
        end
        _cambium_pipeline_defaults['memory'] << entry
      end

      # ===== cron + log: delegate to existing GenModel shapes =====
      #
      # These DSL calls accumulate the same IR shape gens emit, so the
      # runner's existing scheduling + logging plumbing (RED-305 / RED-302)
      # can re-use that consumer code with a pipeline name in place of a
      # gen name.

      def cron(expr_or_name, at: nil, tz: nil, method: nil, id: nil, **extra)
        unless extra.empty?
          raise ArgumentError,
                "cron: unknown option(s) #{extra.keys.join(', ')}. Recognized: at, tz, method, id."
        end

        if expr_or_name.is_a?(Symbol)
          named = expr_or_name.to_s
          expression = Cambium::Cron.expand_named(named, at: at)
        elsif expr_or_name.is_a?(String)
          named = nil
          if at
            raise ArgumentError,
                  "cron: `at:` kwarg not valid with a raw crontab expression."
          end
          expression = Cambium::Cron.validate_expression(expr_or_name)
        else
          raise ArgumentError,
                "cron: first arg must be a Symbol or String (got #{expr_or_name.class})"
        end

        if id
          id_str = id.to_s
          unless id_str =~ NAME_RE
            raise ArgumentError, "cron id: must match /#{NAME_RE.source}/ (got :#{id_str})."
          end
          slug = id_str
        elsif named
          slug = named
        else
          slug = Cambium::Cron.slug_from_expression(expression)
        end

        method_sym = method.nil? ? nil : method.to_s
        entry = {
          'slug' => slug,
          'expression' => expression,
          'tz' => (tz || 'UTC').to_s,
          'method' => method_sym
        }
        entry['named'] = named if named
        entry['at'] = at if at

        if _cambium_pipeline_defaults['schedules'].any? { |s| s['slug'] == slug && s['method'] == method_sym }
          raise ArgumentError,
                "cron: duplicate schedule declaration (slug='#{slug}'" +
                (method_sym ? ", method=:#{method_sym}" : '') + ")."
        end

        _cambium_pipeline_defaults['schedules'] << entry
      end

      def log(*args, include: nil, granularity: nil, endpoint: nil, api_key_env: nil, **extra)
        unless extra.empty?
          raise ArgumentError,
                "log: unknown option(s) #{extra.keys.join(', ')}. " \
                "Recognized: include, granularity, endpoint, api_key_env."
        end
        if args.length != 1
          raise ArgumentError, "log takes exactly one positional arg (got #{args.length})"
        end
        name = args.first
        unless name.is_a?(Symbol)
          raise ArgumentError, "log: positional arg must be a Symbol (got #{name.class})"
        end

        name_str = name.to_s
        profile_file = nil
        if name_str =~ NAME_RE
          profile_file = _cambium_log_profile_search_dirs.map do |d|
            File.join(d, "#{name_str}.log_profile.rb")
          end.find { |f| File.exist?(f) }
        end

        if profile_file
          if !include.nil? || !granularity.nil? || !endpoint.nil? || !api_key_env.nil?
            raise ArgumentError,
                  "log :#{name}: cannot mix profile reference and inline options in one call."
          end
          profile = Cambium::LogProfile.load(name, _cambium_log_profile_search_dirs)
          profile.destinations.each do |dest|
            entry = dest.dup
            entry['include'] = profile.includes.dup
            entry['granularity'] = profile.granularity
            entry['_profile'] = profile.name
            _cambium_pipeline_defaults['log'] << entry
          end
          unless _cambium_pipeline_defaults['log_profiles'].include?(profile.name)
            _cambium_pipeline_defaults['log_profiles'] << profile.name
          end
        else
          entry = { 'destination' => name_str }
          inc = (include || []).map(&:to_s)
          bad = inc.reject { |f| Cambium::LogProfileBuilder::VALID_INCLUDES.include?(f) }
          unless bad.empty?
            raise ArgumentError,
                  "log :#{name} include: unknown field(s) #{bad.map { |f| ":#{f}" }.join(', ')}."
          end
          entry['include'] = inc
          g = (granularity || :run).to_s
          unless Cambium::LogProfileBuilder::VALID_GRANULARITIES.include?(g)
            raise ArgumentError, "log :#{name} granularity: must be :run or :step (got :#{g})"
          end
          entry['granularity'] = g
          entry['endpoint']    = endpoint    unless endpoint.nil?
          entry['api_key_env'] = api_key_env unless api_key_env.nil?
          _cambium_pipeline_defaults['log'] << entry
        end
      end

      # ===== Operators =====

      # step :triage, gen: TriageGen, method: :assess, with: { ctx: bind(:input).pr }
      def step(name, gen:, method: nil, with: nil)
        op = { 'kind' => 'Step', 'id' => name.to_s, 'gen' => gen.to_s }
        op['method'] = method.to_s if method
        op['with']   = Cambium::Pipeline._cambium_normalize_with(with) if with && !with.empty?
        _cambium_pipeline_defaults['operators'] << op
      end

      # fan_out :reviewers, collect_into: :reviews do ... end
      def fan_out(name, collect_into:, &block)
        dsl = FanOutDSL.new
        dsl.instance_eval(&block) if block
        _cambium_pipeline_defaults['operators'] << Cambium::Pipeline._cambium_build_fan_out_op(name, collect_into, dsl)
      end

      # branch_on bind(:triage).severity do
      #   on :critical do ... end
      #   default do ... end
      # end
      def branch_on(signal_ref, &block)
        unless signal_ref.is_a?(BindRef)
          raise ArgumentError, "branch_on: signal must be a bind(...) reference (got #{signal_ref.class})"
        end
        dsl = BranchOnDSL.new
        dsl.instance_eval(&block) if block
        _cambium_pipeline_defaults['operators'] << Cambium::Pipeline._cambium_build_branch_on_op(signal_ref, dsl)
      end

      # ===== Output composition =====

      # output do
      #   severity bind(:triage).severity
      #   plan     bind(:remediate).plan
      # end
      def output(&block)
        raise ArgumentError, "output requires a block" unless block
        dsl = OutputDSL.new
        dsl.instance_eval(&block)
        _cambium_pipeline_defaults['output'] = { 'kind' => 'compose', 'fields' => dsl._fields }
      end

      # ===== bind() helper =====
      def bind(target)
        BindRef.new(target)
      end

      # ===== Internal helpers (shared between class-level operators
      # and BranchBodyDSL nested operators) =====

      def _cambium_normalize_with(with_hash)
        with_hash.each_with_object([]) do |(param, value), acc|
          if value.is_a?(BindRef)
            acc << { 'param' => param.to_s, 'from' => value.to_ir }
          else
            acc << { 'param' => param.to_s, 'from' => { 'literal' => value } }
          end
        end
      end

      def _cambium_build_fan_out_op(name, collect_into, dsl)
        op = {
          'kind'              => 'FanOut',
          'id'                => name.to_s,
          'collect_into'      => collect_into.to_s,
          'branches'          => dsl._branches.dup,
          'on_branch_failure' => dsl._on_branch_failure,
          'require'           => dsl._require_threshold
        }
        op['concurrency']   = dsl._concurrency  if dsl._concurrency
        op['pass_context']  = dsl._pass_context if dsl._pass_context
        op['_homogeneous']  = dsl._homogeneous  if dsl._homogeneous
        op
      end

      def _cambium_build_branch_on_op(signal_ref, dsl)
        op = {
          'kind'     => 'BranchOn',
          'signal'   => signal_ref.to_ir,
          'branches' => dsl._branches.dup
        }
        op['default'] = dsl._default if dsl._default
        op
      end

      # Per-slot accumulator — identical shape to GenModel's, so policy
      # pack inheritance into sub-gens works through the same per-slot
      # mixing rule (RED-214).
      def _cambium_add_slots(primitive, new_slots, source:)
        state = _cambium_pipeline_defaults[primitive.to_s] ||= { 'slots' => {}, 'sources' => {}, 'packs' => [] }
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

      # Discovery for app/policies / app/log_profiles, anchored from the
      # pipeline file's directory. A pipeline lives at
      # `<workspace>/app/pipelines/<name>.pipeline.rb`; policies/log_profiles
      # live as siblings under `<workspace>/app/<subdir>/`.
      def _cambium_policy_search_dirs
        _cambium_discovery_dirs('policies')
      end

      def _cambium_log_profile_search_dirs
        _cambium_discovery_dirs('log_profiles')
      end

      def _cambium_discovery_dirs(subdir)
        dirs = []
        if (src = Cambium::CompilerState.current_source_file)
          pipe_dir = File.dirname(File.expand_path(src))
          if File.exist?(File.join(pipe_dir, Cambium::ENGINE_SENTINEL))
            return [pipe_dir]
          end
          dirs << pipe_dir
          # Pipelines live at <pkg>/app/pipelines/<name>.pipeline.rb;
          # sibling app/<subdir>/ is one level up + the subdir.
          dirs << File.join(File.dirname(pipe_dir), subdir)
        end
        dirs << File.join('packages', 'cambium', 'app', subdir)
        dirs.uniq
      end
    end
  end

  # Extend Registry to track pipelines alongside gens.
  class Registry
    class << self
      def register_pipeline_class(klass)
        pipeline_classes << klass
      end

      def pipeline_classes
        @pipeline_classes ||= []
      end
    end
  end

  # Pipeline → IR emission. Mirrors compile.rb's gen-emission flow but
  # for the Pipeline IR shape (see N - Orchestration Layer § IR shape).
  #
  # Per-class state (input, policies, memory, operators, output) is
  # shared across all the pipeline's compiled methods; per-method state
  # is `entry.method` only — for a 1:1 pipeline class, this is the
  # single user-declared method.
  module PipelineCompiler
    module_function

    PIPELINE_VERSION = '0.2'.freeze

    # Top-level entry point invoked from compile.rb when a Pipeline
    # subclass is detected after `load file`. Returns either a single IR
    # hash (when requested_method is given — `cambium run`/engine-mode
    # `cambium compile --method X`) or a {method => IR} map (when
    # requested_method is nil — `cambium serve` boot).
    def emit(klass, file, arg, requested_method)
      defs = klass._cambium_pipeline_defaults

      methods_to_compile = resolve_methods_to_compile(klass, requested_method)
      validate_file_basename!(file)
      validate_input_schemas(defs, file)
      Validator.validate!(klass, defs)

      schedules = resolve_schedules(klass, defs, methods_to_compile)

      per_method = {}
      methods_to_compile.each do |m|
        per_method[m] = build_ir(klass, defs, file, m, arg, schedules)
      end
      per_method
    end

    # RED-381 Phase A.3: pipeline files live at
    # `<workspace>/app/pipelines/<name>.pipeline.rb`. The basename (after
    # stripping `.pipeline.rb`) MUST match /^[a-z][a-z0-9_]*\z/ — same
    # stance as policy pack names (RED-214), memory pool names (RED-215),
    # corrector basenames (RED-275), and grounded_in sources (RED-283).
    # An oddly-shaped basename (`Foo`, `bar-baz`, `2cool`) would otherwise
    # interpolate into IR paths or scope keys that don't match the rest
    # of Cambium's identifier surface.
    PIPELINE_BASENAME_RE = /\A[a-z][a-z0-9_]*\z/.freeze

    def validate_file_basename!(file)
      basename = File.basename(file).sub(/\.pipeline\.rb\z/, '')
      return if basename =~ PIPELINE_BASENAME_RE
      raise Cambium::CompileError,
            "Pipeline file basename '#{basename}' must match " \
            "/#{PIPELINE_BASENAME_RE.source}/ (e.g. ci_review.pipeline.rb, " \
            "incident_response.pipeline.rb). Got: '#{File.basename(file)}'."
    end

    # 1:1 is a class-level structural invariant (RED-374 design decision),
    # not a CLI convenience. Enforce regardless of whether --method is passed:
    # the class MUST declare exactly one public method, and --method (if
    # supplied) MUST match it.
    def resolve_methods_to_compile(klass, requested)
      user_methods = (klass.public_instance_methods(false) - Object.instance_methods).map(&:to_s).sort
      if user_methods.empty?
        raise Cambium::CompileError,
              "No public methods found on #{klass.name}. " \
              "Pipeline classes declare exactly one entry method " \
              "(1:1 class/method/chain stance — see RED-374)."
      end
      if user_methods.length > 1
        raise Cambium::CompileError,
              "#{klass.name} declares multiple public methods (#{user_methods.map { |m| ":#{m}" }.join(', ')}). " \
              "Pipeline classes are 1:1 — one class, one method, one chain. " \
              "Split into one Pipeline class per chain."
      end
      method = user_methods.first
      if requested && requested != method
        raise Cambium::CompileError,
              "--method #{requested} does not match #{klass.name}'s declared entry " \
              "method :#{method}. Pipeline classes have exactly one entry; either " \
              "omit --method or pass --method #{method}."
      end
      [method]
    end

    # Validate every `input :name, schema: X` against the workspace's
    # contracts.ts. Same best-effort stance as compile.rb's `returns`
    # validation: skip silently when no contracts file is discoverable;
    # raise CompileError on a name miss when validation can run.
    def validate_input_schemas(defs, file)
      inputs = defs['inputs']
      return if inputs.nil? || inputs.empty?

      contracts_candidates = contracts_candidates_for(file)
      return if contracts_candidates.empty?

      all_exports = []
      contracts_candidates.each do |cf|
        content = File.read(cf)
        content.scan(/^\s*export\s+const\s+([A-Z][A-Za-z0-9_]*)\b/) { |m| all_exports << m[0] }
      end
      all_exports.uniq!

      inputs.each do |name, info|
        schema = info['schema']
        next if all_exports.include?(schema)
        suggestion = all_exports.find { |e| e.downcase == schema.downcase }
        hint = suggestion ? "\n\nDid you mean '#{suggestion}'?" : ''
        raise Cambium::CompileError,
              "Unknown schema '#{schema}' on input :#{name} in #{file}.\n\n" \
              "Available schemas (from #{contracts_candidates.join(', ')}):\n  " \
              "#{all_exports.sort.join("\n  ")}#{hint}"
      end
    end

    def contracts_candidates_for(file)
      pipe_dir = File.dirname(File.expand_path(file))
      workspace_dir = File.dirname(File.dirname(pipe_dir)) # up TWO from app/pipelines/
      engine_sibling = File.join(pipe_dir, 'schemas.ts')
      [
        engine_sibling,
        File.join(workspace_dir, 'src', 'contracts.ts')
      ].uniq.select { |p| File.exist?(p) }
    end

    # Resolve method defaults + final schedule IDs. Same shape as compile.rb's
    # gen-side schedule resolution: each cron entry's `method:` defaults to
    # the gen's single user-declared method; duplicate slugs raise.
    def resolve_schedules(klass, defs, methods_to_compile)
      raw = (defs['schedules'] || [])
      return [] if raw.empty?

      raw.each do |s|
        next if s['method']
        if methods_to_compile.length == 1
          s['method'] = methods_to_compile.first
        else
          raise Cambium::CompileError,
                "cron declaration on #{klass.name} has no resolvable method."
        end
      end

      pipeline_snake = klass.name.to_s
                              .gsub(/::/, '_')
                              .gsub(/([A-Z]+)([A-Z][a-z])/, '\1_\2')
                              .gsub(/([a-z\d])([A-Z])/, '\1_\2')
                              .downcase

      resolved = raw.map do |s|
        full_id = "#{pipeline_snake}.#{s['method']}.#{s['slug']}"
        entry = {
          'id'         => full_id,
          'expression' => s['expression'],
          'method'     => s['method'],
          'tz'         => s['tz']
        }
        entry['named'] = s['named'] if s['named']
        entry['at']    = s['at']    if s['at']
        entry
      end

      seen = {}
      resolved.each do |s|
        if seen[s['id']]
          raise Cambium::CompileError,
                "duplicate schedule id '#{s['id']}' on #{klass.name}."
        end
        seen[s['id']] = true
      end

      resolved
    end

    # RED-381 Phase A.3: cross-validation of bind() refs + branch_on
    # exhaustiveness. Runs after methods + schemas resolve, before
    # build_ir, so errors surface with the source still in scope.
    #
    # Field-level introspection (proving that bind(:step).field actually
    # exists on the step's TypeBox `returns` schema) requires parsing
    # contracts.ts — out of scope for v1. Phase A.3 validates the
    # reference SHAPE (input slot exists, step is declared, ordering),
    # leaving field-name mismatches for the runner to surface. Adding
    # full schema-aware introspection later is purely additive.
    module Validator
      module_function

      def validate!(klass, defs)
        operators   = defs['operators']
        input_names = defs['inputs'].keys
        all_op_ids  = operators.map { |o| o['id'] }.compact

        operators.each_with_index do |op, idx|
          prior_op_ids = operators[0...idx].map { |o| o['id'] }.compact
          validate_operator!(op, input_names, prior_op_ids, klass)
        end

        validate_output!(defs['output'], input_names, all_op_ids, klass)
      end

      def validate_operator!(op, input_names, prior_op_ids, klass)
        case op['kind']
        when 'Step'
          validate_with!(op['with'], op['id'], input_names, prior_op_ids, klass)
        when 'FanOut'
          # fan_out branches don't carry `with:` clauses in v1; the
          # `pass_context` field is validated by FanOutDSL at decl time.
        when 'BranchOn'
          validate_branch_on!(op, input_names, prior_op_ids, klass)
        end
      end

      def validate_with!(with_array, op_id, input_names, prior_op_ids, klass)
        return unless with_array
        with_array.each do |entry|
          from = entry['from']
          if from.key?('input')
            validate_input_ref!(from['input'], "operator :#{op_id}", input_names, klass)
          elsif from.key?('step')
            validate_step_ref!(from['step'], from['field'], "operator :#{op_id}", prior_op_ids, klass)
          end
          # `literal` values need no validation — anything goes.
        end
      end

      def validate_branch_on!(op, input_names, prior_op_ids, klass)
        sig = op['signal']
        unless sig.is_a?(Hash) && sig['step']
          raise Cambium::CompileError,
                "branch_on on #{klass.name} must use a bind(:step_id).field signal " \
                "(got bind(:input).field — not yet supported)."
        end

        unless prior_op_ids.include?(sig['step'])
          raise Cambium::CompileError,
                "branch_on on #{klass.name} references signal bind(:#{sig['step']}).#{sig['field']} " \
                "but :#{sig['step']} is not declared before this branch_on. " \
                "Declared earlier: #{prior_op_ids.empty? ? '(none)' : prior_op_ids.map { |i| ":#{i}" }.join(', ')}."
        end

        has_on       = op['branches'] && !op['branches'].empty?
        has_default  = !op['default'].nil?

        unless has_on || has_default
          raise Cambium::CompileError,
                "branch_on on #{klass.name} declares neither an `on` clause nor a " \
                "`default` block — the operator would never fire."
        end

        # Phase A.3 stance: every branch_on MUST have an explicit
        # `default do ... end` block. The design note allows either
        # "every enum value matched" OR "explicit default"; v1 doesn't
        # introspect TypeBox enum domains, so the "every enum value
        # matched" path can't be verified at compile time. Requiring
        # default is the conservative cut — full enum coverage as an
        # alternative is purely additive when schema introspection
        # lands. See N - Orchestration Layer § branch_on exhaustiveness.
        unless has_default
          raise Cambium::CompileError,
                "branch_on on #{klass.name} requires an explicit `default do ... end` " \
                "block in v1. (Compile-time enum-coverage checking would let you omit " \
                "the default when every signal enum value is matched, but Cambium " \
                "doesn't yet introspect TypeBox schemas; until then, default is " \
                "mandatory. See N - Orchestration Layer § branch_on exhaustiveness.)"
        end

        # Recurse into nested operators. Their visibility expands to
        # include all prior operators in the outer scope plus any earlier
        # siblings inside the same block.
        (op['branches'] || []).each do |br|
          validate_nested_operators!(br['operators'], input_names, prior_op_ids, klass)
        end
        validate_nested_operators!(op['default'], input_names, prior_op_ids, klass) if has_default
      end

      def validate_nested_operators!(nested, input_names, outer_prior_ids, klass)
        return if nested.nil? || nested.empty?
        local_prior = outer_prior_ids.dup
        nested.each do |nop|
          validate_operator!(nop, input_names, local_prior, klass)
          local_prior << nop['id'] if nop['id']
        end
      end

      def validate_output!(output, input_names, all_op_ids, klass)
        return unless output.is_a?(Hash) && output['kind'] == 'compose'
        (output['fields'] || []).each do |f|
          from = f['from']
          if from.key?('input')
            validate_input_ref!(from['input'], "output field :#{f['name']}", input_names, klass)
          elsif from.key?('step')
            unless all_op_ids.include?(from['step'])
              raise Cambium::CompileError,
                    "output field :#{f['name']} on #{klass.name} references step " \
                    ":#{from['step']} but no operator with that id is declared. " \
                    "Declared operators: " \
                    "#{all_op_ids.empty? ? '(none)' : all_op_ids.map { |i| ":#{i}" }.join(', ')}."
            end
          end
        end
      end

      def validate_input_ref!(input_name, context, input_names, klass)
        # bind(:input) with no chained field returns { 'input' => true };
        # bind(:input).foo returns { 'input' => 'foo' }. Both forms need
        # at least one declared input slot to make sense.
        if input_name == true
          if input_names.empty?
            raise Cambium::CompileError,
                  "#{context} on #{klass.name} uses bind(:input) but the pipeline " \
                  "declares no `input :name, schema: ...` slots."
          end
          return
        end
        return if input_names.include?(input_name)
        raise Cambium::CompileError,
              "#{context} on #{klass.name} references unknown input slot " \
              "bind(:input).#{input_name}. Declared inputs: " \
              "#{input_names.empty? ? '(none)' : input_names.map { |n| ":#{n}" }.join(', ')}."
      end

      def validate_step_ref!(step_id, field, context, prior_op_ids, klass)
        return if prior_op_ids.include?(step_id)
        raise Cambium::CompileError,
              "#{context} on #{klass.name} references bind(:#{step_id})" \
              "#{field ? ".#{field}" : ''} but :#{step_id} is not declared " \
              "before this operator. Declared earlier: " \
              "#{prior_op_ids.empty? ? '(none)' : prior_op_ids.map { |i| ":#{i}" }.join(', ')}."
      end
    end

    def build_ir(klass, defs, file, method, arg, schedules)
      {
        'version' => PIPELINE_VERSION,
        'kind'    => 'Pipeline',
        'name'    => klass.name,
        'entry'   => { 'class' => klass.name, 'method' => method, 'source' => file },
        'input'   => defs['inputs'],
        'policies' => {
          'budget'        => defs['budget'].empty? ? nil : defs['budget'],
          'security'      => Cambium.flatten_slot_state(defs['security']),
          'bind_defaults' => defs['bind_defaults'],
          'memory'        => defs['memory'],
          'schedules'     => schedules,
          'log'           => defs['log'],
          'log_profiles'  => defs['log_profiles']
        }.compact,
        'operators' => defs['operators'],
        'output'    => defs['output'] || { 'kind' => 'last_step' },
        # Pipeline runtime caller is expected to populate one input slot
        # per `input :name` decl. compile-time arg is recorded as a single
        # `_pipeline_arg` so existing `cambium run --arg <path>` flows can
        # smoke a pipeline before the runner is wired (Phase B).
        'context' => { '_pipeline_arg' => arg }
      }
    end
  end
end
