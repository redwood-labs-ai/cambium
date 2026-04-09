# frozen_string_literal: true

require 'json'

module Cambium
  class CompileError < StandardError; end

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
