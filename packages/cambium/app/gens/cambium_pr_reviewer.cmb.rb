# Stage 2 of the Cambium CI Review pipeline (RED-381). Consumes the
# structured CambiumDiffAnalysis from Stage 1 and produces a typed
# CambiumCiReview — concerns + severity + verdict — suitable for
# posting as a PR review.

class CambiumPrReviewer < GenModel
  model :default
  system :cambium_pr_reviewer
  temperature 0.2
  max_tokens 2000

  returns CambiumCiReview

  def review(analysis)
    generate "review this Cambium PR based on the upstream analyzer's classification" do
      with context: analysis
      returns CambiumCiReview
    end
  end
end
