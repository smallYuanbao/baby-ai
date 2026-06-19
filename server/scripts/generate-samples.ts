/**
 * ============================================================================
 * 育儿 QA Few-Shot 样本生成脚本
 * ============================================================================
 *
 * 用途：
 *   批量生成高质量育儿 Q&A 对，经过评分筛选后作为 System Prompt 的
 *   few-shot 示例（让 LLM 学习回答风格），同时灌入 ChromaDB 向量库
 *   用于 RAG 检索增强。
 *
 * 运作方式（四步流水线）：
 *   Step 1 — 用 DeepSeek 按育儿话题分类 + 月龄分布批量生成问题
 *   Step 2 — 用当前 System Prompt 让 DeepSeek 逐个回答，再自评打分
 *   Step 3 — 按分数排序并确保分类覆盖，筛选 Top K 条
 *   Step 4 — 将 Top K 条生成 embedding，灌入 ChromaDB「rag_samples」集合
 *
 * 输出文件（均位于 server/data/ 目录）：
 *   - sample-questions.json       原始问题列表（可复用缓存）
 *   - few-shot-samples.json       Top K 条 QA + 评分 + 分类
 *   - few-shot-prompt-block.txt   可直接粘贴到 System Prompt 的文本块
 *
 * ============================================================================
 * 前置条件
 * ============================================================================
 *
 * 1. Node.js >= 18（支持原生 fetch 和 ES modules）
 * 2. 环境变量（通过 .env 或 shell 设置）：
 *    - DEEPSEEK_API_KEY    DeepSeek API 密钥（必填）
 *    - DEEPSEEK_BASE_URL   DeepSeek API 地址（可选，默认官方地址）
 * 3. Ollama 本地服务已启动，且已拉取 embedding 模型
 *    （默认使用 nomic-embed-text，可在 ollama.ts 中修改）
 * 4. ChromaDB 已启动（默认 http://localhost:8000）
 *
 * 运行方式：
 *   npx tsx server/scripts/generate-samples.ts
 *
 * 耗时估算（TOTAL_QUESTIONS=50）：
 *   - Step 1: ~10 批次 × 1s 间隔 ≈ 30-60s
 *   - Step 2: 50 条 × (回答+评分) × 1.5s 间隔 ≈ 5-8min
 *   - Step 3: 瞬时
 *   - Step 4: 20 条 embedding ≈ 30s
 *
 * ============================================================================
 * 关键配置项（可在下方常量区调整）
 * ============================================================================
 *
 *   TOTAL_QUESTIONS  生成问题总数（默认 50，生产环境可调至 200）
 *   TOP_K            最终入选的 few-shot 示例数量（默认 20）
 *   BATCH_SIZE       每批生成的问题数（默认 5，避免单次 API 调用过长）
 *
 * ============================================================================
 * 边缘情况与注意事项
 * ============================================================================
 *
 * - 网络不稳定：每步均 try/catch，单条失败不中断整体流程
 * - API 限流：每批次间 sleep 1s，每条 QA 间 sleep 1.5s
 * - 重复问题：Step 1 结束后用 Set 去重
 * - 分类覆盖不均：Step 3 先从每个分类各取 top 3，再按总分补满 TOP_K
 * - 缓存机制：questions 写入 sample-questions.json，二次运行可跳过生成
 * - 评分解析失败：parseInt 失败时默认给 5 分（中位数）
 * - Ollama/ChromaDB 未启动：Step 4 单条失败会打印提示但继续
 */

// ============================================================================
// 依赖导入
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { chat } from '../src/services/deepseek.js';       // DeepSeek Chat API 封装
import { getEmbedding } from '../src/services/ollama.js';   // Ollama 本地 embedding 生成
import { addDocuments } from '../src/services/chroma.js';   // ChromaDB 向量写入

// ============================================================================
// 路径常量
// ============================================================================

/** server/data 目录 —— 所有中间产物和最终输出的落脚点 */
const OUTPUT_DIR = path.resolve('server/data');

/** 原始问题缓存文件 —— 断点续跑时从这里加载已生成的问题 */
const QUESTIONS_FILE = path.join(OUTPUT_DIR, 'sample-questions.json');

/** 最终输出的 few-shot 样本文件（JSON，含 question/answer/score/category） */
const SAMPLES_FILE = path.join(OUTPUT_DIR, 'few-shot-samples.json');

// ============================================================================
// 流程控制参数
// ============================================================================

/** 每批生成的问题数量。设小一些（5）可避免单次响应过长导致截断或质量下降 */
const BATCH_SIZE = 5;

/** 目标问题总数。当前设 50 用于验证流程；生产环境可调至 200+ */
const TOTAL_QUESTIONS = 50;

/** 最终入选 few-shot 示例的数量。需 <= TOTAL_QUESTIONS，且要 >= 分类数 */
const TOP_K = 20;

// ============================================================================
// 育儿话题分类（用于指导问题多样性）
// ============================================================================

/**
 * 每个分类包含：
 *   - name     显示名称（用于日志和输出标注）
 *   - keywords 种子关键词（空格分隔，用于 prompt 指引和后期分类匹配）
 *   - weight   权重（值越大，被随机选中的概率越高）
 *
 * 权重设计考量：常见病护理和喂养是新手父母最高频的焦虑来源，权重最高；
 * 睡眠次之；生长发育/疫苗/日常护理权重相当。
 */
const CATEGORIES = [
  { name: '常见病护理', keywords: '发烧 咳嗽 腹泻 湿疹 感冒 便秘 呕吐 过敏 出牙 红屁股', weight: 30 },
  { name: '喂养',       keywords: '母乳 配方奶 辅食 厌奶 断奶 奶量 厌食 挑食 过敏食物 维生素D', weight: 25 },
  { name: '睡眠',       keywords: '夜醒 哄睡 早醒 睡眠倒退 昼夜颠倒 奶睡 抱睡 并觉 噩梦 夜惊', weight: 15 },
  { name: '生长发育',   keywords: '身高 体重 大运动 精细运动 语言发育 出牙 囟门 腿型 走路 说话晚', weight: 10 },
  { name: '疫苗与体检', keywords: '疫苗反应 接种时间 自费疫苗 体检 黄疸 贫血 微量元素', weight: 10 },
  { name: '日常护理',   keywords: '洗澡 脐带护理 抚触 剪指甲 鼻塞 耳垢 防晒 蚊虫 红臀 热疹', weight: 10 },
];

// ============================================================================
// 宝宝月龄分布（用于让问题覆盖不同阶段）
// ============================================================================

/**
 * range: [minMonth, maxMonth]，0 表示未指定
 * label: 用于 prompt 中告知 LLM 目标月龄范围
 * weight: 分布权重。小婴儿和大婴儿阶段问题最多，新生儿和幼儿次之
 *
 * 注意：range[0] === range[1] 时（均=0）表示“未指定月龄”，
 * 用于生成不强调年龄的通用问题。
 */
const AGE_RANGES = [
  { label: '新生儿(0-28天)', range: [0, 1],    weight: 10 },
  { label: '小婴儿(1-6月)',  range: [1, 6],    weight: 30 },
  { label: '大婴儿(6-12月)', range: [6, 12],   weight: 30 },
  { label: '幼儿(1-3岁)',    range: [12, 36],  weight: 20 },
  { label: '未指定',          range: [0, 0],    weight: 10 },
];

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 加权随机选择 —— 根据 items 中每个元素的 weight 属性做概率抽样。
 *
 * 算法：累计总权重，生成 [0, totalWeight) 随机数，依次减去各元素权重，
 * 命中第一个 <= 0 的元素。若因浮点误差未命中，兜底返回第一个。
 *
 * @param items - 带 weight 属性的元素数组
 * @returns 按权重概率选中的元素
 */
function weightedRandom<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  // 浮点精度兜底
  return items[0];
}

/**
 * 将月龄 range 数组格式化为可读的中文描述，用于拼入 LLM prompt。
 *
 * @param range - [minMonth, maxMonth]
 * @returns 如 "新生儿(0-28天)"、"6-12个月"、"未指定月龄"
 */
function formatAge(range: number[]): string {
  // range[0] === range[1] 表示未指定月龄
  if (range[0] === range[1]) return '未指定月龄';
  // range[0] < 1（即 0 或小数）→ 新生儿阶段
  if (range[0] < 1) return '新生儿(0-28天)';
  return `${range[0]}-${range[1]}个月`;
}

// ============================================================================
// LLM Prompt 模板
// ============================================================================

/**
 * 问题生成 Prompt
 *
 * 设计思路：
 *   - 角色设定为“内容运营”，引导 LLM 产出贴近真实用户的问题
 *   - 要求“像微信群里问的”，避免机器感强的书面语
 *   - 限长 10-40 字，匹配真实用户的提问习惯
 *   - 输出要求纯文本每行一个问题，方便 split 解析
 *   - 具体的分类和月龄信息在循环中动态追加到该模板末尾
 *
 * 输出格式：每行一个问题，无编号、无标签
 */
const QUESTIONS_GEN_PROMPT = `你是一个育儿产品的内容运营。请生成 ${BATCH_SIZE} 个中国新手爸妈最常问的真实育儿问题。

要求：
1. 问题要具体、真实，像普通家长在微信群里问的那样
2. 覆盖多个话题，不要集中在同一类
3. 每个问题单独一行，不要编号，不要分类标签
4. 部分问题带宝宝月龄或年龄信息
5. 问题长度在 10-40 字之间

输出格式（纯文本，每行一个问题）：`;

/**
 * 回答质量评估 Prompt
 *
 * 评分维度（四项加总 = 0-10 分）：
 *   1. 回答结构清晰（emoji 分段，先结论后解释）   — 0-3 分
 *   2. 临床信息准确、有量化指标                   — 0-3 分
 *   3. 语气温暖共情但不啰嗦                       — 0-2 分
 *   4. 信息密度高，每句话都有用                   — 0-2 分
 *
 * 注意：
 *   - temperature=0 确保评分稳定可复现
 *   - 要求只输出数字，避免解析噪声
 *   - {question} 和 {answer} 在循环中由实际 QA 替换
 */
const EVAL_PROMPT = `你是一个育儿内容质量评估专家。请给以下 QA 对评分（1-10分），标准：

- 回答结构清晰（emoji 分段，先结论后解释）: 0-3 分
- 临床信息准确、有量化指标（体温阈值、时间、剂量原则）: 0-3 分
- 语气温暖共情但不啰嗦: 0-2 分
- 信息密度高，每句话都有用: 0-2 分

只输出一个数字分数，不要其他内容。

Q: {question}
A: {answer}

分数:`;

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  // 确保输出目录存在 —— 递归创建，已存在时不报错
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // =========================================================================
  // Step 1: 批量生成育儿问题
  // =========================================================================
  //
  // 逻辑：
  //   1. 先检查 QUESTIONS_FILE 是否有缓存，有则直接加载（支持断点续跑）
  //   2. 计算还需多少批次：ceil((目标总数 - 已有数) / 每批数量)
  //   3. 每批随机选一个分类 + 月龄范围，拼入 prompt 让 LLM 生成
  //   4. 解析响应（按行分割，清洗编号前缀，过滤过短/过长的行）
  //   5. 每批完成后立即写缓存，防止中断丢失
  //   6. 最终用 Set 去重，截取到 TOTAL_QUESTIONS
  //
  // 边缘情况：
  //   - 单批 API 调用失败 → catch 后 continue，不影响其他批次
  //   - 缓存文件损坏 → JSON.parse 抛异常被外层 catch 捕获，脚本终止
  //   - 生成的问题不足 → 去重后可能少于 TOTAL_QUESTIONS，Step 2 照常处理

  console.log('📝 Step 1: 生成育儿问题...\n');

  let allQuestions: string[] = [];

  // 尝试从缓存加载已有问题（断点续跑）
  const existing = await fs.readFile(QUESTIONS_FILE, 'utf-8').catch(() => '');
  if (existing) {
    allQuestions = JSON.parse(existing) as string[];
    console.log(`   从缓存加载 ${allQuestions.length} 个问题`);
  }

  // 计算还需多少批次
  const batchesNeeded = Math.ceil((TOTAL_QUESTIONS - allQuestions.length) / BATCH_SIZE);

  for (let b = 0; b < batchesNeeded; b++) {
    // 用 b % 分类数确保各分类轮转覆盖（而非完全随机，避免某些分类一次都轮不到）
    const category = CATEGORIES[b % CATEGORIES.length];
    // 月龄范围完全随机加权，增加多样性
    const ageRange = weightedRandom(AGE_RANGES);

    // 拼接最终 prompt：基础模板 + 本批次的分类和月龄指引
    const prompt = `${QUESTIONS_GEN_PROMPT}
话题侧重：${category.name}（如${category.keywords}）
月龄范围：${formatAge(ageRange.range)}的宝宝`;

    try {
      // 调用 DeepSeek Chat，高 temperature 鼓励多样性
      const { content } = await chat(
        [{ role: 'user', content: prompt }],
        { temperature: 1.0, maxTokens: 500 },
      );

      // 解析响应：
      //   1. 按行分割
      //   2. 去掉可能的编号前缀（如 "1、"、"2."、"3、"、"1)"、"1." 等）
      //   3. 过滤：长度 8-60 字（太短没信息，太长不像真实提问）
      const lines = content
        .split('\n')
        .map((l: string) => l.replace(/^[\d、.)-]+\s*/, '').trim())
        .filter((l: string) => l.length >= 8 && l.length <= 60);

      allQuestions.push(...lines);
      console.log(`   批次 ${b + 1}/${batchesNeeded}: ${category.name} → ${lines.length} 条`);

      // 每批立即写缓存，防止中断丢失已生成的数据
      await fs.writeFile(QUESTIONS_FILE, JSON.stringify(allQuestions, null, 2), 'utf-8');
    } catch (err: any) {
      // 单批失败不中断整体流程，但需关注日志判断是否需手动重跑
      console.error(`   批次 ${b + 1} 失败:`, err.message);
    }

    // API 限流保护：最后一批不再 sleep
    if (b < batchesNeeded - 1) await new Promise((r) => setTimeout(r, 1000));
  }

  // 去重（Set）+ 截取（slice），确保数量不超过 TOTAL_QUESTIONS
  allQuestions = [...new Set(allQuestions)].slice(0, TOTAL_QUESTIONS);
  console.log(`\n   去重后共 ${allQuestions.length} 个问题\n`);

  // =========================================================================
  // Step 2: 用 System Prompt 逐个生成回答 + 自评打分
  // =========================================================================
  //
  // 逻辑：
  //   1. 对每个问题，先调用一次 chat（role=system + role=user）生成回答
  //   2. 再调用一次 chat（temperature=0）让 LLM 自评打分
  //   3. 用简单关键词匹配判断该 QA 属于哪个分类
  //   4. 每条 QA 间隔 1.5s 避免限流
  //
  // 两次 LLM 调用的职责分离：
  //   - 第一次（temperature=0.7）：创造性回答，有一定随机性
  //   - 第二次（temperature=0）：确定性评分，结果稳定可复现
  //
  // 边缘情况：
  //   - 评分解析失败（非数字）→ parseInt 返回 NaN，兜底给 5 分
  //   - 分类关键词无匹配 → 归入「其他」
  //   - 单条失败不影响下一条（try/catch 内 continue）

  console.log('🤖 Step 2: 生成回答并评分...\n');

  // 定义结果类型：问题 + 回答 + 评分 + 分类标签
  type ScoredQA = { question: string; answer: string; score: number; category: string };

  /**
   * System Prompt —— 小熊育儿助手的完整行为规范。
   *
   * 这是最终产品中使用的同一份 System Prompt，在此脚本中用它生成
   * few-shot 样本可以保证样本风格与实际回答一致（分布对齐）。
   *
   * 五大回答结构（必须严格遵循）：
   *   1. 先给结论（1-2 句核心判断）
   *   2. 原理一句话（比喻解释）
   *   3. 具体怎么做（分情况操作指南）
   *   4. 什么时候去医院（带量化指标，三级标注）
   *   5. 一行免责声明
   */
  const SYSTEM_PROMPT = `你是"小熊育儿助手"🐻 — 拥有 15 年临床经验的儿科主任医师。
风格温暖但不啰嗦，专业但不吓人。目标：让焦虑的家长 30 秒内找到答案。

## 回答结构（必须严格遵循，不可跳过任何一步）

1. 🏷 **先给结论**（1-2句核心判断）
2. 📖 **原理一句话**（用比喻解释，1-3句即可）
3. ✅ **具体怎么做**（分情况给出操作指南）
4. 🔴 **什么时候去医院**（带具体量化指标，三级标注）
5. 🩺 **一行免责**

## 临床硬知识
- 退烧药：对乙酰氨基酚（≥3月龄，间隔≥4h）| 布洛芬（≥6月龄，间隔≥6h）
- ❌酒精擦浴=中毒 ❌捂汗=惊厥 ❌交替用药=伤肾 ❌和复方感冒药同服=成分过量
- <3月龄肛温≥38℃→直接去急诊
- 退烧后出汗及时擦干换干爽衣物

## 对话铁律
- 开场共情，没给月龄就追问
- 每句话都要让家长觉得"有用"
- 不确定就说不确定，不瞎编`;

  const results: ScoredQA[] = [];

  for (let i = 0; i < allQuestions.length; i++) {
    const q = allQuestions[i];
    console.log(`   [${i + 1}/${allQuestions.length}] ${q.slice(0, 40)}...`);

    try {
      // ---- 第 1 次 LLM 调用：生成回答 ----
      // 传入完整 System Prompt + 用户问题，temperature=0.7 保持一定创造性
      const { content: answer } = await chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: q },
        ],
        { temperature: 0.7, maxTokens: 600 },
      );

      // ---- 第 2 次 LLM 调用：自评打分 ----
      // 将 question 和刚生成的 answer 填入 EVAL_PROMPT 模板
      // temperature=0 确保评分稳定（相同 QA 多次评分一致）
      const { content: scoreStr } = await chat(
        [{
          role: 'user',
          content: EVAL_PROMPT.replace('{question}', q).replace('{answer}', answer),
        }],
        { temperature: 0, maxTokens: 10 },
      );

      // 解析评分：trim 后 parseInt，失败则兜底 5 分（10 分制的中位数）
      const score = parseInt(scoreStr.trim(), 10) || 5;

      // ---- 分类匹配 ----
      // 用简单的关键词匹配判断该 QA 属于哪个分类
      // 将分类的 keywords 按空格拆开，逐个检查是否出现在问题文本中
      const matchedCategory = CATEGORIES.find((c) =>
        c.keywords.split(' ').some((kw) => q.includes(kw))
      );

      results.push({
        question: q,
        answer,
        score,
        category: matchedCategory?.name || '其他', // 无匹配关键词 → 归入「其他」
      });

      console.log(`       得分: ${score}/10 | 分类: ${results[i].category}`);
    } catch (err: any) {
      // 单条失败不中断整体：打印错误后继续下一条
      console.error(`       失败: ${err.message}`);
    }

    // API 限流保护：每条 QA 间隔 1.5s，最后一条不再 sleep
    if (i < allQuestions.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  // =========================================================================
  // Step 3: 筛选 Top K 条 —— 兼顾质量与分类覆盖
  // =========================================================================
  //
  // 策略（防止某单一分类霸榜）：
  //   1. 先按分类分组（byCategory: Map<categoryName, ScoredQA[]>）
  //   2. 每个分类内按分数降序，取 top 3（保证每个分类至少 3 条）
  //   3. 合并所有分类的 top 3，再全局按分数降序
  //   4. 截取 TOP_K 条
  //
  // 边缘情况：
  //   - 某分类不足 3 条 → slice(0, 3) 会取全部，不影响后续
  //   - results 为空 → selected 为空，topResults 为空，输出空数组
  //   - TOP_K > 3 × 分类数 → 所有分类 top 3 都会被选中

  console.log('\n📊 Step 3: 筛选 Top 样本...\n');

  // 按分类分组
  const byCategory = new Map<string, ScoredQA[]>();
  for (const r of results) {
    const list = byCategory.get(r.category) || [];
    list.push(r);
    byCategory.set(r.category, list);
  }

  // 每个分类取 top 3（分类内按分数降序），再合并
  const selected: ScoredQA[] = [];
  for (const [cat, items] of byCategory) {
    items.sort((a, b) => b.score - a.score);
    selected.push(...items.slice(0, 3));
  }

  // 全局按分数降序，截取 TOP_K
  selected.sort((a, b) => b.score - a.score);
  const topResults = selected.slice(0, TOP_K);

  console.log('   入选样本:');
  for (const r of topResults) {
    console.log(`   [${r.score}/10] [${r.category}] ${r.question.slice(0, 50)}`);
  }

  // ---- 写入输出文件 1：JSON 格式的 few-shot 样本 ----
  await fs.writeFile(SAMPLES_FILE, JSON.stringify(topResults, null, 2), 'utf-8');

  // ---- 写入输出文件 2：可直接粘贴到 System Prompt 的文本块 ----
  // 格式：每个样本以 "---" 分隔，Q: 和 A: 分行
  const fewShotBlock = topResults
    .map(
      (r) => `---

Q: ${r.question}
A:

${r.answer}`,
    )
    .join('\n');

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'few-shot-prompt-block.txt'),
    fewShotBlock,
    'utf-8',
  );

  // =========================================================================
  // Step 4: 将 Top K 样本灌入 ChromaDB 向量库
  // =========================================================================
  //
  // 逻辑：
  //   1. 为每条 QA 生成唯一 ID（few-shot 样本 ID 前缀 + UUID 前 8 位）
  //   2. 将「问题 + 回答」拼接为全文，通过 Ollama 生成 embedding 向量
  //   3. 将文档 + embedding + 元数据一起写入 ChromaDB 集合「rag_samples」
  //
  // 元数据字段说明：
  //   - source: 'ai-generated-sample'  标记来源，方便后续过滤
  //   - category: 分类标签             用于按分类检索
  //   - score: 质量评分                用于按质量过滤
  //   - question: 原始问题             用于在检索结果中展示
  //   - type: 'qa_pair'                区分其他类型的入库文档
  //
  // 边缘情况：
  //   - Ollama 未启动 → getEmbedding 抛异常，打印提示
  //   - ChromaDB 未启动 → addDocuments 抛异常，打印提示
  //   - 部分成功 → ingested 计数器反映实际灌入数

  console.log('\n📚 Step 4: 将 Top 样本灌入向量库...\n');

  const docsToIngest = topResults.map((r) => ({
    id: `sample_${uuidv4().slice(0, 8)}`,  // sample_ + UUID 前 8 位，短且唯一
    text: `问题：${r.question}\n\n回答：${r.answer}`, // 全文用于 embedding
    metadata: {
      source: 'ai-generated-sample',
      category: r.category,
      score: r.score,
      question: r.question,
      type: 'qa_pair',
    },
  }));

  let ingested = 0;
  for (const doc of docsToIngest) {
    try {
      // 1. 通过 Ollama 将文本转为向量
      const embedding = await getEmbedding(doc.text);
      // 2. 写入 ChromaDB「rag_samples」集合
      await addDocuments([doc], [embedding], 'rag_samples');
      ingested++;
      console.log(`   ✅ [${ingested}/${docsToIngest.length}] ${doc.metadata.question.slice(0, 40)}...`);
    } catch (err: any) {
      // 单条灌入失败提示：最常见原因是 Ollama 或 ChromaDB 未启动
      console.error(`   ❌ 失败: ${err.message}（请确认 Ollama + ChromaDB 已启动）`);
    }
  }

  // =========================================================================
  // 完成汇总
  // =========================================================================

  console.log(`\n✅ 完成！`);
  console.log(`   Few-shot 样本: ${SAMPLES_FILE}`);
  console.log(`   Prompt 块: server/data/few-shot-prompt-block.txt`);
  console.log(`   向量库灌入: ${ingested}/${docsToIngest.length} 条 → collection: rag_samples`);
}

// ============================================================================
// 入口：执行主流程，捕获顶层未处理异常
// ============================================================================

main().catch((err) => {
  console.error('脚本执行失败:', err);
  process.exit(1); // 非零退出码，便于 CI/CD 或调度脚本判定失败
});
