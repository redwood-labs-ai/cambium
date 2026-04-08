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
    end

    def generate(prompt)
      builder = Cambium::CompilerState.current_builder
      raise Cambium::CompileError, 'generate called outside compilation context' unless builder

      g = {
        'id' => 'generate',
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

  class Registry
    def self.register_model_class(klass)
      model_classes << klass
    end

    def self.model_classes
      @model_classes ||= []
    end
  end
end
