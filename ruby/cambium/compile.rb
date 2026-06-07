# frozen_string_literal: true

require 'json'
require_relative './runtime'
require_relative './pipeline'

# Make GenModel + Pipeline available at top-level for the Ruby DSL.
GenModel = Cambium::GenModel unless defined?(GenModel)
Pipeline = Cambium::Pipeline unless defined?(Pipeline)

def usage(msg = nil)
  warn("\n#{msg}") if msg
  warn <<~TXT

    Usage:
      ruby ruby/cambium/compile.rb <file.cmb.rb> --method <method> [--arg <path>|-]

    Emits IR JSON to stdout. --arg is optional; when omitted, an empty
    string is supplied to the gen method (the runtime caller is expected
    to override ir.context.* fields before execution).
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
# RED-360: --method became optional. When omitted, compile.rb enumerates
# every public user method on the loaded GenModel and emits a JSON map
# `{ method_name => ir }`. This is the shape `cambium serve` consumes at
# boot to populate its IR cache (one Ruby invocation per gen vs. N).
#
# When --method IS passed: behavior unchanged — emit a single IR. Engine-
# mode build steps (`cambium compile <file> --method X`) keep working
# bit-for-bit identically.
#
# --arg is still optional (RED-244): when omitted, an empty string is
# supplied to each gen method (the runtime caller is expected to override
# ir.context.* fields before execution).

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

arg = if arg_path.nil?
        ''
      elsif arg_path == '-'
        STDIN.read
      else
        File.read(arg_path)
      end

# RED-381 Phase A: dispatch to PipelineCompiler when a Pipeline subclass
# is registered. Pipeline files declare `class Foo < Pipeline`; gen files
# declare `class Foo < GenModel`. The two registries are distinct, so a
# single .cmb.rb / .pipeline.rb file unambiguously routes to one path.
# Pipeline takes precedence when both exist (shouldn't happen in practice
# — one file, one declaration), and the existing gen path is otherwise
# untouched.
if (pipeline_klass = Cambium::Registry.pipeline_classes.last)
  # Always restore const_missing before exit — gen path does this via
  # ensure; mirror it here.
  begin
    irs = Cambium::PipelineCompiler.emit(pipeline_klass, file, arg, method)
  ensure
    Module.define_method(:const_missing, orig_module_const_missing)
  end
  if method
    puts JSON.pretty_generate(irs[method])
  else
    puts JSON.pretty_generate(irs)
  end
  exit 0
end

klass = Cambium::Registry.model_classes.last
raise Cambium::CompileError, "No GenModel or Pipeline subclass found after loading #{file}" unless klass

# Determine which methods to compile. With --method, just that one.
# Without, enumerate every public user method on the GenModel — the
# all-methods compile path is what `cambium serve` boot uses.
methods_to_compile =
  if method
    [method]
  else
    user_methods = (klass.public_instance_methods(false) - Object.instance_methods).map(&:to_s).sort
    if user_methods.empty?
      raise Cambium::CompileError,
            "No public methods found on #{klass.name} in #{file}. " \
            "Either define a method or pass --method <name> explicitly."
    end
    user_methods
  end

# Compile each requested method into its own IR. Per-method state is just
# the PlanBuilder (and the resulting `steps`); per-class state is computed
# once below.
per_method_steps = {}
begin
  methods_to_compile.each do |m|
    builder = Cambium::PlanBuilder.new
    Cambium::CompilerState.current_builder = builder
    begin
      inst = klass.new
      inst.public_send(m, arg)
    ensure
      Cambium::CompilerState.current_builder = nil
    end
    per_method_steps[m] = builder.steps
  end
ensure
  # Restore const_missing once, after all methods compile (or on exception).
  # Per-method ensure blocks above only restore current_builder.
  Module.define_method(:const_missing, orig_module_const_missing)
end

defs = klass._cambium_defaults

# RED-210: validate `returns <Schema>` against the package's contracts.ts
# BEFORE the runner sees the IR. A typo here used to surface as an obscure
# "Schema not found in contracts.ts for id: ..." at runtime startup; now
# it fails at compile time with a list of valid schema names.
#
# RED-287: engine-mode gens source schemas from `<engineDir>/schemas.ts`
# (a sibling of the gen) rather than `<pkg>/src/contracts.ts`. The
# engine candidate is prepended so a single walk covers both shapes.
#
# RED-373: walk up TWO levels from gen_dir (app/gens) to the workspace
# root where src/contracts.ts lives. Earlier versions had two issues
# stacked: the workspace dir was one level too shallow (just `app/`), and
# a cwd-relative `packages/cambium/src/contracts.ts` fallback could match
# the WRONG workspace's contracts when the operator ran from a Cambium
# repo cwd pointed at an external workspace via `--workspace`. The
# fallback is gone now; post-0.3.3 (RED-353) the TS runtime walks up
# from `ir.entry.source` for contracts, so compile-time validation can
# rely on the same source-anchored discovery.
if (schema_name = defs[:returnSchema])
  gen_dir = File.dirname(File.expand_path(file))
  workspace_dir = File.dirname(File.dirname(gen_dir))  # up TWO from app/gens/
  engine_sibling = File.join(gen_dir, 'schemas.ts')
  contracts_candidates = [
    engine_sibling,
    File.join(workspace_dir, 'src', 'contracts.ts'),
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
#
# Search layers mirror the RED-245 discovery pattern used by policy
# packs and memory pools. Engine-mode authoring puts the system prompt
# next to the gen file; app-mode keeps the existing app/systems/
# convention; the workspace fallback covers gens invoked from the repo
# root. When a cambium.engine.json sentinel sits next to the gen, only
# the gen-local dir is consulted (no walk-up). Surfaced by the RED-220 POC.
system_prompt = nil
if defs[:system]
  raw = defs[:system]
  if raw.is_a?(Symbol) || raw.is_a?(Cambium::ConstRef)
    name = raw.to_s.downcase
    # Path-traversal guard: the name is interpolated into File.join directly.
    # Every sibling symbol→path site uses this regex; system: was the lone
    # omission — confirmed as an invariant gap in the 2026-06-06 audit (AUD-005).
    unless name =~ /\A[a-z][a-z0-9_]*\z/
      raise Cambium::CompileError,
            "system: '#{raw}' is not a valid system prompt name. " \
            "Must match /\\A[a-z][a-z0-9_]*\\z/ (lowercase letters, digits, underscores). " \
            "Use a string literal for inline prompts."
    end
    gen_dir = File.dirname(File.expand_path(file))
    candidates =
      if File.exist?(File.join(gen_dir, 'cambium.engine.json'))
        [File.join(gen_dir, "#{name}.system.md")]
      else
        [
          File.join(gen_dir, "#{name}.system.md"),
          File.join(File.dirname(gen_dir), 'systems', "#{name}.system.md"),
          File.join('packages', 'cambium', 'app', 'systems', "#{name}.system.md"),
        ].uniq
      end
    system_file = candidates.find { |p| File.exist?(p) }
    if system_file
      system_prompt = File.read(system_file).strip
    else
      raise Cambium::CompileError,
            "System prompt '#{name}' not found. Looked for:\n  " + candidates.join("\n  ")
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
builtin_scopes  = %w[session global schedule]
# RED-381 Phase E: :pipeline_run is a scope where the pipeline (not the
# gen) owns strategy/embed/keyed_by/retain. The gen-side decl is an
# opt-in stub — it declares the slot name + optional reader knobs, and
# the pipeline runtime injects the authoritative slot config at sub-gen
# dispatch time. Same source-of-truth stance as named pools (RED-215),
# applied to pipeline-level memory slots.
pipeline_authoritative_scopes = %w[pipeline_run]
pipeline_authoritative_slots  = %w[strategy embed keyed_by retain]

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
  elsif pipeline_authoritative_scopes.include?(scope)
    # Pipeline-authoritative scope. Gen-side decl must NOT carry
    # pool-owned slots — the pipeline's slot definition is the source
    # of truth. Reader knobs (size, top_k) are allowed and override
    # the pipeline's defaults per-gen.
    conflicts = pipeline_authoritative_slots.select { |k| m.key?(k) }
    unless conflicts.empty?
      raise Cambium::CompileError,
            "memory '#{m['name']}' scope: :#{scope} — the pipeline is the source of truth " \
            "for #{pipeline_authoritative_slots.join(', ')}. " \
            "Remove #{conflicts.map { |c| "`#{c}:`" }.join(' and ')} from the gen-side decl " \
            "(edit the pipeline's memory slot instead). See N - Orchestration Layer § Pipeline memory."
    end
    # Pass through with name + scope + reader knobs only. The pipeline
    # runtime merges in strategy/embed/keyed_by/retain at sub-gen
    # dispatch time (pipeline.ts injectPipelineMemorySlots).
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

# RED-238: final check for `query:` / `arg_field:` — must run after
# pool resolution because pool-scoped decls only learn their strategy
# here (the pool is authoritative). The DSL catches the gen-side
# explicit-strategy case; this catches the pool-scoped case.
resolved_memory.each do |m|
  next if m['query'].nil? && m['arg_field'].nil?
  if m['strategy'] != 'semantic'
    key = m['query'].nil? ? 'arg_field' : 'query'
    raise Cambium::CompileError,
          "memory '#{m['name']}': `#{key}:` is only valid on strategy :semantic " \
          "(resolved strategy is :#{m['strategy']}#{m['scope'] && !%w[session global].include?(m['scope']) ? " via pool :#{m['scope']}" : ''})."
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

# RED-273 / RED-305: resolve schedule IDs + method defaults + validate
# `scope: :schedule` memory pairing.
raw_schedules = (defs[:schedules] || [])
# Resolve method defaults: a cron entry without an explicit `method:`
# falls back to the gen's single user-defined public method. If the
# gen declares multiple methods and `method:` was omitted, raise.
user_methods = (klass.public_instance_methods(false) - Object.instance_methods).map(&:to_s).sort
raw_schedules.each do |s|
  next if s['method']
  if user_methods.length == 1
    s['method'] = user_methods.first
  elsif user_methods.empty?
    raise Cambium::CompileError,
          "cron declaration on #{klass.name} has no resolvable method — the class " \
          "defines no public methods. Declare your entry method before the class ends."
  else
    raise Cambium::CompileError,
          "cron declaration on #{klass.name} requires explicit `method:` because " \
          "the class defines multiple public methods: " \
          "#{user_methods.map { |m| ":#{m}" }.join(', ')}."
  end
end

# Compute final schedule IDs and emit the resolved array. ID shape:
# <snake_gen>.<method>.<slug>. Duplicate IDs (which can happen when
# different slugs collide after method resolution) raise.
gen_snake = klass.name.to_s.gsub(/::/, '_').gsub(/([A-Z]+)([A-Z][a-z])/, '\1_\2').gsub(/([a-z\d])([A-Z])/, '\1_\2').downcase
resolved_schedules = raw_schedules.map do |s|
  full_id = "#{gen_snake}.#{s['method']}.#{s['slug']}"
  entry = {
    'id' => full_id,
    'expression' => s['expression'],
    'method' => s['method'],
    'tz' => s['tz'],
  }
  entry['named'] = s['named'] if s['named']
  entry['at']    = s['at']    if s['at']
  entry
end
seen_ids = {}
resolved_schedules.each do |s|
  if seen_ids[s['id']]
    raise Cambium::CompileError,
          "duplicate schedule id '#{s['id']}' on #{klass.name}. " \
          "Use `cron ..., id: :unique_name` to disambiguate."
  end
  seen_ids[s['id']] = true
end

# Validate memory `scope: :schedule` requires at least one cron decl.
resolved_memory.each do |m|
  next unless m['scope'] == 'schedule'
  if resolved_schedules.empty?
    raise Cambium::CompileError,
          "memory '#{m['name']}' declares `scope: :schedule` but #{klass.name} has no " \
          "`cron` declarations. A schedule-scoped memory bucket needs a schedule " \
          "identity — add `cron :daily` (or similar) to the gen, or change the scope."
  end
end

# RED-383 (minimum cut): resolve `grounded_in :source, from: "<path>"`
# to an actual context value at compile time. CLI `--arg` overrides at
# runtime (testing stays easy: swap fixtures via --arg without
# editing the .cmb.rb). URL fetching + magic-byte sniffing for files
# without recognized extensions defer to a follow-up (RED-383 v2).
#
# Path resolution: absolute paths pass through; relative paths anchor
# to the gen file's directory (not cwd) so a gen compiles the same
# way regardless of where the operator runs it from.
#
# Content-type by extension: .pdf → base64_pdf envelope, .png/.jpg/
# .jpeg/.webp/.gif → base64_image envelope (reuses RED-323's envelope
# normalization downstream), anything else → text. The runner's
# documents.ts already accepts these envelope shapes for both
# Anthropic native PDF blocks and the extracted-text path for other
# providers.
effective_grounding_value = nil
if defs[:grounding] && defs[:grounding]['from']
  from_path = defs[:grounding]['from']
  source_name = defs[:grounding]['source']
  gen_dir = File.dirname(File.expand_path(file))
  # File.expand_path with a base: relative paths anchor to gen_dir,
  # absolute paths pass through (base ignored). Works on every Ruby
  # version Cambium supports — File.absolute_path? is 3.1+.
  full_path = File.expand_path(from_path, gen_dir)

  unless File.exist?(full_path)
    raise Cambium::CompileError,
          "grounded_in :#{source_name} from: #{from_path.inspect} — file not found at #{full_path}. " \
          "Relative paths resolve from the gen's directory (#{gen_dir}); use an absolute path or fix the relative path."
  end
  unless File.file?(full_path)
    raise Cambium::CompileError,
          "grounded_in :#{source_name} from: #{from_path.inspect} — #{full_path} exists but is not a regular file."
  end

  # Base64-encode via core String#pack('m0') rather than `require 'base64'`.
  # `pack('m0')` returns RFC 4648 base64 with no line breaks — identical
  # to Base64.strict_encode64 — and is built into Ruby's core, so it
  # doesn't require widening the stdlib allowlist in
  # scripts/check-ruby-deps.mjs (see CLAUDE.md "Dependency policy").
  b64 = ->(bytes) { [bytes].pack('m0') }

  ext = File.extname(full_path).downcase
  effective_grounding_value =
    case ext
    when '.pdf'
      { 'kind' => 'base64_pdf', 'data' => b64.call(File.binread(full_path)), 'media_type' => 'application/pdf' }
    when '.png'
      { 'kind' => 'base64_image', 'data' => b64.call(File.binread(full_path)), 'media_type' => 'image/png' }
    when '.jpg', '.jpeg'
      { 'kind' => 'base64_image', 'data' => b64.call(File.binread(full_path)), 'media_type' => 'image/jpeg' }
    when '.webp'
      { 'kind' => 'base64_image', 'data' => b64.call(File.binread(full_path)), 'media_type' => 'image/webp' }
    when '.gif'
      { 'kind' => 'base64_image', 'data' => b64.call(File.binread(full_path)), 'media_type' => 'image/gif' }
    else
      # Text fallthrough — anything not a recognized binary extension
      # reads as a string. Future RED-383 v2 magic-byte sniffing
      # would tighten this for unmarked PDFs / images.
      File.read(full_path)
    end
end

# Build an IR per compiled method. Per-class state (model, system,
# policies, memory, etc.) is shared; per-method state is `entry.method`
# and `steps` (the PlanBuilder output captured per-method above).
build_ir = lambda do |method_name, steps|
  {
    'version' => '0.2',
    'entry' => {
      'class' => klass.name,
      'method' => method_name,
      'source' => file
    },
    'model' => {
      'id' => defs[:model],
      'temperature' => defs[:temperature],
      'max_tokens' => defs[:max_tokens],
      # RED-325 Part 3: per-model options (e.g. disable_thinking).
      # Optional; emitted only when the gen sets at least one option.
      'options' => (defs[:model_options] && !defs[:model_options].empty? ? defs[:model_options] : nil)
    }.compact,
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
      'memory_write_via' => defs[:write_memory_via],
      'log'              => (defs[:log] || []),
      'log_profiles'     => (defs[:log_profiles] || []),
      'schedules'        => resolved_schedules
    },
    'reads_trace_of' => defs[:reads_trace_of],
    'returnSchemaId' => defs[:returnSchema],
    # RED-276: use the `grounded_in :name` source as the context key when
    # the gen declares grounding, else fall back to 'document' for
    # back-compat with analyst-style gens. Keeps the grounding validator's
    # `context[source]` lookup self-consistent with what the gen declared.
    #
    # RED-383: `arg` (from CLI --arg) wins when supplied — empty-string
    # default falls through to the from:-resolved value. Pipeline-driven
    # invocations override at sub-gen dispatch time (pipeline.ts merges
    # `with:` bindings into subIr.context), so the from: bake-in becomes
    # the "no caller supplied anything" default.
    'context' => {
      (defs[:grounding]&.fetch('source', nil) || 'document') => (
        (arg.nil? || arg == '') && !effective_grounding_value.nil? ? effective_grounding_value : arg
      )
    },
    'enrichments' => (defs[:enrichments] || []),
    'signals' => (defs[:signals] || []),
    'triggers' => (defs[:triggers] || []),
    'steps' => steps
  }
end

# Output shape:
#   --method passed → single IR (back-compat with `cambium run` and
#                                engine-mode `cambium compile --method X`).
#   bare (no --method) → JSON map { method_name => ir, ... } for every
#                        compiled user method (RED-360 serve-mode boot).
if method
  puts JSON.pretty_generate(build_ir.call(method, per_method_steps[method]))
else
  irs = {}
  methods_to_compile.each { |m| irs[m] = build_ir.call(m, per_method_steps[m]) }
  puts JSON.pretty_generate(irs)
end
