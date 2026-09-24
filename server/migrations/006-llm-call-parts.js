const version = 'llm_call_parts_v1';
const checksum = 'sha256:llm-call-parts-v1-20260909-01';

// 组装层台账：llm_calls.parts_json 存该次请求系统提示按 Provider 逐层组装时的
// token 估算 [{name,tokens,truncated}]——本地 agent 在官方 usage 总量之下的细分依据，
// 配合 calibration（官方总量 ÷ 本地估算总量）把每层估算校准到真实尺度
function up(db) {
  db.exec(`ALTER TABLE llm_calls ADD COLUMN parts_json TEXT DEFAULT ''`);
}

module.exports = { version, checksum, up };
