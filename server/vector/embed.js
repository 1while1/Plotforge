// 本地 embedding：transformers.js 跑 bge-small-zh-v1.5（量化版，完全离线）
// ESM 包，复用动态 import 桥接模式；模型首次从 hf-mirror 下载后本地缓存。
const path = require('node:path');

// 嵌入安全文本长度（码点）：bge-small-zh-v1.5 的 512 token 上限实测折合 **≈510 汉字**
// （逐字逼近实测：N=510 cos 0.99934、N=511 cos 1.00000，即 511 起尾部被静默丢弃）。
// 查询侧另有 19 字的检索前缀（见 embedQuery），故给调用方的预算是 510−19−余量=480。
// 任何拼给 embed/embedQuery 的文本都必须先按这个上限裁剪——超长不报错，只会
// 「答案明明在库里却检索不到」，属最难排查的一类缺陷。
const EMBED_TEXT_MAX = 480;

function createEmbedder(loadTransformers = () => import('@huggingface/transformers')) {
  let pipePromise = null;

  async function getPipeline() {
    if (!pipePromise) {
      pipePromise = (async () => {
        const { pipeline, env } = await loadTransformers();
        env.allowLocalModels = true;
        // HF_ENDPOINT 并非库自动读取的开关，必须显式设置 remoteHost。
        env.remoteHost = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '') + '/';
        // 缓存脱离 node_modules，升级依赖后仍可离线使用；发布前可将旧 .cache 复制到这里。
        env.cacheDir = process.env.NOVEL_EMBED_CACHE_DIR || path.join(__dirname, '../../data/embedding-cache');
        console.log('[vector] 加载 embedding 模型（首次需下载约 90MB）…');
        const pipe = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8', device: 'cpu' });
        console.log('[vector] embedding 模型就绪');
        return pipe;
      })();
      pipePromise.catch(() => { pipePromise = null; }); // 失败允许重试
    }
    return pipePromise;
  }

  // text → 归一化 Float32Array（512 维）
  async function embed(text) {
    const pipe = await getPipeline();
    const out = await pipe(text, { pooling: 'mean', normalize: true });
    const vector = new Float32Array(out.data);
    if (vector.length !== 512 || !vector.every(Number.isFinite)) {
      throw new Error('embedding 输出必须为 512 维有限数值，拒绝写入不兼容向量');
    }
    return vector;
  }

  // bge 中文模型检索式查询前缀，提升召回质量
  async function embedQuery(text) {
    return embed('为这个句子生成表示以用于检索相关文章：' + text);
  }

  // 启动预热：提前加载模型并跑一次空推理，消除首次索引的冷启动延迟（冷加载约 10~30s）。
  // 非致命：失败仅告警，getPipeline 已支持失败重试，真正索引时会再次尝试。
  async function warmUp() {
    try {
      const pipe = await getPipeline();
      await pipe('预热', { pooling: 'mean', normalize: true });
      console.log('[vector] embedding 预热完成');
      return true;
    } catch (err) {
      console.warn('[vector] embedding 预热失败（首次索引时重试）:', err.message);
      return false;
    }
  }

  return { embed, embedQuery, warmUp };
}

module.exports = { ...createEmbedder(), EMBED_TEXT_MAX, createEmbedder };
