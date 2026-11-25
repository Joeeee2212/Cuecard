/**
 * 中文语音跟随核心匹配引擎
 * 特点：
 * 1. 将原文拆分为可匹配字符流（过滤标点/空白，保留原文索引映射）
 * 2. 局部前向滑动窗口匹配，杜绝跨段乱跳
 * 3. 内置常见近音/易混字归一化 + 编辑容错，提升中文口播流畅度
 */

// 常见语音识别易混淆字符归一化映射（不引入庞大词库也能显著提升鲁棒性）
const HOMOPHONE_GROUPS = [
  '的得地',
  '他她它',
  '在再',
  '做作',
  '那哪',
  '象像向',
  '进近',
  '以已',
  '即既',
  '需须',
  '至致',
  '座坐',
  '带代',
  '长常',
  '成程',
  '事是时市实式',
  '一以已意易亿',
  '二尔耳',
  '三散',
  '四是似',
  '五无武',
  '七起期气',
  '八把吧',
  '九就久',
  '十是时实',
  '零灵',
  '两俩',
  '和合河何',
  '了乐',
  '不步布',
  '有又右友',
  '会回汇',
  '这着者',
  '个各',
  '们门',
  '中终钟',
  '为位未微',
  '发法',
  '大达',
  '可科刻',
  '能宁',
  '对队',
  '说所',
  '生声升',
  '自字',
  '用永',
  '同通',
  '行形型',
  '主注住助',
  '动懂',
  '分份纷',
  '提题体',
  '词次此',
  '器气起期',
  '语与于预',
  '音因引印',
  '识是实式',
  '别变',
  '模魔磨',
  '看刊',
  '录路露',
  '屏平评',
  '播波博',
  '稿高告',
  '读度都',
  '快块',
  '慢漫',
  '停听',
  '滚管',
  '显先线现',
  '示是事式',
  '功工公',
  '效校笑',
  '果过',
  '支知只值',
  '持池迟',
  '文问稳',
  '字自资',
  '卡咖',
  '片篇偏',
  '点电店',
  '击机及极',
  '键见件建',
  '窗创',
  '浮福服',
  '顶定丁',
  '镜经静精',
  '像向想响',
  '速素诉',
  '度都读'
];

const CHAR_EQUIV_MAP = new Map();
for (const group of HOMOPHONE_GROUPS) {
  const canonical = group[0];
  for (const ch of group) {
    if (!CHAR_EQUIV_MAP.has(ch)) {
      CHAR_EQUIV_MAP.set(ch, canonical);
    }
  }
}

// 阿拉伯数字转中文口语数字（如 "100" / "2026" 朗读时 ASR 常输出阿拉伯数字或中文数字）
const DIGIT_TO_ZH = {
  '0': '零', '1': '一', '2': '二', '3': '三', '4': '四',
  '5': '五', '6': '六', '7': '七', '8': '八', '9': '九'
};

export function isMatchableChar(ch) {
  // 中文汉字、英文字母、数字
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(ch);
}

export function normalizeChar(ch) {
  const lower = ch.toLowerCase();
  if (DIGIT_TO_ZH[lower]) {
    const zh = DIGIT_TO_ZH[lower];
    return CHAR_EQUIV_MAP.get(zh) || zh;
  }
  return CHAR_EQUIV_MAP.get(lower) || lower;
}

/**
 * 将原始文稿预处理为字元列表（保留原字符索引，便于精确高亮到字）
 */
export function tokenizeScript(rawText) {
  const tokens = []; // { char, norm, rawIndex }
  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (isMatchableChar(ch)) {
      tokens.push({
        char: ch,
        norm: normalizeChar(ch),
        rawIndex: i
      });
    }
  }
  return tokens;
}

/**
 * 清洗识别结果文本为可匹配规范化字符数组
 */
export function normalizeSpoken(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isMatchableChar(ch)) {
      out.push({
        char: ch.toLowerCase(),
        norm: normalizeChar(ch)
      });
    }
  }
  return out;
}

/**
 * 计算 spoken 尾部片段与 script 某个子区间 [start, end) 的匹配分数
 * 返回 { score, endPos }，允许少量插入/删除/替换（口语漏字、多字、同音字）
 */
function scoreAlignment(spokenSlice, tokens, startIdx, maxSpan) {
  const m = spokenSlice.length;
  const avail = Math.min(maxSpan, tokens.length - startIdx);
  if (m === 0 || avail <= 0) return { score: 0, matched: 0, endPos: startIdx };

  // 轻量级前向贪心+局部 DP（半全局对齐，专门优化实时语音尾部对齐）
  // dp[i][j] 表示 spoken[0..i-1] 对齐到 tokens[startIdx..startIdx+j-1] 的最高得分
  const cols = avail + 1;
  let prev = new Float32Array(cols);
  let curr = new Float32Array(cols);

  // 允许在 spoken 开头略过少量无关词（口头禅），但给予轻度惩罚
  for (let j = 0; j < cols; j++) {
    prev[j] = -0.35 * j; // 开头跳脚本字的代价
  }

  let bestScore = -Infinity;
  let bestEndOffset = 0;

  for (let i = 1; i <= m; i++) {
    curr[0] = -0.5 * i;
    const sp = spokenSlice[i - 1];

    for (let j = 1; j <= avail; j++) {
      const tk = tokens[startIdx + j - 1];
      let matchReward = -0.8;
      if (sp.char === tk.char.toLowerCase()) {
        matchReward = 2.0; // 精确命中
      } else if (sp.norm === tk.norm) {
        matchReward = 1.45; // 同音/近音命中
      }

      const diag = prev[j - 1] + matchReward;
      const skipScript = curr[j - 1] - 0.65; // 漏读脚本中的字
      const skipSpoken = prev[j] - 0.75; // 多读了口头禅/错字

      const val = diag >= skipScript ? (diag >= skipSpoken ? diag : skipSpoken) : (skipScript >= skipSpoken ? skipScript : skipSpoken);
      curr[j] = val;

      if (i === m && val > bestScore) {
        bestScore = val;
        bestEndOffset = j;
      }
    }

    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  // 归一化到 [0, 1] 区间：满分是 m * 2.0
  const maxPossible = m * 2.0;
  const ratio = maxPossible > 0 ? bestScore / maxPossible : 0;

  return {
    score: ratio,
    endPos: startIdx + bestEndOffset
  };
}

/**
 * 语音跟读定位器
 */
export class ScriptMatcher {
  constructor(rawText = '') {
    this.setScript(rawText);
  }

  setScript(rawText) {
    this.rawText = rawText || '';
    this.tokens = tokenizeScript(this.rawText);
    this.cursor = 0; // 当前已读到的 token 索引（0 ~ tokens.length）
  }

  reset() {
    this.cursor = 0;
  }

  setCursorByRawIndex(rawIndex) {
    if (this.tokens.length === 0) {
      this.cursor = 0;
      return;
    }
    let idx = this.tokens.findIndex((t) => t.rawIndex >= rawIndex);
    if (idx === -1) idx = this.tokens.length;
    this.cursor = idx;
  }

  getRawCursorIndex() {
    if (this.tokens.length === 0) return 0;
    if (this.cursor >= this.tokens.length) return this.rawText.length;
    return this.tokens[this.cursor].rawIndex;
  }

  getProgress() {
    if (this.tokens.length === 0) return 0;
    return Math.min(1, this.cursor / this.tokens.length);
  }

  /**
   * 喂入最新的识别文本（可以是 interim 或 final 片段），返回是否推进以及最新 cursor
   */
  feed(spokenText) {
    if (!spokenText || this.tokens.length === 0 || this.cursor >= this.tokens.length) {
      return { advanced: false, cursor: this.cursor, confidence: 0 };
    }

    const spoken = normalizeSpoken(spokenText);
    if (spoken.length < 2) {
      return { advanced: false, cursor: this.cursor, confidence: 0 };
    }

    // 取尾部窗口：长尾段（最多 10 字）用于稳健定位，短尾段（最多 5 字）用于极低延迟跟进
    const candidates = [];
    if (spoken.length >= 6) {
      candidates.push(spoken.slice(-10));
    }
    candidates.push(spoken.slice(-Math.min(5, spoken.length)));

    // 搜索范围：防乱跳，只允许小幅回看（处理 ASR 修正）与适度前瞻
    const lookBack = 3;
    const lookAhead = spoken.length >= 6 ? 38 : 20;
    const searchStart = Math.max(0, this.cursor - lookBack);
    const searchEnd = Math.min(this.tokens.length - 1, this.cursor + lookAhead);

    let best = { score: -1, endPos: this.cursor, distancePenalty: 0, finalScore: -1 };

    for (const slice of candidates) {
      const m = slice.length;
      const maxSpan = m + Math.min(6, Math.ceil(m * 0.5));

      for (let pos = searchStart; pos <= searchEnd; pos++) {
        // 至少必须推进过当前 cursor（避免原地踏步）
        if (pos + m <= this.cursor) continue;

        const res = scoreAlignment(slice, this.tokens, pos, maxSpan);
        const jump = Math.max(0, pos - this.cursor);
        // 距离惩罚：越靠近当前 cursor 越优先，防止重复短句跨行乱跳
        const distPenalty = jump * 0.015;
        const adjusted = res.score - distPenalty;

        // 动态阈值：片段越短，要求匹配率越高，越不允许大跳
        const minThreshold = m <= 3 ? 0.72 : m <= 5 ? 0.56 : 0.46;
        if (m <= 3 && jump > 8) continue;

        if (res.score >= minThreshold && adjusted > best.finalScore && res.endPos > this.cursor) {
          best = {
            score: res.score,
            endPos: res.endPos,
            distancePenalty: distPenalty,
            finalScore: adjusted
          };
        }
      }
    }

    if (best.endPos > this.cursor) {
      this.cursor = Math.min(this.tokens.length, best.endPos);
      return {
        advanced: true,
        cursor: this.cursor,
        confidence: Number(best.score.toFixed(2))
      };
    }

    return { advanced: false, cursor: this.cursor, confidence: 0 };
  }
}
