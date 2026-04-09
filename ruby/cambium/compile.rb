# frozen_string_literal: true

require 'json'
require_relative './runtime'

# Make GenModel available at top-level for the Ruby DSL.
GenModel = Cambium::GenModel unless defined?(GenModel)

def usage(msg = nil)
  warn("\n#{msg}") if msg
  warn <<~TXT

    Usage:
      ruby ruby/cambium/compile.rb <file.cmb.rb> --method <method> --arg <path>|-

    Emits IR JSON to stdout.
  TXT
  exit 2
end

file = ARGV.shift
usage('Missing .cmb.rb file') unless file

method = nil
arg_path = nil

while (a = ARGV.shift)
  case a
  when '--method'
    method = ARGV.shift
  when '--arg'
    arg_path = ARGV.shift
  else
    usage("Unknown arg: #{a}")
  end
end
usage('Missing --method') unless method
usage('Missing --arg') unless arg_path

# Allow referencing undeclared constants (like TypeBox schema IDs) by returning a ConstRef.
orig_module_const_missing = Module.instance_method(:const_missing)
Module.define_method(:const_missing) do |name|
  Cambium::ConstRef.new(name.to_s)
end

# Load the DSL file (defines GenModel subclasses)
load file

klass = Cambium::Registry.model_classes.last
raise Cambium::CompileError, "No GenModel subclass found after loading #{file}" unless klass

arg = if arg_path == '-'
        STDIN.read
      else
        File.read(arg_path)
      end

builder = Cambium::PlanBuilder.new
Cambium::CompilerState.current_builder = builder

begin
  inst = klass.new
  inst.public_send(method, arg)
ensure
  Cambium::CompilerState.current_builder = nil
  Module.define_method(:const_missing, orig_module_const_missing)
end

defs = klass._cambium_defaults

ir = {
  'version' => '0.2',
  'entry' => {
    'class' => klass.name,
    'method' => method,
    'source' => file
  },
  'model' => {
    'id' => defs[:model],
    'temperature' => defs[:temperature],
    'max_tokens' => defs[:max_tokens]
  },
  'policies' => {
    'tools_allowed' => (defs[:tools] || []),
    'correctors' => (defs[:correctors] || []),
    'constraints' => (defs[:constraints] || {})
  },
  'returnSchemaId' => defs[:returnSchema],
  'context' => {
    'document' => arg
  },
  'signals' => (defs[:signals] || []),
  'triggers' => (defs[:triggers] || []),
  'steps' => builder.steps
}

puts JSON.pretty_generate(ir)
