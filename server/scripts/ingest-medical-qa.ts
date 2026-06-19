/**
 * =============================================================================
 * ingest-medical-qa.ts — 中文医疗对话数据集儿科筛选 + 向量库灌入脚本
 * =============================================================================
 *
 * 功能概述：
 *   从本地的 "Chinese-medical-dialogue-data" 数据集中筛选出儿科/婴儿相关的
 *   医患问答对，经过去重和文本清洗后，调用 Ollama 的 bge-m3 模型生成 embedding，
 *   最后批量写入 ChromaDB 向量数据库，供下游 RAG 检索使用。
 *
 * 前置条件（Prerequisites）：
 *   1. 本地存在数据集目录：
 *      /Users/lidong/Desktop/workFile/Chinese-medical-dialogue-data-master/Data_数据
 *      其中必须包含 Pediatric_儿科 子目录，目录内有若干 GB2312 编码的 CSV 文件。
 *      数据集来源：https://github.com/Toyhom/Chinese-medical-dialogue-data
 *
 *   2. Ollama 服务已启动（默认 http://127.0.0.1:11434），且已拉取 bge-m3 模型：
 *        ollama pull bge-m3
 *        ollama serve
 *
 *   3. ChromaDB 服务已启动（默认 http://127.0.0.1:8000）：
 *        chroma run --path ./chroma_data
 *
 * 运行方式：
 *   npx tsx server/scripts/ingest-medical-qa.ts
 *
 * 预期输入：
 *   - CSV 文件，GB2312 编码，包含 4 列：department（科室）, title（标题）,
 *     ask（患者提问）, answer（医生回答）。文件不含表头行时需要调整代码。
 *
 * 预期输出：
 *   - 控制台打印统计信息：总行数、筛选后数量、去重后数量、科室分布、灌入进度。
 *   - ChromaDB 的 rag_medical collection 中新增至多 MAX_INGEST 条文档。
 *   - 每条文档的 ID 格式为 med_XXXXXXXX，metadata 包含来源、科室、标题、
 *     截断后的问题文本和类型标记。
 *
 * 边缘情况（Edge Cases）：
 *   - CSV 中带引号的字段（如含逗号的问题文本）由 parseCSVRow 正确处理。
 *   - 编码错误的字符（GB2312 无法解码的字节）会由 iconv-lite 静默替换，
 *     不会导致脚本崩溃。
 *   - 问题文本 < 5 字符或回答 < 10 字符的行视为无效数据，直接跳过。
 *   - 单条 embedding 生成失败不会中断整批；失败条数 > 3 后会静默跳过不再打印。
 *   - DRY_RUN=true 时可快速预览筛选结果，不实际灌入 ChromaDB。
 *   - MAX_INGEST 限制灌入总数，防止单次运行耗时过长（bge-m3 embedding 较慢）。
 *   - 批次间有 500ms 延迟，防止 Ollama 或 ChromaDB 过载。
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import iconv from 'iconv-lite';
import { getEmbedding } from '../src/services/ollama.js';
import { addDocuments } from '../src/services/chroma.js';

// =============================================================================
// 配置区 (Configuration)
// =============================================================================

/** 数据集根目录（请根据本地实际情况修改） */
const DATA_DIR = '/Users/lidong/Desktop/workFile/Chinese-medical-dialogue-data-master/Data_数据';

/** 每批灌入 ChromaDB 的文档数。较小值可减小 Ollama 内存压力。 */
const BATCH_SIZE = 5;

/** 最多灌入条数。bge-m3 单条 embedding 约需 0.5-1s，2000 条约需 20-30 分钟。 */
const MAX_INGEST = 2000;

/** 是否仅预览筛选结果而不实际写入 ChromaDB。设为 true 用于快速调试关键词效果。 */
const DRY_RUN = false;

/** 需要扫描的数据集子目录。只关注儿科，可按需扩展。 */
const SCAN_DIRS = ['Pediatric_儿科'];

/**
 * 婴儿/幼儿相关关键词（白名单）。
 * 文本中需至少命中一个才算"儿科相关"。覆盖了婴儿常见症状、喂养、发育、
 * 睡眠等典型场景。
 */
const INFANT_KEYWORDS = [
  '宝宝', '婴儿', '新生儿', '幼儿', '婴幼儿',
  '月龄', '个月', '岁', '半岁', '周岁',
  '母乳', '配方奶', '辅食', '断奶', '厌奶',
  '发烧', '咳嗽', '腹泻', '湿疹', '感冒',
  '睡眠', '夜醒', '哄睡', '哭闹',
  '长牙', '出牙', '疫苗', '体检',
  '身高', '体重', '发育',
  '小儿', '儿童', '孩子',
  '早产', '产后', '月子',
];

/**
 * 排除关键词（黑名单）。
 * 命中白名单但同时也命中黑名单的文本将被排除。
 * 用于过滤成人疾病、成人生活场景等与婴幼儿无关的内容。
 */
const EXCLUDE_KEYWORDS = [
  '性功能', '阳痿', '早泄', '前列腺', '月经', '痛经',
  '更年期', '绝经', '乳腺增生', '宫颈', '卵巢',
  '成人', '老年', '中年', '男性', '女性',
  '抽烟', '饮酒', '开车', '工作', '上学',
  '高血压', '糖尿病', '冠心病', '痛风', '脑梗',
];

// =============================================================================
// 数据结构与工具函数 (Data Structures & Utilities)
// =============================================================================

/** 单条问答对的内部表示 */
interface QAPair {
  id: string;       // 短 UUID（前 8 位），用作文档 ID 后缀
  question: string; // 患者提问（已截断）
  answer: string;   // 医生回答（已截断）
  department: string; // 科室名称
  title: string;      // 对话标题
}

/**
 * 解析单行 CSV 文本，返回字段数组。
 *
 * 与简单的 split(',') 不同，该函数能正确处理引号包裹的字段——
 * 当字段内含逗号时（如 "宝宝发烧，怎么办"），逗号不会被当作分隔符。
 * 这是标准 CSV RFC 4180 的简化实现。
 *
 * @param line - 单行原始文本（不含换行符）
 * @returns 解析后的字段数组，字段已做 trim 处理
 */
function parseCSVRow(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // 遇到双引号时切换"引号内"状态，不将引号本身加入字段内容
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      // 引号外的逗号才是字段分隔符
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  // 最后一个字段（行尾没有逗号）
  result.push(current.trim());
  return result;
}

/**
 * 判断一条问答是否属于婴儿/幼儿相关。
 *
 * 使用两步过滤策略：
 *   1. 白名单（INFANT_KEYWORDS）：必须在 question + answer + title 的拼接
 *      文本中命中至少一个关键词。
 *   2. 黑名单（EXCLUDE_KEYWORDS）：不能命中任何一个排除关键词。
 *
 * 这种设计避免了单纯依赖"儿科"科室标签的不足——有些数据虽然标为儿科，
 * 但实际内容可能涉及成人或非婴儿话题。
 *
 * @param q - 问题文本
 * @param a - 回答文本
 * @param title - 对话标题
 * @returns true 如果文本同时满足白名单命中且未命中黑名单
 */
function isInfantRelated(q: string, a: string, title: string): boolean {
  const combined = `${q} ${a} ${title}`;

  // 必须命中至少一个婴儿关键词
  const hasInfantKw = INFANT_KEYWORDS.some((kw) => combined.includes(kw));
  if (!hasInfantKw) return false;

  // 不能命中排除关键词
  const hasExcludeKw = EXCLUDE_KEYWORDS.some((kw) => combined.includes(kw));
  if (hasExcludeKw) return false;

  return true;
}

/**
 * 清洗文本：将连续空白字符（空格、制表符等）合并为单个空格，
 * 连续换行符合并为单个换行符，并去掉首尾空白。
 *
 * @param text - 原始文本
 * @returns 清洗后的文本
 */
function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

/**
 * 截断过长文本并在末尾追加省略号 '…'。
 *
 * 问题截断至 500 字符，回答截断至 800 字符。
 * 过长的问答对会导致 embedding 模型截断或生成质量下降。
 *
 * @param text - 原始文本
 * @param maxLen - 最大允许长度
 * @returns 截断后的文本；若未超出长度则原样返回
 */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

/**
 * 将 QAPair 格式化为 ChromaDB 文档结构。
 *
 * 生成的 text 字段用于 embedding 编码，格式为：
 *   【科室】标题
 *   问：问题文本
 *   答：回答文本
 *
 * metadata 中保存了来源、科室、标题、截断后的问题等结构化信息，
 * 供下游检索时作为过滤条件或展示字段。
 *
 * @param qa - 问答对
 * @returns ChromaDB 兼容的文档对象，含 id、text、metadata
 */
function formatDoc(qa: QAPair): {
  id: string;
  text: string;
  metadata: Record<string, string | number>;
} {
  return {
    id: `med_${qa.id}`,
    text: `【${qa.department}】${qa.title}\n问：${qa.question}\n答：${qa.answer}`,
    metadata: {
      source: 'Chinese-medical-dialogue-data',
      department: qa.department,
      title: qa.title,
      question: truncateText(qa.question, 200), // metadata 中保存更短的问题摘要
      type: 'medical_qa',
    },
  };
}

// =============================================================================
// 主流程 (Main Pipeline)
// =============================================================================

async function main() {
  console.log('🏥 中文医疗数据集 — 儿科数据筛选 + 灌入向量库\n');

  // ---------------------------------------------------------------------------
  // Step 1: 读取 CSV 文件并做关键词筛选
  //   - 遍历 SCAN_DIRS 下的所有 .csv 文件
  //   - 用 iconv-lite 解码 GB2312 → UTF-8
  //   - 逐行解析 CSV，用 isInfantRelated 做初次筛选
  //   - 跳过空行、注释行（# 开头）、字段不足的行
  //   - 跳过问题 < 5 字符或回答 < 10 字符的无效行
  // ---------------------------------------------------------------------------
  console.log('📂 Step 1: 读取数据文件...\n');

  let rawQAs: QAPair[] = [];
  let totalRows = 0;

  for (const dirName of SCAN_DIRS) {
    const dirPath = path.join(DATA_DIR, dirName);
    if (!fs.existsSync(dirPath)) {
      console.log(`   ⚠️ 目录不存在，跳过: ${dirPath}`);
      continue;
    }

    // 仅处理 CSV 文件，忽略目录中的其他文件
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.csv'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      console.log(`   📄 ${dirName}/${file}`);

      // 读取原始字节，然后用 iconv-lite 按 GB2312 解码为 UTF-8 字符串
      // 注意：GB2312 是 GBK 的子集，部分生僻字可能解码失败，
      // iconv-lite 默认会用替换字符 � 代替，不会抛异常
      const buffer = fs.readFileSync(filePath);
      const content = iconv.decode(buffer, 'gb2312');

      const lines = content.split('\n');
      // 第一行是表头：department,title,ask,answer（跳过不处理）
      const header = lines[0]; // department,title,ask,answer

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        // 跳过空行和以 # 开头的注释行
        if (!line || line.startsWith('#')) continue;

        try {
          const cols = parseCSVRow(line);
          // 确保至少有 4 列（department, title, question, answer）
          if (cols.length < 4) continue;

          const department = cols[0] || '';
          const title = cols[1] || '';
          const question = cleanText(cols[2] || '');
          const answer = cleanText(cols[3] || '');

          // 过滤掉问题或回答过短的无意义行
          if (!question || !answer) continue;
          if (question.length < 5 || answer.length < 10) continue;

          totalRows++;

          // 白名单 + 黑名单筛选：只保留婴儿相关且排除成人话题的问答
          if (isInfantRelated(question, answer, title)) {
            rawQAs.push({
              id: uuidv4().slice(0, 8), // 取 UUID 前 8 位作为短 ID
              question: truncateText(question, 500), // 截断过长问题
              answer: truncateText(answer, 800),      // 截断过长回答
              department,
              title,
            });
          }
        } catch {
          // 跳过解析失败的行（如编码损坏、格式异常等），不中断整体流程
        }
      }
    }
  }

  console.log(`\n   总行数: ${totalRows}`);
  console.log(`   婴儿相关: ${rawQAs.length}\n`);

  // ---------------------------------------------------------------------------
  // Step 2: 去重
  //   使用问题文本的前 50 个字符作为去重键。
  //   同一个问题可能在不同的 CSV 文件中重复出现（如不同版本的数据合并）。
  //   取前 50 字符而非完整文本作为去重键是为了容忍轻微的文本差异
  //   （如末尾多一个空格、标点差异等），同时避免哈希碰撞导致误删。
  // ---------------------------------------------------------------------------
  console.log('🔍 Step 2: 去重...\n');

  const seen = new Set<string>();
  const deduped: QAPair[] = [];

  for (const qa of rawQAs) {
    // 用问题前 50 个字符作为去重指纹
    const key = qa.question.slice(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(qa);
    }
  }

  console.log(`   去重后: ${deduped.length} 条\n`);

  // ---------------------------------------------------------------------------
  // Step 3: 按科室分类统计
  //   输出各科室的问答数量分布，方便了解数据组成。
  //   儿科数据集下可能包含多个子科室（如小儿内科、小儿外科等）。
  // ---------------------------------------------------------------------------
  console.log('📊 Step 3: 分类统计...\n');

  const stats = new Map<string, number>();
  for (const qa of deduped) {
    stats.set(qa.department, (stats.get(qa.department) || 0) + 1);
  }

  for (const [dept, count] of stats) {
    console.log(`   ${dept}: ${count} 条`);
  }
  console.log('');

  // Dry run 模式：只输出统计和样本，不连接 Ollama/ChromaDB
  // 适用于快速验证关键词筛选效果
  if (DRY_RUN) {
    console.log('🔍 Dry run 模式 — 不灌入数据');
    console.log('\n前 5 条样本:');
    for (const qa of deduped.slice(0, 5)) {
      console.log(`\n--- [${qa.department}] ${qa.title} ---`);
      console.log(`Q: ${qa.question.slice(0, 100)}`);
      console.log(`A: ${qa.answer.slice(0, 150)}`);
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 4: 灌入 ChromaDB 向量库
  //   - 取前 MAX_INGEST 条（避免单次运行过长）
  //   - 按 BATCH_SIZE 分批处理
  //   - 每条文档调用 getEmbedding 生成向量，再调用 addDocuments 写入
  //   - 批次间延迟 500ms 防止 Ollama/ChromaDB 过载
  //   - 单条失败不影响同批次其他文档
  //
  //   注意：embedding 是逐条生成的（非批量），因为 Ollama bge-m3 的
  //   批量接口在高并发下可能出现 OOM。
  // ---------------------------------------------------------------------------
  const toIngest = deduped.slice(0, MAX_INGEST);
  console.log(`📚 Step 4: 灌入向量库 (${toIngest.length} 条，总数 ${deduped.length} 中取前 ${MAX_INGEST})...\n`);

  const docs = toIngest.map(formatDoc);
  let ingested = 0;
  let failed = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(docs.length / BATCH_SIZE);

    try {
      // 逐条生成 embedding 并灌入，单条失败不中断整批
      for (const doc of batch) {
        try {
          // 调用 Ollama API 生成 1024 维 bge-m3 embedding
          const embedding = await getEmbedding(doc.text);
          // 写入 ChromaDB 的 rag_medical collection
          await addDocuments([doc], [embedding], 'rag_medical');
          ingested++;
        } catch (err: any) {
          failed++;
          // 仅打印前 3 条失败信息，避免日志刷屏
          if (failed <= 3) {
            console.error(`   ❌ 单条失败: ${err.message}`);
          }
        }
      }
      console.log(`   批次 ${batchNum}/${totalBatches}: ${ingested}/${docs.length} 已完成`);
    } catch (err: any) {
      // 批次级别的异常（通常不会到达这里，因为内层已有 try-catch）
      console.error(`   批次 ${batchNum} 失败: ${err.message}`);
    }

    // 批次间延迟 500ms，给 Ollama 和 ChromaDB 喘息时间
    // 避免连续请求导致服务端队列堆积或超时
    if (i + BATCH_SIZE < docs.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\n✅ 灌入完成！`);
  console.log(`   成功: ${ingested} 条`);
  console.log(`   失败: ${failed} 条`);
  console.log(`   Collection: rag_medical → http://127.0.0.1:8000`);
}

// 顶层 await 包装：捕获未处理异常并设置非零退出码，
// 方便在 CI/CD 或 Shell 脚本中判断执行结果
main().catch((err) => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
