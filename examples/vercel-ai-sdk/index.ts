import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";

import { buildTriagePrompt, decisionSchema, SYSTEM_PROMPT } from "../../src/agent.ts";
import { DEFAULT_MODEL, type StructuredModel, type StructuredRequest } from "../../src/model.ts";
import { secureInboundMessage } from "../../src/security.ts";

/**
 * Swapping the model provider means implementing StructuredModel, nothing else.
 * Every handler and recipe calls generate(), so pass this wherever the starter
 * takes `model`. Change `anthropic(...)` to any AI SDK provider.
 */
export function createVercelAiModel(modelId = DEFAULT_MODEL): StructuredModel {
  return {
    async generate<T>(request: StructuredRequest<T>): Promise<T> {
      const result = await generateText({
        model: anthropic(modelId),
        system: request.system,
        prompt: request.prompt,
        output: Output.object({ schema: request.schema }),
      });
      return request.schema.parse(result.output);
    },
  };
}

const secured = secureInboundMessage(
  {
    sender: "customer@example.com",
    subject: "Question",
    body: "Could you send your support hours?",
  },
  { allowedSenders: ["customer@example.com"], allowedUrlHosts: [] },
);
if (!secured.ok) throw new Error(`Message blocked: ${secured.reason}`);

const decision = await createVercelAiModel().generate({
  system: SYSTEM_PROMPT,
  prompt: buildTriagePrompt(secured.message, null),
  schema: decisionSchema,
});
console.info(decision);
