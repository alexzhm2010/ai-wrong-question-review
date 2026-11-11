/**
 * 学科判定：模型自报的 <subject> 只当作「弱提示」，再用题干 + 解析正文 + 知识点
 * 的全文证据做校正。
 *
 * 为什么需要：
 *  - 模型偶尔把学科写成「高中数学」「数学（理科）」这类非规范值，旧逻辑严格相等匹配
 *    会直接落成「其他」，前端据此建出一个叫「其他」的错题本；
 *  - 也有模型凭题面首行就猜学科，物理题写成「数学」——错一次，归档就错一次。
 *
 * 判定原则：全文关键词证据显著强于自报值时，以证据为准；否则尊重自报值。
 * 知识点权重 ×3，因为知识点是最贴近学科的信号（如「匀变速直线运动」）。
 */

export const SUBJECTS = [
  "数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他",
] as const;

/** 学科特征词（不用正则元字符，按字面量计数） */
const KEYWORDS: Record<string, string[]> = {
  数学: [
    "函数", "方程", "不等式", "数列", "导数", "向量", "概率", "三角函数", "集合", "复数",
    "对数", "指数", "定义域", "值域", "单调", "奇偶", "椭圆", "双曲线", "抛物线", "三角形",
    "锐角", "钝角", "直角", "内角", "正弦", "余弦", "正切", "sin", "cos", "tan",
    "\\frac", "\\sqrt", "\\leq", "\\geq", "\\in", "判别式", "通项", "公比", "公差",
    "极值", "切线", "渐近线", "离心率", "排列组合", "二项式",
  ],
  物理: [
    "加速度", "速度", "位移", "牛顿", "摩擦力", "重力", "弹力", "拉力", "受力",
    "电路", "电流", "电压", "电阻", "电场", "磁场", "动量", "冲量", "功率", "做功",
    "机械能", "压强", "浮力", "折射", "透镜", "波长", "频率", "简谐", "匀变速",
    "自由落体", "安培", "伏特", "欧姆", "焦耳", "瓦特", "kg", "m/s", "角速度",
    "向心力", "动能定理", "楞次定律", "感应电动势",
  ],
  化学: [
    "化学式", "化学方程式", "摩尔", "物质的量", "氧化", "还原", "离子", "沉淀",
    "溶液", "浓度", "酸碱", "中和", "电解", "化合价", "催化剂", "有机物", "烷烃",
    "烯烃", "苯环", "元素符号", "相对原子质量", "配平", "水解", "电离", "pH",
  ],
  生物: [
    "细胞", "DNA", "RNA", "基因", "遗传", "染色体", "光合作用", "呼吸作用", "酶",
    "蛋白质", "氨基酸", "生态系统", "种群", "群落", "有丝分裂", "减数分裂", "激素",
    "免疫", "神经调节", "叶绿体", "线粒体", "内环境", "ATP", "基因型", "表现型",
  ],
  英语: [
    "passage", "grammar", "tense", "vocabulary", "translate", "sentence", "cloze",
    "reading comprehension", "comprehension", "时态", "从句", "单词", "语法",
    "完形填空", "阅读理解", "书面表达", "被动语态", "第三人称", "不定式", "过去分词",
    "介词", "连词", "英语作文",
  ],
  语文: [
    "文言文", "古诗", "诗歌", "修辞", "比喻", "拟人", "排比", "病句", "成语", "拼音",
    "汉字", "作者", "主旨", "意象", "文言", "虚词", "实词", "诗歌鉴赏", "现代文阅读",
    "记叙文", "议论文", "标点符号",
  ],
  历史: [
    "朝代", "皇帝", "革命", "战争", "条约", "王朝", "变法", "改革", "抗战", "解放",
    "世纪", "秦朝", "汉朝", "唐朝", "宋朝", "明朝", "清朝", "民国", "文艺复兴",
    "工业革命", "新民主主义", "土地改革", "改革开放", "鸦片战争",
  ],
  地理: [
    "经纬", "纬度", "经度", "气候", "地形", "海拔", "季风", "洋流", "板块", "大气",
    "降水", "气温", "等高线", "人口", "城市化", "区位", "水土流失", "荒漠化",
    "地球自转", "地球公转", "时区", "等高线地形图",
  ],
  政治: [
    "宪法", "法律", "市场经济", "宏观调控", "财政", "税收", "货币", "哲学", "唯物",
    "唯心", "矛盾", "价值规律", "人民代表大会", "公民", "权利", "义务", "中国共产党",
    "政府", "民主", "法治", "社会保障",
  ],
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countHits(words: string[], text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const w of words) {
    const re = new RegExp(escapeRe(w), "gi");
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}

/** 把模型自报值规范化到规范学科名；无法识别返回空串 */
export function normalizeSubjectTag(raw: string): string {
  const cleaned = (raw || "")
    .replace(/[\s"'“”‘’（）()【】\[\]。.、,，:：;；!！?？]/g, "")
    .trim();
  if (!cleaned) return "";
  for (const s of SUBJECTS) {
    if (s === "其他") continue;
    if (cleaned === s) return s;
  }
  // 模糊匹配：如「高中数学」「数学（理科）」「Physics」
  for (const s of SUBJECTS) {
    if (s === "其他") continue;
    if (cleaned.includes(s)) return s;
  }
  const en = cleaned.toLowerCase();
  const enMap: Record<string, string> = {
    math: "数学", maths: "数学", mathematics: "数学",
    physics: "物理", chemistry: "化学", biology: "生物",
    english: "英语", chinese: "语文", history: "历史",
    geography: "地理", politics: "政治",
  };
  for (const k of Object.keys(enMap)) {
    if (en.includes(k)) return enMap[k];
  }
  if (cleaned.includes("其他")) return "其他";
  return "";
}

export interface SubjectResolution {
  subject: string;
  tag: string;
  /** 各学科证据分，便于日志排查 */
  scores: Record<string, number>;
  /** 是否因证据与自报值冲突而改判 */
  changed: boolean;
}

/**
 * @param rawTag 模型自报的 <subject> 原文
 * @param questionText 题目文本
 * @param analysis 解析正文
 * @param knowledgePoints 知识点（权重 ×3）
 */
export function resolveSubject(
  rawTag: string,
  questionText: string,
  analysis: string,
  knowledgePoints: string[] = [],
): SubjectResolution {
  const tag = normalizeSubjectTag(rawTag);
  const corpus = `${questionText || ""}\n${analysis || ""}`;
  const points = knowledgePoints.join(" ");
  const scores: Record<string, number> = {};
  for (const s of SUBJECTS) {
    if (s === "其他") continue;
    const words = KEYWORDS[s];
    if (!words) continue;
    scores[s] = countHits(words, corpus) + countHits(words, points) * 3;
  }
  let best = "";
  let bestScore = 0;
  for (const s of Object.keys(scores)) {
    if (scores[s] > bestScore) { best = s; bestScore = scores[s]; }
  }
  const tagScore = tag ? scores[tag] || 0 : 0;

  // 自报值毫无文本支撑（含写成「其他」），而某学科有明确证据 → 以证据为准
  if (best && bestScore >= 2 && tagScore === 0) {
    return { subject: best, tag, scores, changed: !!tag && tag !== best };
  }
  // 证据显著强于自报值（领先 ≥3 分且自身 ≥3 分）→ 改判
  if (best && bestScore >= 3 && bestScore >= tagScore + 3 && best !== tag) {
    return { subject: best, tag, scores, changed: !!tag };
  }
  if (tag && tag !== "其他") {
    return { subject: tag, tag, scores, changed: false };
  }
  if (best && bestScore >= 2) {
    return { subject: best, tag, scores, changed: true };
  }
  return { subject: "其他", tag, scores, changed: false };
}
