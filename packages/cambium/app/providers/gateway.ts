// Example custom provider (RED-393): a no-SDK OpenAI-compatible gateway.
//
// This is the canonical pattern for pointing Cambium at any
// OpenAI-compatible endpoint — a self-hosted vLLM, an OpenRouter-style
// aggregator, a corporate LLM gateway — WITHOUT forking the runner and
// WITHOUT adding a provider SDK as a dependency. It's raw `fetch` under the
// hood (the `openaiCompatible` factory composes the framework's own
// request-build / fetch / normalize).
//
// Conventions (the registry enforces these):
//   - one file: `app/providers/<name>.ts`
//   - `export default` a CambiumProvider
//   - the FILENAME is the model-id prefix. This file is `gateway.ts`, so gens
//     select it with `model "gateway:<model-name>"`. (The `name:` below must
//     match the filename or discovery throws.)
//
// Secrets resolve from env at call time via the `auth` callback — never bake a
// key into the file. The base URL is operator-controlled (same trust boundary
// as CAMBIUM_OMLX_BASEURL); `validateProviderBaseUrl` applies the framework's
// SSRF guard so a misconfigured URL can't quietly point at a metadata endpoint.

import { openaiCompatible, validateProviderBaseUrl } from '@redwood-labs/cambium-runner';

export default openaiCompatible({
  name: 'gateway',
  // OpenAI endpoints can't take native PDF/image envelopes; be honest so the
  // runtime fails fast instead of stringifying a base64 blob into the prompt.
  supportsDocuments: false,
  fetchFailureHint:
    'gateway fetch failed. Check CAMBIUM_GATEWAY_BASEURL and CAMBIUM_GATEWAY_API_KEY.',
  baseUrl: () => {
    const url = process.env.CAMBIUM_GATEWAY_BASEURL ?? 'https://api.openai.com';
    validateProviderBaseUrl('gateway (CAMBIUM_GATEWAY_BASEURL)', url);
    return url;
  },
  auth: () => process.env.CAMBIUM_GATEWAY_API_KEY,
  // Optional: map Cambium's model name → the wire id this endpoint wants.
  // A function works too; the object form is sugar for Azure-style deployment
  // aliases. Omit entirely for a verbatim passthrough.
  //   modelName: { 'gpt-4o': 'my-azure-deployment' },
});
