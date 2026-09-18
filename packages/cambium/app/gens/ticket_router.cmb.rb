class TicketRouter < GenModel
  describe "Routes a support ticket to the team that should handle it and flags urgency."
  model "typesafe:jev-latest"          # fallbacks allowed: model "typesafe:jev-latest", "typesafe:jev-1.13.0"
  mode :decision
  system :ticket_router                # optional; rendered as state.system

  returns do
    # String + enum: → a choice. The Hash form carries per-option descriptions (Jev `criteria`).
    field :department, String,
      description: "Which team should handle this ticket?",
      enum: {
        billing:   "Payment, invoice, or subscription issues",
        technical: "Bugs, errors, or integration failures",
        sales:     "Pricing, plans, or account questions",
      }
    # Boolean → a yes/no (Jev `noul`). description: is the question.
    field :is_urgent, Boolean,
      description: "The ticket conveys urgency or time-sensitivity"
  end

  def route(document)
    generate "Route this support ticket" do   # the prompt string becomes state.task
      with context: document                  # every non-`_` context key lands under state.context
    end
  end
end
