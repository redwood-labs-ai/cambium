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

# Load the DSL file (defines GenModel subclasses).
# Track the source file so symbol-resolution primitives (security :pack,
# budget :pack, system :name) know which package to look in.
Cambium::CompilerState.current_source_file = file
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

# RED-210: validate `returns <Schema>` against the package's contracts.ts
# BEFORE the runner sees the IR. A typo here used to surface as an obscure
# "Schema not found in contracts.ts for id: ..." at runtime startup; now
# it fails at compile time with a list of valid schema names.
if (schema_name = defs[:returnSchema])
  pkg_dir = File.dirname(File.dirname(File.expand_path(file)))  # up from app/gens/
  contracts_candidates = [
    File.join(pkg_dir, 'src', 'contracts.ts'),
    File.join('packages', 'cambium', 'src', 'contracts.ts'),
  ].uniq.select { |p| File.exist?(p) }

  # If no contracts file is discoverable, skip — the runner will still
  # catch the typo, and we don't want to block compile on arbitrary
  # contracts layouts. Validation is best-effort but should be strict
  # when it can run.
  unless contracts_candidates.empty?
    all_exports = []
    found = false
    contracts_candidates.each do |cf|
      content = File.read(cf)
      content.scan(/^\s*export\s+const\s+([A-Z][A-Za-z0-9_]*)\b/) do |m|
        all_exports << m[0]
      end
      found = true if content.match?(/^\s*export\s+const\s+#{Regexp.escape(schema_name)}\b/)
    end

    unless found
      available = all_exports.uniq.sort
      suggestion = available.find { |e| e.downcase == schema_name.downcase } ||
                   available.find { |e| e.start_with?(schema_name) || schema_name.start_with?(e) }
      hint = suggestion ? "\n\nDid you mean '#{suggestion}'?" : ''
      raise Cambium::CompileError,
            "Unknown schema '#{schema_name}' referenced by `returns` in #{file}.\n\n" \
            "Available schemas (from #{contracts_candidates.join(', ')}):\n  " \
            "#{available.join("\n  ")}" \
            "#{hint}"
    end
  end
end

# Resolve system prompt: symbol → file lookup, string → inline, nil → omit.
system_prompt = nil
if defs[:system]
  raw = defs[:system]
  if raw.is_a?(Symbol) || raw.is_a?(Cambium::ConstRef)
    name = raw.to_s.downcase
    # Look for app/systems/<name>.system.md relative to the source file's package
    pkg_dir = File.dirname(File.dirname(File.expand_path(file)))  # up from app/gens/
    system_file = File.join(pkg_dir, 'app', 'systems', "#{name}.system.md")
    unless File.exist?(system_file)
      # Also try relative to cwd
      system_file = File.join('packages', 'cambium', 'app', 'systems', "#{name}.system.md")
    end
    if File.exist?(system_file)
      system_prompt = File.read(system_file).strip
    else
      raise Cambium::CompileError, "System prompt '#{name}' not found. Looked for: #{system_file}"
    end
  else
    system_prompt = raw.to_s
  end
end

# RED-237: load workspace model aliases. A gen can reference a model
# or embed model by Symbol (`model :default`, `embed: :embedding`) and
# the compiler resolves it here to a concrete provider:literal. Absent
# file is fine — literals pass through unchanged either way.
model_aliases = Cambium::ModelAliases.load

# Resolve the primary model declaration. Literals pass through; Symbols
# and bare-name strings resolve against the aliases file.
if defs[:model]
  defs[:model] = model_aliases.resolve(defs[:model], context: "#{klass.name}.model")
end

# RED-215: resolve memory declarations against named pools.
#
# Each `memory :x, scope: :support_team, top_k: 5` on a gen becomes
# an entry in policies.memory. When scope is a named pool (not :session
# or :global), the pool's file is loaded and its authoritative slots
# (strategy/embed/keyed_by) are merged into the entry. Attempting to
# override a pool-owned slot at the gen site is a compile error.
#
# The runner (phase 3+) consumes the flattened entries plus the
# resolved pool definitions in `policies.memory_pools` — this is the
# same "one source of truth per slot" stance RED-214 took for policy
# packs, adapted to the per-decl shape of memory.
resolved_memory = []
resolved_pools  = {}
builtin_scopes  = %w[session global]

(defs[:memory] || []).each do |m|
  scope = m['scope']
  if builtin_scopes.include?(scope)
    if m['strategy'].nil?
      raise Cambium::CompileError,
            "memory '#{m['name']}' scope: :#{scope} needs `strategy:` " \
            "(:sliding_window, :semantic, :log)."
    end
    if m['strategy'] == 'semantic' && m['embed'].nil?
      raise Cambium::CompileError,
            "memory '#{m['name']}' declares strategy :semantic but no `embed:` model. " \
            "Add `embed \"omlx:bge-small-en\"` or `embed :embedding`."
    end
    # RED-237: resolve the decl's embed reference (alias → literal).
    if m['embed']
      m['embed'] = model_aliases.resolve(m['embed'], context: "memory '#{m['name']}' embed")
    end
    resolved_memory << m
  else
    # Named pool — load it (once; subsequent references hit the cache)
    # and enforce pool-owned-slot exclusivity.
    pool = (resolved_pools[scope] ||= begin
      loaded = Cambium::MemoryPool.load(scope, klass._cambium_memory_pool_search_dirs)
      slots = loaded.slots.dup
      # RED-237: resolve the pool's embed reference once; the resolved
      # literal ends up in policies.memory_pools and every memory decl
      # that merges it, so the runner never sees an unresolved alias.
      if slots['embed']
        slots['embed'] = model_aliases.resolve(slots['embed'], context: "memory_pool :#{scope} embed")
      end
      slots
    end)

    conflicts = Cambium::MemoryPool::POOL_OWNED_SLOTS.select { |k| m.key?(k) }
    unless conflicts.empty?
      raise Cambium::CompileError,
            "memory '#{m['name']}' scope: :#{scope} — the pool is the source of truth " \
            "for #{Cambium::MemoryPool::POOL_OWNED_SLOTS.join(', ')}. " \
            "Remove #{conflicts.map { |c| "`#{c}:`" }.join(' and ')} from the memory declaration " \
            "(edit the pool instead)."
    end

    merged = pool.merge(m) # pool fills strategy/embed/keyed_by; m supplies name/scope + reader knobs
    resolved_memory << merged
  end
end

# RED-239 v2: apply workspace memory policy. Loaded from
# app/config/memory_policy.rb (absent file = no policy, which is fine).
# Runs AFTER memory resolution so enforcement sees the final merged
# shape — pool-inherited retain, resolved scope, etc. Defaults are
# applied before enforcement so a default_ttl doesn't trip its own
# max_ttl. Violations raise CompileError with a pointer to the
# offending decl/pool and the policy file.
memory_policy = Cambium::MemoryPolicy.load
memory_policy.apply!(resolved_memory, resolved_pools)

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
  'system' => system_prompt,
  'mode' => defs[:mode],
  'policies' => {
    'tools_allowed' => (defs[:tools] || []),
    'correctors' => (defs[:correctors] || []),
    'constraints' => (defs[:constraints] || {}),
    'grounding' => defs[:grounding],
    'security' => Cambium.flatten_slot_state(defs[:security]),
    'budget'   => Cambium.flatten_slot_state(defs[:budget]),
    'memory'           => resolved_memory,
    'memory_pools'     => resolved_pools,
    'memory_write_via' => defs[:write_memory_via]
  },
  'reads_trace_of' => defs[:reads_trace_of],
  'returnSchemaId' => defs[:returnSchema],
  'context' => {
    'document' => arg
  },
  'enrichments' => (defs[:enrichments] || []),
  'signals' => (defs[:signals] || []),
  'triggers' => (defs[:triggers] || []),
  'steps' => builder.steps
}

puts JSON.pretty_generate(ir)
