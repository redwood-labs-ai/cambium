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
      candidates = search_dirs.map { |d| File.join(d, "#{name}.policy.rb") }
      file = candidates.find { |f| File.exist?(f) }
      if file.nil?
        raise CompileError,
              "Policy pack '#{name}' not found. Looked for:\n  " + candidates.join("\n  ")
      end

      pack = new(name)
      builder = PolicyPackBuilder.new(pack)
      builder.instance_eval(File.read(file), file)
      pack
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
