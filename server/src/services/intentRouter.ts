/**
 * 意图路由服务 — 将用户育儿问题自动分类到最匹配的 System Prompt 分诊
 *
 * ## 架构角色
 *
 * 本模块是对话管线的**第一道分诊闸门**。在用户问题进入 LLM 对话之前，
 * 先判断问题属于哪个育儿领域（疾病 / 喂养 / 睡眠 / 发育 / 急救 / 日常护理 / 疫苗），
 * 然后拼接对应的领域专属 System Prompt，确保每个问题获得专业风格的回复。
 *
 * ## 数据流位置
 *
 * ```
 * 用户输入 → [IntentRouter] → 领域 SP → LLM 对话 → 回复
 *              ↑ 本模块
 * ```
 *
 * 输入：用户自然语言问题（string）
 * 输出：IntentResult { intent, confidence, source, prompt }
 *   - intent:    分类标签
 *   - confidence: 置信度 0-1
 *   - source:     分类来源（keyword | llm），用于可观测性
 *   - prompt:     拼接好的完整 System Prompt，下游直接使用
 *
 * ## 分类策略（双层降级）
 *
 *   1. **关键词匹配**（免费，<1ms，本地执行）
 *      - 维护 7 组关键词规则，每组含领域关键词列表和基准置信度
 *      - 每命中一个额外关键词，置信度 +0.02（封顶 1.0）
 *      - 置信度 >= 0.9 → 直接采纳，不再调用 LLM
 *      - 置信度 >= 0.8 但 < 0.9 → 保留结果，进入 LLM 复核
 *
 *   2. **DeepSeek LLM 兜底分类**（有成本，~200-500ms，需网络）
 *      - 关键词命中但低置信度时 → 用 LLM 复核确认
 *      - 关键词完全无命中时 → 直接用 LLM 分类
 *      - LLM 失败时降级为 'general'，零宕机
 *
 * ## 降级路径
 *
 *   - 关键词命中 + 高置信 → keyword 路径（最快，零成本）
 *   - 关键词命中 + 低置信 → LLM 复核路径
 *   - 关键词未命中       → LLM 分类路径
 *   - LLM 调用失败       → 'general' 兜底（最坏情况仍可回复）
 *
 * ## 急救模式的特殊处理
 *
 * 急救意图（emergency）使用**完全独立的 System Prompt**，不与 BASE_PROMPT 拼接。
 * 原因：急救场景要求冷静果断、直接给动作指令，不需要共情开场和长篇原理。
 * 这是架构中唯一的"不走五段式"分支，逻辑在 routeIntent() 中硬编码。
 */

import { chat } from './deepseek.js';
import logger from '../utils/logger.js';

// ====== 意图类型 ======

/**
 * 育儿问题意图分类标签
 *
 * 共 8 种意图，覆盖"小熊育儿助手"的所有对话场景。
 * 新增意图时需要同步更新：
 *   1. INTENT_APPENDS — 对应的 System Prompt 附加指令
 *   2. KEYWORD_RULES   — 关键词匹配规则（至少一组）
 *   3. LLM_CLASSIFY_PROMPT 中的类别枚举
 *   4. 本类型定义
 *
 * @remarks
 * 'emergency' 使用独立 System Prompt，不走 BASE_PROMPT 拼接。
 * 'general'   为空附加指令，直接使用 BASE_PROMPT。
 */
export type Intent =
  | 'illness'        // 疾病护理：发烧、咳嗽、腹泻、湿疹等
  | 'feeding'        // 喂养：母乳、奶粉、辅食、厌奶
  | 'sleep'          // 睡眠：夜醒、哄睡、并觉
  | 'development'    // 生长发育：翻身、爬行、说话、长牙
  | 'emergency'      // 急救：抽搐、窒息、跌落、烫伤
  | 'daily_care'     // 日常护理：洗澡、脐带、剪指甲、红臀
  | 'vaccine'        // 疫苗与体检
  | 'general';       // 未分类，走通用 prompt

// ====== System Prompt 变体 ======

/**
 * 基础 System Prompt — 通用五段式回答结构
 *
 * 适用意图：illness / feeding / sleep / development / daily_care / vaccine / general
 * 不适用于：emergency（急救使用完全独立的 prompt）
 *
 * 五段式结构（必须严格遵循，不可跳过）：
 *   1. 🏷 先给结论   — 1-2 句核心判断，让家长立刻知道严重程度
 *   2. 📖 原理一句话 — 用比喻解释，1-3 句即可，降低认知负担
 *   3. ✅ 具体怎么做 — 分情况给出操作指南，有量化建议
 *   4. 🔴 就医判断   — 三级标注：🔴立即就医 / 🟡建议就诊 / 🟢继续观察
 *   5. 🩺 一行免责   — 法律安全底线
 *
 * 临床硬知识已嵌入 prompt 中（退烧药、禁忌、就医指征），
 * 减少 LLM 幻觉。如需更新医学知识，直接修改本常量即可。
 */
const BASE_PROMPT = `你是"小熊育儿助手"🐻 — 拥有 15 年临床经验的儿科主任医师。
风格温暖但不啰嗦，专业但不吓人。目标：让焦虑的家长 30 秒内找到答案。

## 回答结构（必须严格遵循，不可跳过任何一步）

1. 🏷 **先给结论**（1-2句核心判断）
2. 📖 **原理一句话**（用比喻解释，1-3句即可）
3. ✅ **具体怎么做**（分情况给出操作指南）
4. 🔴 **什么时候去医院**（带具体量化指标，「🔴立即就医」「🟡建议就诊」「🟢继续观察」三级标注）
5. 🩺 **一行免责**

## 临床硬知识（必要时使用）
- 退烧药：对乙酰氨基酚（≥3月龄，间隔≥4h）| 布洛芬（≥6月龄，间隔≥6h）
- ❌酒精擦浴=中毒 ❌捂汗=惊厥 ❌交替用药=伤肾 ❌和复方感冒药同服=成分过量
- <3月龄肛温≥38℃→直接去急诊
- 退烧后出汗及时擦干换干爽衣物

## 对话铁律
- 开场必共情，根据问题类型调整语气（疾病类要安抚、喂养/睡眠类要缓解焦虑、急救类要冷静果断）
- 没给月龄/体重→立刻追问，不猜
- 每句话都让家长觉得"有用"，删掉任何不增加决策价值的句子
- 说"不建议"时必跟理由+替代方案
- 回答末尾追问 1-2 个关键信息，引导家长补充`;

/**
 * 各意图的领域附加指令 — 拼接到 BASE_PROMPT 末尾
 *
 * 拼接规则：
 *   - 非急救意图：`BASE_PROMPT + INTENT_APPENDS[intent]`
 *   - 急救意图：  直接使用 `INTENT_APPENDS.emergency`，不拼接 BASE_PROMPT
 *
 * 每条附加指令的作用：
 *   - 强化该领域的回答侧重点（如疾病强调量化指标、喂养强调分月龄表格）
 *   - 调整语气倾向（发育避免制造焦虑、急救冷静果断）
 *   - 给出该领域特有的就医指征
 *
 * @remarks
 * general 的附加指令为空字符串，即纯 BASE_PROMPT。
 * emergency 的值是完整独立 prompt，包含角色、回答结构和对话铁律。
 */
const INTENT_APPENDS: Record<Intent, string> = {
  illness: `
## 🩺 疾病模式
- 强调量化指标：具体体温阈值、持续时间、脱水征象（6-8h无尿、前囟门凹陷、哭无泪）
- 🔴 部分必须列出至少 4 个具体危险信号
- 用药说明必附带"为什么"（不交替→伤肾、不同服→成分重叠）`,
  feeding: `
## 🍼 喂养模式
- 优先给出分月龄的喂养建议表格（0-3月/3-6月/6-12月/1岁+）
- 涉及厌奶/挑食时强调"这是正常阶段，绝大多数宝宝会自行度过"
- 不过度强调就医，只在体重下降、脱水等明确指征时才建议就诊`,
  sleep: `
## 😴 睡眠模式
- 给出分月龄的睡眠时长参考（新生儿16-20h / 3-6月14-16h / 6-12月12-15h）
- 优先推荐温和的睡眠训练方法（逐步消退法、安抚降级），不建议哭声免疫法
- 就医指征：只在怀疑呼吸暂停、异常嗜睡等情况下提出`,
  development: `
## 📈 发育模式
- 强调"每个宝宝节奏不同，比别的孩子慢≠有问题"
- 给出发育里程碑的正常区间（如翻身4-7月、独坐6-8月、走路10-18月）
- 避免制造焦虑，推荐具体的早期干预游戏而非空洞的"多练习"`,
  // 急救模式 — 完全独立的 prompt，不和 BASE_PROMPT 拼接
  // 设计决策：急救场景需即时行动指令，五段式科普结构会延误时机
  emergency: `你是"小熊育儿助手"🐻 — 儿科急救专家。当宝宝遇到跌落、烫伤、呛噎、抽搐等紧急情况时，你的任务不是科普，是救命。

## 🚨 急救回答规则

⚠️ 只用以下三段结构，不要用五段式，不要展开长篇原理，总共不超过300字：

1. 🚨 **现在立刻做什么**
   · 跌落/摔伤："先不要立刻抱起宝宝！蹲下观察10秒，确认能否活动、能否哭出声。如果宝宝立即大哭、四肢能动 → 安全抱起安抚。如果不动、不哭、眼神发直 → 立即拨打120，不要移动"
   · 抽搐："立即让宝宝平躺侧头，解开衣领，移开周围尖锐物。不要往嘴里塞任何东西，不要按压四肢。记录抽搐开始时间和持续时长，抽完立即就医"
   · 烫伤："立即用流动冷水冲15分钟以上，冲水时脱掉烫伤处的衣物（粘住不要撕）。不要涂牙膏、酱油、香油"
   · 呛噎窒息："面朝下趴在前臂，掌根拍背5次，翻正压胸5次，交替直到异物排出"

2. ⛔ **千万别做（关键禁忌）**

3. 🏥 **什么情况立刻打120**
   · 列3-5条最关键的，每条不超过15字

对话铁律：
- 第一句话就是急救动作，不共情，不安抚，直接告诉家长做什么
- 不用比喻，不解释原理
- 最后一句必须问关键信息帮助判断严重程度`,
  daily_care: `
## 🧴 日常护理模式
- 给出具体的步骤清单（如洗澡水温37-38℃、脐带护理用75%酒精棉签从内向外）
- 强调安全和预防，如跌落预防、烫伤预防
- 轻松实用语气，不需要过度强调就医`,
  vaccine: `
## 💉 疫苗模式
- 区分"正常疫苗反应"和"需要就医的异常反应"
- 给出常见疫苗的反应时间窗口（麻腮风7-12天发热、百白破24-48h发热）
- 强调"不要因为轻微反应推迟后续接种"`,
  general: ``,
};

// ====== 关键词规则 ======

/**
 * 关键词匹配规则 — 一组领域关键词和对应的意图标签
 *
 * 每条规则定义：
 *   - keywords:   该领域的关键词列表，用于在用户问题中进行子串匹配
 *   - intent:     匹配成功后分配的意图标签
 *   - confidence: 基准置信度（0-1），命中后还会根据命中关键词数量微调
 *
 * 置信度设计：
 *   - emergency:  1.0  — 命中即立即采纳，不走 LLM（最高优先级）
 *   - vaccine:    0.95 — 疫苗关键词高度特异，几乎不会误判
 *   - illness / feeding / sleep: 0.9 — 核心领域，高置信但不绝对
 *   - development / daily_care:  0.85 — 关键词可能和其他领域重叠，适度保守
 *
 * @remarks
 * 规则按优先级从高到低排列。classifyByKeyword() 遍历所有规则后取最高置信度，
 * 因此排列顺序不影响结果，但 emergency 排第一有利于代码可读性。
 */
interface KeywordRule {
  keywords: string[];
  intent: Intent;
  confidence: number; // 0-1，基准置信度
}

/**
 * 关键词规则库 — 共 7 组，覆盖所有非 general 意图
 *
 * 维护指南：
 *   - 新增关键词时避免过于宽泛（如"不"会命中大量不相关问题）
 *   - 如果某个意图频繁被误判，先检查关键词是否与其他领域重叠
 *   - 调整 confidence 值比新增关键词更安全（避免意外命中）
 *
 * 急救关键词（confidence: 1.0）：
 *   命中后立即采纳，绕过 LLM。因此急救关键词必须**高精度**——
 *   宁可漏判（走 LLM 兜底）也不可误判（影响用户生命安全感知）。
 */
const KEYWORD_RULES: KeywordRule[] = [
  // 急救（最高优先级 — 命中了立刻告警模式）
  {
    keywords: ['抽搐', '惊厥', '窒息', '呛到', '跌落后', '摔到头', '烫伤', '烧伤',
               '误食', '中毒', '溺水', '没呼吸', '没心跳', '没意识', '叫不醒',
               '翻白眼', '口吐白沫', '车祸', '高处坠落', '摔下来', '从床上摔',
               '磕到头', '撞到头', '掉下床', '摔下床', '摔伤', '摔到'],
    intent: 'emergency', confidence: 1.0,
  },
  // 疾病护理
  {
    keywords: ['发烧', '发热', '退烧', '咳嗽', '流鼻涕', '鼻塞', '感冒', '腹泻', '拉肚子',
               '拉稀', '呕吐', '吐奶', '便秘', '湿疹', '皮疹', '红疹', '过敏', '喘息',
               '喉咙', '嗓子', '发炎', '支气管', '肺炎', '肠炎', '中耳炎', '鹅口疮',
               '生病', '不舒服', '难受', '病', '咳', '烧', '痰'],
    intent: 'illness', confidence: 0.9,
  },
  // 喂养
  {
    keywords: ['母乳', '配方奶', '奶粉', '辅食', '厌奶', '断奶', '夜奶', '奶量', '喂奶',
               '吃奶', '不吃', '不爱吃', '挑食', '厌食', '喂养', '奶瓶', '乳头', '堵奶',
               '追奶', '营养', '维生素d', '维生素D', '补铁', '补钙', '缺铁', '缺钙',
               '米粉', '喝奶', '喝多少', '吃饱'],
    intent: 'feeding', confidence: 0.9,
  },
  // 睡眠
  {
    keywords: ['不睡觉', '夜醒', '哄睡', '奶睡', '抱睡', '睡眠', '睡整觉', '早醒',
               '白天睡', '晚上不睡', '昼夜颠倒', '并觉', '噩梦', '夜惊', '摇头', '蹭头',
               '睡不踏实', '一放就醒', '落地醒', '闹觉'],
    intent: 'sleep', confidence: 0.9,
  },
  // 生长发育
  {
    keywords: ['翻身', '爬行', '走路', '说话', '长牙', '出牙', '囟门', '发育', '身高',
               '体重', '不长', '偏矮', '偏瘦', '大运动', '精细运动', '语言', '不会',
               '还不会', '里程碑', '腿型', '不会走', '不会说', '不会爬', '不会翻'],
    intent: 'development', confidence: 0.85,
  },
  // 疫苗
  {
    keywords: ['疫苗', '接种', '打针', '疫苗反应', '预防针', '乙肝疫苗', '百白破',
               '麻腮风', '脊灰', '卡介苗', '自费疫苗', '免费疫苗', '体检', '儿保'],
    intent: 'vaccine', confidence: 0.95,
  },
  // 日常护理
  {
    keywords: ['洗澡', '脐带', '抚触', '剪指甲', '防晒', '蚊虫', '红臀', '红屁股',
               '热疹', '痱子', '清洁', '换尿布', '穿衣服', '室温', '枕头', '被子',
               '睡袋', '安抚奶嘴', '咬胶', '玩具'],
    intent: 'daily_care', confidence: 0.85,
  },
];

// ====== 分类逻辑 ======

/**
 * LLM 分类提示词 — 零样本分类，temperature=0 保证确定性
 *
 * 输入契约：`{question}` 占位符将被替换为用户原始问题
 * 输出契约：LLM 返回一个意图标签词（illness/feeding/sleep/development/emergency/daily_care/vaccine/general）
 *
 * @remarks
 * 使用 maxTokens=10 限制输出长度，减少成本和延迟。
 * classifyByLLM() 会从返回内容中提取第一个匹配的有效意图标签，
 * 因此即使 LLM 多输出了解释文字，也能正确解析。
 */
const LLM_CLASSIFY_PROMPT = `判断以下育儿问题属于哪个类别，只输出一个词：

类别：illness(疾病) feeding(喂养) sleep(睡眠) development(发育) emergency(急救) daily_care(日常护理) vaccine(疫苗) general(其他)

问题：{question}

类别：`;

/**
 * 意图路由结果
 *
 * 下游消费者（对话控制器）读取此结构，将 `prompt` 字段作为 System Prompt 传入 LLM。
 * `source` 和 `confidence` 用于日志、监控和 A/B 分析。
 */
export interface IntentResult {
  /** 分类后的意图标签 */
  intent: Intent;
  /** 置信度 0-1，keyword 来源为精确计算值，llm 来源固定 0.8 */
  confidence: number;
  /** 分类来源：keyword（本地匹配）或 llm（DeepSeek 分类） */
  source: 'keyword' | 'llm';
  /** 拼接好的完整 System Prompt，可直接作为 LLM 调用的 system message */
  prompt: string;
}

/**
 * 关键词匹配分类 — 第一层分诊
 *
 * ## 算法
 *
 * 1. 遍历所有 KEYWORD_RULES，对每条规则：
 *    a. 将该规则的 keywords 与用户问题做子串包含匹配（`String.includes`）
 *    b. 计算置信度：基准置信度 + 命中关键词数 × 0.02（封顶 1.0）
 *       - 例：命中 3 个 illness 关键词 → confidence = 0.9 + 3×0.02 = 0.96
 *    c. 保留当前最高置信度的意图
 * 2. 判断：最高置信度 >= 0.8 → 返回结果；< 0.8 → 返回 null（触发 LLM 兜底）
 *
 * ## 输入输出契约
 *
 *   - 输入：用户原始问题字符串（不预处理，保留原始措辞以匹配多字关键词）
 *   - 输出：{ intent, confidence } 或 null
 *     - null 表示关键词匹配不确定，调用方应进入 LLM 分类
 *
 * ## 设计考量
 *
 *   - 置信度阶梯：emergency(1.0) > vaccine(0.95) > illness/feeding/sleep(0.9) > development/daily_care(0.85)
 *     反映了各领域关键词的特异性——特异性越高（误判风险越低），基准置信度越高
 *   - 阈值 0.8：低于此值认为关键词匹配不可靠。development 和 daily_care
 *     需要命中 0 个额外关键词时 confidence=0.85，刚好超过阈值
 *   - 时间复杂度 O(R × K × Q)，其中 R=规则数(7)，K=平均关键词数(~20)，Q=问题长度
 *     实际 <1ms，对用户体验无影响
 *
 * @param question - 用户输入的自然语言问题（原始文本，不做清洗）
 * @returns 匹配结果（confidence >= 0.8）或 null（匹配不确定，需 LLM 兜底）
 */
function classifyByKeyword(question: string): { intent: Intent; confidence: number } | null {
  // 初始化为兜底意图，置信度为 0
  let bestIntent: Intent = 'general';
  let bestConfidence = 0;

  // 遍历所有规则组，计算每组的关键词命中情况
  for (const rule of KEYWORD_RULES) {
    // 子串匹配：找出 question 中包含的所有该规则关键词
    const matched = rule.keywords.filter((kw) => question.includes(kw));
    if (matched.length > 0) {
      // 置信度公式：基准值 + 命中数 × 0.02，封顶 1.0
      // 多命中关键词说明问题与该领域高度相关，适当提高置信度
      const confidence = Math.min(rule.confidence + matched.length * 0.02, 1.0);
      // 贪心策略：保留最高置信度
      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestIntent = rule.intent;
      }
    }
  }

  // 阈值判断：>= 0.8 认为关键词匹配可信
  // 0.8 是经过实测调优的平衡点——太低会误判，太高会过度依赖 LLM
  if (bestConfidence >= 0.8) {
    return { intent: bestIntent, confidence: bestConfidence };
  }
  // 置信度不足或无任何关键词命中 → 返回 null，调用方进入 LLM 分类
  return null;
}

/**
 * DeepSeek LLM 分类 — 第二层兜底
 *
 * ## 调用时机
 *
 *   1. 关键词完全无命中（classifyByKeyword 返回 null）
 *   2. 关键词命中但置信度 < 0.9（用于复核确认）
 *
 * ## 输入输出契约
 *
 *   - 输入：用户原始问题字符串
 *   - 输出：Intent 标签（保证为有效值，解析失败时返回 'general'）
 *   - 错误处理：任何异常（网络、超时、API 错误）都静默降级为 'general'
 *
 * ## 解析策略
 *
 * LLM 返回内容可能包含多余文字（如 "这个问题属于 illness 类别"），
 * 解析时用 `includes` 匹配第一个有效意图标签，而非精确相等。
 * 因此即使 prompt 要求"只输出一个词"，解析仍具鲁棒性。
 *
 * ## 性能特征
 *
 *   - 延迟：~200-500ms（DeepSeek API 网络往返 + 推理）
 *   - 成本：~10 tokens/次（maxTokens=10，temperature=0）
 *   - 温度：0，保证相同问题分类结果稳定
 *
 * @param question - 用户输入的自然语言问题
 * @returns 有效意图标签，解析或调用失败时返回 'general'
 * @throws 不抛出异常 — 所有错误在内部静默捕获并降级为 'general'
 */
async function classifyByLLM(question: string): Promise<Intent> {
  try {
    // 调用 DeepSeek chat API，temperature=0 保证确定性分类
    // maxTokens=10 限制输出长度（意图标签仅 1 个词）
    const { content } = await chat(
      [{ role: 'user', content: LLM_CLASSIFY_PROMPT.replace('{question}', question) }],
      { temperature: 0, maxTokens: 10 },
    );

    // 解析 LLM 返回内容：提取第一个匹配的有效意图标签
    // 使用 includes 而非精确匹配，容忍 LLM 输出多余文字
    const trimmed = content.trim().toLowerCase();
    const validIntents: Intent[] = ['illness', 'feeding', 'sleep', 'development', 'emergency', 'daily_care', 'vaccine', 'general'];
    const found = validIntents.find((i) => trimmed.includes(i));
    return found || 'general';
  } catch {
    // 静默降级：LLM 不可用时（网络故障、API 限流、超时），
    // 返回 'general' 保证对话流程不中断
    // 不记录 error 级别日志，由调用方 routeIntent 统一记录
    return 'general';
  }
}

/**
 * 意图路由 — 服务入口函数，双层分诊策略
 *
 * ## 完整流程
 *
 * ```
 *                     ┌─────────────────┐
 *                     │  routeIntent()   │
 *                     └────────┬────────┘
 *                              │
 *                     ┌────────▼────────┐
 *                     │ classifyByKeyword│  Step 1: 关键词匹配
 *                     └────────┬────────┘
 *                              │
 *                    ┌─────────▼─────────┐
 *                    │ confidence >= 0.9?│
 *                    └────┬─────────┬────┘
 *                         │YES      │NO / null
 *                    ┌────▼────┐ ┌─▼──────────┐
 *                    │ keyword │ │classifyByLLM│  Step 2: LLM 兜底
 *                    │ 直接采纳│ └──────┬──────┘
 *                    └────┬────┘        │
 *                         │        ┌────▼────┐
 *                         │        │ 拼接 SP │  Step 3: 拼接 System Prompt
 *                         │        └────┬────┘
 *                         │             │
 *                    ┌────▼─────────────▼────┐
 *                    │    返回 IntentResult   │
 *                    └───────────────────────┘
 * ```
 *
 * ## 决策矩阵
 *
 * | 关键词结果          | 置信度   | 动作                          | source   |
 * |--------------------|----------|-------------------------------|----------|
 * | 命中 emergency     | >= 1.0   | 直接采纳，独立 SP             | keyword  |
 * | 命中其他领域       | >= 0.9   | 直接采纳，拼接 BASE_PROMPT    | keyword  |
 * | 命中但低置信       | 0.8-0.89 | LLM 复核确认                  | llm      |
 * | 完全未命中         | —        | LLM 从头分类                  | llm      |
 * | LLM 调用失败       | —        | 降级为 'general'              | llm      |
 *
 * ## Prompt 拼接规则
 *
 *   - **emergency**：直接使用 `INTENT_APPENDS.emergency`（完整独立 prompt）
 *     - 原因：急救需要三段式简洁结构，BASE_PROMPT 的五段式科普会稀释紧迫感
 *   - **其他意图**：`BASE_PROMPT + INTENT_APPENDS[intent]`
 *     - BASE_PROMPT 提供通用角色和回答结构
 *     - INTENT_APPENDS 提供领域特有的侧重点和就医指征
 *   - **general**：仅 `BASE_PROMPT`（INTENT_APPENDS.general 为空字符串）
 *
 * ## 可观测性
 *
 * 每个分支都有 debug 日志，记录意图、置信度和来源：
 *   - `意图路由 [关键词]: illness (0.94)` — 关键词直接命中
 *   - `意图路由 [关键词低置信]: development (0.87)→ LLM复核` — 进入复核
 *   - `意图路由 [LLM]: feeding` — LLM 分类结果
 *
 * @param question - 用户输入的自然语言问题
 * @returns 意图分类结果，包含拼接好的 System Prompt。LLM 失败时返回 general 意图。
 * @throws 不抛出异常 — 所有降级路径均保证返回有效 IntentResult
 */
export async function routeIntent(question: string): Promise<IntentResult> {
  // Step 1: 关键词匹配（本地，<1ms）
  const keywordResult = classifyByKeyword(question);

  // 高置信度直接采纳 — 最快路径，零 LLM 成本
  if (keywordResult && keywordResult.confidence >= 0.9) {
    logger.debug(`意图路由 [关键词]: ${keywordResult.intent} (${keywordResult.confidence})`);
    // 急救模式用独立 prompt，不和 BASE_PROMPT 拼接
    // 设计决策：急救场景需要即时行动指令，五段式科普会耽误时间
    const prompt = keywordResult.intent === 'emergency'
      ? INTENT_APPENDS.emergency
      : BASE_PROMPT + INTENT_APPENDS[keywordResult.intent];

    return {
      intent: keywordResult.intent,
      confidence: keywordResult.confidence,
      source: 'keyword',
      prompt,
    };
  }

  // Step 2: 低于置信度阈值 → LLM 复核或从头分类
  // 关键词低置信度时记录日志，帮助排查是否误判
  if (keywordResult) {
    logger.debug(`意图路由 [关键词低置信]: ${keywordResult.intent} (${keywordResult.confidence})→ LLM复核`);
  }

  // 调用 DeepSeek 进行 LLM 分类（或复核）
  // 分类失败时 classifyByLLM 内部静默降级为 'general'
  const llmIntent = await classifyByLLM(question);
  logger.debug(`意图路由 [LLM]: ${llmIntent}`);

  // 拼接 System Prompt（与 keyword 路径一致的拼接规则）
  const prompt = llmIntent === 'emergency'
    ? INTENT_APPENDS.emergency
    : BASE_PROMPT + INTENT_APPENDS[llmIntent];

  // LLM 路径置信度固定 0.8
  // 原因：LLM 分类虽比关键词灵活但仍有误判可能，0.8 反映较高但不绝对的可信度
  return {
    intent: llmIntent,
    confidence: 0.8,
    source: 'llm',
    prompt,
  };
}
