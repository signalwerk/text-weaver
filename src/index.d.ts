export interface UnwrapOptions {
  /** false applies only the rules, no API key needed (default: true) */
  llm?: boolean;
  /** OpenAI API key, required when llm is true */
  apiKey?: string;
  model?: string;
  /** sent to the model only when set; some models only accept the default */
  temperature?: number | null;
  /** sent as reasoning_effort only when set, e.g. "low" or "high" */
  reasoningEffort?: string | null;
  maxCandidatesPerCall?: number;
  confidenceThreshold?: number;
  wordContextBefore?: number;
  wordContextAfter?: number;
  /** compounds to always keep (case-insensitive) */
  keepHyphens?: string[];
  fetch?: typeof fetch;
  onRequest?: (info: {
    batchNumber: number;
    totalBatches: number;
    sent: boolean;
    payload: unknown;
  }) => void;
  onResponse?: (info: { batchNumber: number; data: unknown }) => void;
  onDecisions?: (info: {
    batchNumber: number;
    totalBatches: number;
    decisions: Decision[];
  }) => void;
  onLog?: (message: string) => void;
}

export interface Decision {
  id: string;
  decision: "UNHYPHENATE" | "KEEP_HYPHEN_JOIN";
  confidence: number;
  replacement?: string;
}

export interface UnwrapWarning {
  type: string;
  id: string;
  message: string;
  [key: string]: unknown;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
  model: string;
  estimated_cost_usd: number;
}

export interface UnwrapSummary {
  mode: "llm" | "no-llm";
  hyphen_candidates_total: number;
  applied_keep_rules: number;
  keep_rules_breakdown: Record<string, number>;
  applied_model_patches: number;
  flagged_low_confidence: number;
  default_join_with_space_applied: boolean;
  skipped_llm_candidates: number;
  token_usage?: TokenUsage;
  warnings?: Record<string, number>;
}

export interface UnwrapResult {
  text: string;
  summary: UnwrapSummary;
  /** low-confidence splits that were left untouched */
  flagged: { id: string; decision: string; confidence: number }[];
  warnings: UnwrapWarning[];
  tokenUsage?: TokenUsage;
}

export const defaultOptions: Required<
  Pick<
    UnwrapOptions,
    | "llm"
    | "model"
    | "maxCandidatesPerCall"
    | "confidenceThreshold"
    | "wordContextBefore"
    | "wordContextAfter"
  >
> & { temperature: undefined; reasoningEffort: undefined };
export const defaultKeepHyphens: string[];

export function unwrapText(
  text: string,
  options?: UnwrapOptions,
): Promise<UnwrapResult>;
export function parseKeepHyphenList(raw: string): string[];
export function buildHyphenCandidates(
  text: string,
  options?: Pick<UnwrapOptions, "wordContextBefore" | "wordContextAfter">,
): unknown[];
export function joinSoftLinebreaksDefault(text: string): string;
export function sanitizeAndParseLLMResponse(content: string): unknown;
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number;
