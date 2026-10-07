// Versioned limits for the writing chat's message history and tool facts.
// These are character/count limits, not a single token budget. Keep each
// dimension separate so a future policy can change one without shifting others.
const HISTORY_BUDGET_VERSION = 1;
const HISTORY_MESSAGE_LIMIT = 12;
const HISTORY_RECENT_FULL_COUNT = 4;
const HISTORY_OLD_MAX_CHARS = 300;
const TOOL_FACT_RESULT_MAX_CHARS = 1200;
const TOOL_FACT_TOTAL_MAX_CHARS = 4000;
const TOOL_FACTS_PER_RUN = 16;

module.exports = {
  HISTORY_BUDGET_VERSION,
  HISTORY_MESSAGE_LIMIT,
  HISTORY_RECENT_FULL_COUNT,
  HISTORY_OLD_MAX_CHARS,
  TOOL_FACT_RESULT_MAX_CHARS,
  TOOL_FACT_TOTAL_MAX_CHARS,
  TOOL_FACTS_PER_RUN,
};
