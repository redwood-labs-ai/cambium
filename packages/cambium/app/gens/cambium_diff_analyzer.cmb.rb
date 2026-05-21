# Stage 1 of the Cambium CI Review pipeline (RED-381). Classifies a
# Cambium-repo PR diff into a structured CambiumDiffAnalysis — touched
# subsystems, Cambium-specific risk categories, magnitude, and key
# excerpts the reviewer should look at. Stage 2 (CambiumPrReviewer)
# reasons from this output to produce the typed review.

class CambiumDiffAnalyzer < GenModel
  model :default
  system :cambium_diff_analyzer
  temperature 0.1
  max_tokens 1500

  returns CambiumDiffAnalysis

  def analyze(diff)
    generate "classify this Cambium PR diff into subsystems, risks, magnitude, and key excerpts" do
      with context: diff
      returns CambiumDiffAnalysis
    end
  end
end
