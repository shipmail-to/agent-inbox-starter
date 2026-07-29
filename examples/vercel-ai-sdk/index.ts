import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";

import {
  buildUntrustedEmailPrompt,
  decisionSchema,
  SYSTEM_PROMPT,
  type ModelDecision,
  type TriageModel,
} from "../../src/agent.ts";
import { secureInboundMessage } from "../../src/security.ts";

/**
 * Swapping the model provider means implementing TriageModel, nothing else.
 * The prompt, the schema, and the whole webhook pipeline are unchanged: pass
 * this to createWebhookHandler in place of createAnthropicTriageModel.
 */
export function createVercelAiTriageModel(modelId = "claude-sonnet-5"): TriageModel {
  return {
    async classify(prompt: string): Promise<ModelDecision> {
      const result = await generateObject({
        model: anthropic(modelId),
        system: SYSTEM_PROMPT,
        schema: decisionSchema,
        prompt,
      });
      return result.object;
    },
  };
}

const secured = secureInboundMessage(
  {
    sender: "customer@example.com",
    subject: "Question",
    body: "Could you send your support hours?",
    bodyIsHtml: false,
  },
  { allowedSenders: ["customer@example.com"], allowedUrlHosts: [] },
);
if (!secured.ok) throw new Error(`Message blocked: ${secured.reason}`);

const model = createVercelAiTriageModel();
console.info(await model.classify(buildUntrustedEmailPrompt(secured.message)));
