const version = 'embedding_runtime_q8_v1';
const checksum = 'sha256:auto';

// ONNX Runtime 1.30 的 q8 CPU 内核与旧 1.14 存在数值差异。
// 启动迁移在索引任务之前执行：只失效可再生向量，正文、范文与证据不变。
// 定稿章节由启动补索引重建；范文向量仍由离线 indexSamples 重建。
function up(db) {
  db.run('DELETE FROM embeddings');
  db.run("UPDATE style_samples SET vector = NULL, vector_model = '', indexed_at = NULL WHERE vector IS NOT NULL OR vector_model <> '' OR indexed_at IS NOT NULL");
}

module.exports = { version, checksum, up };
