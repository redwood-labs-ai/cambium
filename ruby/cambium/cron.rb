# ── Cron expression support (RED-273 / RED-305) ──────────────────────
#
# Small parser + vocabulary mapper. Resolves `cron :daily, at: "9:00"`
# into a concrete 5-field crontab expression, validates raw crontab
# strings, generates stable slugs for IDs, and computes next-N-fires
# for `cambium schedule preview`.
#
# Scope is intentionally small:
#   - Parse a 5-field crontab to the degree needed to validate it.
#   - Expand the named vocabulary (daily / hourly / weekly / weekdays /
#     every_minute) into concrete expressions.
#   - Compute a deterministic slug for raw expressions.
#
# We do NOT reimplement a full cron runtime — the operator's scheduler
# owns that. For `cambium schedule preview` we implement a minimal
# next-fire walker (time iteration + field matching) that covers the
# vocabulary + simple crontab patterns.

require 'digest'

module Cambium
  module Cron
    VALID_NAMED = %w[daily hourly weekly weekdays every_minute].freeze

    # Expand a named vocabulary symbol + optional `at:` into a concrete
    # 5-field crontab expression.
    def self.expand_named(name, at: nil)
      key = name.to_s
      case key
      when 'daily'
        h, m = at ? parse_time(at) : [0, 0]
        "#{m} #{h} * * *"
      when 'hourly'
        raise CompileError, "cron :hourly does not accept `at:`" if at
        "0 * * * *"
      when 'weekly'
        # Default Sunday midnight.
        h, m = at ? parse_time(at) : [0, 0]
        "#{m} #{h} * * 0"
      when 'weekdays'
        # Default weekdays at 9am.
        h, m = at ? parse_time(at) : [9, 0]
        "#{m} #{h} * * 1-5"
      when 'every_minute'
        raise CompileError, "cron :every_minute does not accept `at:`" if at
        "* * * * *"
      else
        raise CompileError,
              "unknown cron name :#{key}. Accepted named vocabulary: " \
              "#{VALID_NAMED.map { |v| ":#{v}" }.join(', ')}. " \
              "Or pass a raw 5-field crontab string."
      end
    end

    # Validate a raw 5-field crontab expression. Returns the normalized
    # expression (whitespace-collapsed) or raises CompileError.
    def self.validate_expression(expr)
      normalized = expr.strip.gsub(/\s+/, ' ')
      parts = normalized.split(' ')
      unless parts.length == 5
        raise CompileError,
              "cron expression must have exactly 5 fields " \
              "(minute hour day month weekday), got #{parts.length}: #{expr.inspect}"
      end
      parts.each_with_index do |field, i|
        unless field =~ %r{\A[\d*/,-]+\z}
          raise CompileError,
                "invalid characters in cron field #{i} (#{field.inspect}). " \
                "Accepted: digits, * , - / only."
        end
      end
      normalized
    end

    # "9:00" / "14:30" → [hour, minute]
    def self.parse_time(at)
      unless at.is_a?(String) && at =~ /\A(\d{1,2}):(\d{2})\z/
        raise CompileError, "cron `at:` must be HH:MM (got #{at.inspect})"
      end
      hour = Regexp.last_match(1).to_i
      minute = Regexp.last_match(2).to_i
      unless (0..23).cover?(hour) && (0..59).cover?(minute)
        raise CompileError, "cron `at:` out of range: #{at.inspect}"
      end
      [hour, minute]
    end

    # Deterministic 4-char hex slug from a crontab expression.
    # Used for IDs of raw-crontab declarations when no :id is given.
    def self.slug_from_expression(expr)
      "cron_#{Digest::SHA256.hexdigest(expr)[0, 4]}"
    end
  end
end
