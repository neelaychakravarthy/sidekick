import { agentExecutor } from "./agent-executor";
import { analyzerAmbient, analyzerMention } from "./analyzer";

export const functions = [analyzerMention, analyzerAmbient, agentExecutor];
