const version = 'llm_call_schema_v1';
const checksum = 'sha256:llm-call-schema-v1-20260909-01';

// 工具定义占用：上游 prompt_tokens 含 tools schema（实测空书请求 5218 tokens 中
// 约 4.8K 是工具定义），单独成列才能在组成面板如实展示与参与校准
function up(db) {
  db.exec(`ALTER TABLE llm_calls ADD COLUMN schema_tokens INTEGER DEFAULT 0`);
}

module.exports = { version, checksum, up };
