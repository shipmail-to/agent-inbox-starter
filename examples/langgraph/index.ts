import { ChatAnthropic } from "@langchain/anthropic";
import { Annotation, START, END, StateGraph } from "@langchain/langgraph";

import {
  buildUntrustedEmailPrompt,
  decisionSchema,
  SYSTEM_PROMPT,
  type ModelDecision,
  type TriageModel,
} from "../../src/agent.ts";
import { secureInboundMessage } from "../../src/security.ts";

const State = Annotation.Root({
  prompt: Annotation<string>(),
  decision: Annotation<ModelDecision | null>(),
});

/**
 * A LangGraph node behind the same TriageModel port. Note the absence of a
 * temperature: claude-sonnet-5 rejects non-default sampling parameters.
 */
export function createLangGraphTriageModel(modelId = "claude-sonnet-5"): TriageModel {
  const model = new ChatAnthropic({ model: modelId }).withStructuredOutput(decisionSchema);
  const graph = new StateGraph(State)
    .addNode("triage", async (state) => ({
      decision: await model.invoke([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: state.prompt },
      ]),
    }))
    .addEdge(START, "triage")
    .addEdge("triage", END)
    .compile();

  return {
    async classify(prompt: string): Promise<ModelDecision> {
      const result = await graph.invoke({ prompt, decision: null });
      if (result.decision === null) throw new Error("LangGraph returned no decision");
      return result.decision;
    },
  };
}

const secured = secureInboundMessage(
  {
    sender: "customer@example.com",
    subject: "Support",
    body: "Can someone help with my account?",
    bodyIsHtml: false,
  },
  { allowedSenders: ["customer@example.com"], allowedUrlHosts: [] },
);
if (!secured.ok) throw new Error(`Message blocked: ${secured.reason}`);

const model = createLangGraphTriageModel();
console.info(await model.classify(buildUntrustedEmailPrompt(secured.message)));
