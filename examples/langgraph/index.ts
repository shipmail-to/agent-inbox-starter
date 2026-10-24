import { ChatAnthropic } from "@langchain/anthropic";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import {
  buildTriagePrompt,
  decisionSchema,
  SYSTEM_PROMPT,
  type ModelDecision,
} from "../../src/agent.ts";
import { DEFAULT_MODEL, type StructuredModel, type StructuredRequest } from "../../src/model.ts";
import {
  secureInboundMessage,
  type RawInboundMessage,
  type SecuredInboundMessage,
} from "../../src/security.ts";

/** A LangChain chat model behind the StructuredModel port the handlers and recipes take. */
export function createLangChainModel(modelId = DEFAULT_MODEL): StructuredModel {
  const chat = new ChatAnthropic({ model: modelId });
  return {
    async generate<T>(request: StructuredRequest<T>): Promise<T> {
      const answer = await chat.withStructuredOutput(request.schema).invoke([
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ]);
      return request.schema.parse(answer);
    },
  };
}

const State = Annotation.Root({
  raw: Annotation<RawInboundMessage>(),
  secured: Annotation<SecuredInboundMessage | null>(),
  decision: Annotation<ModelDecision | null>(),
});

/**
 * The starter's steps as graph nodes: the security pass decides whether the
 * model node runs at all. Add your own nodes after "triage", such as a CRM
 * lookup or a human approval step.
 */
export function createTriageGraph(model: StructuredModel, allowedSenders: readonly string[]) {
  return new StateGraph(State)
    .addNode("secure", (state) => {
      const result = secureInboundMessage(state.raw, { allowedSenders, allowedUrlHosts: [] });
      return { secured: result.ok ? result.message : null };
    })
    .addNode("triage", async (state) => {
      if (state.secured === null) return { decision: null };
      const decision = await model.generate({
        system: SYSTEM_PROMPT,
        prompt: buildTriagePrompt(state.secured, null),
        schema: decisionSchema,
      });
      return { decision };
    })
    .addEdge(START, "secure")
    .addConditionalEdges("secure", (state) => (state.secured === null ? END : "triage"))
    .addEdge("triage", END)
    .compile();
}

const graph = createTriageGraph(createLangChainModel(), ["customer@example.com"]);
const result = await graph.invoke({
  raw: {
    sender: "customer@example.com",
    subject: "Support",
    body: "Can someone help with my account?",
  },
  secured: null,
  decision: null,
});
console.info(result.decision);
