/**
 * ingest-samples.ts
 * ================
 * 将已生成的 AI 问答对样本（few-shot-samples.json）灌入 ChromaDB 向量数据库的
 * `rag_samples` 集合中，供后续 RAG（检索增强生成）检索使用。
 *
 * 功能概述：
 *   1. 读取 few-shot-samples.json（包含 question、answer、category、score 字段）
 *   2. 逐条调用 Ollama 的 embedding 接口，将「问题 + 回答」拼接文本转为向量
 *   3. 将文本、向量及元数据写入 ChromaDB 的 rag_samples 集合
 *   4. 每条记录独立处理——某条失败不会中断整批灌入
 *
 * 运行方式：
 *   npx tsx server/scripts/ingest-samples.ts
 *
 * 前置条件：
 *   - Ollama 服务已在本地运行（默认 http://localhost:11434），且已拉取所需 embedding 模型
 *   - ChromaDB 服务已在本地运行（默认 http://localhost:8000）
 *   - server/data/few-shot-samples.json 文件已生成（由 few-shot 生成脚本产出）
 *   - npm 依赖已安装（@anthropic-ai/sdk 或项目自身的 ollama/chroma 服务封装）
 *
 * 输入文件格式（server/data/few-shot-samples.json）：
 *   [
 *     {
 *       "question": "用户问题文本",
 *       "answer": "AI 回答文本",
 *       "category": "分类标签",
 *       "score": 0.95
 *     },
 *     ...
 *   ]
 *
 * 输出：
 *   - 终端打印逐条进度（成功/失败及数量统计）
 *   - ChromaDB rag_samples 集合中新增文档，每条文档包含：
 *       id:       唯一标识（sample_<时间戳毫秒>_<序号>）
 *       text:     拼接后的「问题 + 回答」全文
 *       metadata: { source, category, score, question, type }
 *       vector:   Ollama 生成的 embedding 向量
 *
 * 边缘情况：
 *   - 若 few-shot-samples.json 不存在或格式错误，脚本会在启动时抛出异常并终止
 *   - 若 Ollama 或 ChromaDB 不可达，对应条目会打印错误并跳过，继续处理剩余条目
 *   - 若某条目缺少 question/answer 字段，拼接结果为 "问题：undefined\n\n回答：undefined"，仍会尝试写入
 *   - ID 中包含 Date.now() 毫秒时间戳；若在同毫秒内处理两条以上，ID 仍因序号不同而不冲突
 */

import fs from 'fs';
import { getEmbedding } from '../src/services/ollama.js';
import { addDocuments } from '../src/services/chroma.js';

async function main() {
  // 1. 读取并解析 few-shot 样本文件
  //    注意：路径相对于 CWD（通常为项目根目录），请确保在项目根目录下执行
  const data = JSON.parse(fs.readFileSync('server/data/few-shot-samples.json', 'utf-8'));
  console.log(`📚 灌入 rag_samples: ${data.length} 条\n`);

  // 2. 逐条处理——生成 embedding 并写入 ChromaDB
  //    采用串行处理（非并行），避免同时向 Ollama/ChromaDB 发起过多请求
  let ok = 0;
  for (const item of data) {
    try {
      // 2a. 拼接问题与回答为统一文本，作为 embedding 的输入和存储内容
      const text = `问题：${item.question}\n\n回答：${item.answer}`;

      // 2b. 调用 Ollama 生成文本的 embedding 向量
      const emb = await getEmbedding(text);

      // 2c. 将文档写入 ChromaDB 的 rag_samples 集合
      await addDocuments(
        [
          {
            // ID 规则：sample_<毫秒时间戳>_<序号>，保证唯一性
            id: `sample_${Date.now()}_${ok}`,
            text,
            metadata: {
              source: 'ai-generated-sample', // 标识数据来源为 AI 生成
              category: item.category,        // 问题分类标签
              score: item.score,              // 质量评分（0-1）
              question: item.question,        // 原始问题，方便检索时直接展示
              type: 'qa_pair',                // 文档类型标识
            },
          },
        ],
        [emb],           // 对应的 embedding 向量数组
        'rag_samples',   // 目标集合名称
      );

      // 2d. 计数并打印成功日志
      ok++;
      console.log(`   ✅ [${ok}/${data.length}] ${item.question.slice(0, 50)}`);
    } catch (err: any) {
      // 单条失败不中断整体流程，打印错误信息后继续下一条
      console.error(`   ❌ 失败: ${err.message}`);
    }
  }

  // 3. 输出最终统计结果
  console.log(`\n✅ rag_samples 灌入完成: ${ok}/${data.length}`);
}

// 入口：调用 main 函数，全局捕获未处理的 Promise 异常
main().catch(console.error);
