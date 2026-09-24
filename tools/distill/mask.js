// 专名掩码工具（作家印记蒸馏 · 第 0 步 / 方案 §3.1.5 去专名闸门）。
//
// 掩码契约（§3.1.5，不得自行发挥）：
//   占位符固定 4 字符：〔人名〕〔地名〕〔势力〕〔功法〕（按词条类别选，无法归类默认 person）
//   替换顺序最长优先（否则「凛霄圣地」会残留「圣地」）
//   只掩真专名，不掩题材词（修士/大帝/圣主/符文/宝术/道台/神识/灵气/仙台/天骄/大能……）
//   实现为逐名 split/join（实测 1.024 亿字 4.5 秒，无需 Trie）
//   「逐字引用」的比对基准是掩码后文本；char_count 一律按掩码后文本计
//
// 词典构建 = 多信号合成（对话提示语人名 / 高频 n-gram + 对照 lift / 书名号），
// 详细阈值与口径见各函数注释。实测背景：专名占语料 2.13%（273,867 / 12,887,822 字，复现脚本
// 自动词典口径；实施版白石词典 v1-6638fa90ef64 覆盖其语料 4.49%——分母与词典版本均不同，
// 见 02-实施报告 §1.5），400 字块中 73.7% 含 ≥3 个专名、零专名块仅 5.5% ——「只挑干净片段」
// 不可行，必须主动掩码。
'use strict';

const fs = require('fs');
const path = require('path');
const { han, sha256, paragraphsOf, stripChapterTitles } = require('./util');

// ---------- 掩码契约常量 ----------
const PLACEHOLDERS = { person: '〔人名〕', place: '〔地名〕', sect: '〔势力〕', skill: '〔功法〕' };
const placeholderFor = (type) => PLACEHOLDERS[type] || PLACEHOLDERS.person;

// ---------- 排除表 ----------
// 单字功能词：直接抄复现脚本 chunk-level-test.js 的 FUNC（去重）。
const FUNC_CHARS = new Set(
  '的了着地得而过其之乎者也矣焉哉与及或且但却则因由于在从向对为被把将给让使令叫已曾未没不别莫勿很太更最都也又再还就才只仅皆尽所吗呢吧啊呀哦嗯么啦嘛我你他她它们这那哪谁'.split('')
);
// 数字字：纯数字/数词开头的片段不是专名（「七大禁区」「十大高手」这类）。
const DIGIT_CHARS = new Set('零一二三四五六七八九十百千万亿两半几第'.split(''));
// 跨词碎片字：出现在词条任何位置都说明它是 n-gram 跨词粘连（「沈觉心」「是石」「个时候」
// 「可能会」），而非真专名——实测人名/地名/功法名不含这些字。
const FRAG_CHARS = new Set(
  '是在上里外内来去出入进开过会能可就便却乃都亦正被把向从为这个那位场声时后前间样般种件番话事心有惊'.split('')
  // 注：不含「中」——「中州」是真地名形态；「中X」碎片由「有/出/来/上」等尾字兜住
);

// 二字功能词：chunk-level-test.js 的 BIGRAM + 高频连接/时间/程度副词补充。
const FUNC_BIGRAMS = [
  '因为', '所以', '但是', '可是', '然而', '如果', '虽然', '不过', '于是', '然后', '而且', '并且',
  '已经', '正在', '将要', '可以', '能够', '应该', '必须', '似乎', '仿佛', '好像', '依然', '仍然',
  '忽然', '突然', '终于', '竟然', '居然', '果然', '显然', '当然', '也许', '大概', '几乎', '甚至',
  '尤其', '特别', '十分', '非常',
];

// 题材通用词与高频叙述词（契约：不掩题材词，掩了玄幻小说没法写；言情/现代侧同理）。
// 「圣地/禁地/禁区」这类后缀性题材词只排除「单独成词」，不阻止「凛霄圣地」整体入典。
const TOPIC_WORDS = [
  // —— 玄幻题材（契约点名的 22 个 + 同类）——
  '大帝', '圣主', '修士', '符文', '宝术', '神识', '灵气', '仙台', '道台', '天骄', '大能',
  '圣地', '禁地', '古路', '神源', '圣兵', '神火', '轮回', '天帝', '帝兵', '禁区', '神藏',
  '古皇', '人族', '妖族', '神族', '圣女', '神女', '仙子', '神王', '圣灵', '妖兽', '至尊',
  '强者', '长老', '弟子', '门人', '族人', '仙人', '神仙', '真仙', '天劫', '雷劫', '大劫',
  '上古', '太古', '远古', '洪荒', '万古', '神通', '秘术', '秘籍', '功法', '经文', '经卷',
  '古经', '真气', '罡气', '妖气', '魔气', '血气', '气血', '肉身', '真身', '法相', '异象',
  '杀机', '杀意', '战意', '威压', '修为', '境界', '实力', '气息', '洞府', '宫殿', '楼阁',
  '大殿', '广场', '石碑', '古碑', '青铜', '神城', '古城', '城池', '山脉', '虚空', '天地',
  '混沌', '雷霆', '雷电', '火焰', '风暴', '生死', '阴阳', '五行', '八卦', '符箓', '法阵',
  '阵法', '禁制', '阵纹', '神纹', '道则', '法则', '秩序', '神材', '神铁', '圣血', '精血',
  '灵物', '灵药', '灵石', '丹药', '药材', '灵泉', '天材', '地宝', '重宝', '至宝', '神器',
  '圣器', '法器', '灵宝', '兵刃', '神兵', '利刃', '锋芒', '道行', '慧根', '悟性', '资质',
  '根骨', '机缘', '造化', '因果', '气运', '命数', '劫数', '宿命', '大道', '天道', '生机',
  '死气', '阳气', '阴气', '戾气', '元气', '神念', '念头', '心神', '元神', '魂魄', '神魂',
  '识海', '泥丸', '天心', '大道', '天道', '苍穹', '星空', '星辰', '日月', '乾坤', '宇宙',
  '世界', '天地', '万物', '众生', '苍生', '世人', '人间', '世间', '天下',
  // —— 言情/现代题材（对照侧通用词，避免 lift 误收）——
  '老婆', '老公', '丈夫', '妻子', '结婚', '离婚', '恋爱', '婚礼', '婚姻', '恋人', '男友',
  '女友', '同学', '同事', '老师', '学生', '上班', '下班', '工作', '公司', '企业', '手机',
  '电话', '短信', '微信', '网络', '电脑', '电影', '电视', '音乐', '歌曲', '歌声', '超市',
  '商场', '学校', '大学', '高中', '初中', '小学', '教室', '课堂', '作业', '考试', '成绩',
  '班级', '校长', '邻居', '小区', '房子', '房间', '卧室', '客厅', '厨房', '阳台', '浴室',
  '沙发', '餐桌', '早饭', '午饭', '晚饭', '做饭', '炒菜', '爸爸', '妈妈', '父亲', '母亲',
  '爷爷', '奶奶', '外公', '外婆', '哥哥', '姐姐', '弟弟', '妹妹', '舅舅', '阿姨', '叔叔',
  '婶婶', '姑姑', '女儿', '儿子', '孩子', '小孩', '孙子', '老板', '员工', '经理', '助理',
  '秘书', '司机', '保安', '医生', '护士', '警察', '律师', '法官', '作家', '歌手', '明星',
  '演员', '导演', '编剧', '主播', '网红', '粉丝', '网友', '游戏', '动漫', '小说', '漫画',
  '照片', '视频', '直播', '镜头', '舞台', '剧场', '咖啡', '奶茶', '早餐', '晚餐', '宵夜',
  '外卖', '快递', '行李', '钱包', '钥匙', '衣服', '裤子', '裙子', '鞋子', '帽子', '眼镜',
  '手表', '背包', '书包', '城市', '街道', '马路', '汽车', '火车', '飞机', '车站', '机场',
  // —— 通用叙述高频词（动作/方位/时间/神态/身体，两题材通吃）——
  '忽然', '突然', '似乎', '仿佛', '好像', '淡淡', '冷冷', '幽幽', '轻轻', '缓缓', '慢慢',
  '匆匆', '悄悄', '默默', '静静', '深深', '紧紧', '狠狠', '猛地', '蓦地', '骤然', '顿时',
  '刹那', '瞬间', '片刻', '旋即', '当即', '立刻', '马上', '赶忙', '连忙', '急忙', '慌忙',
  '纷纷', '接连', '陆续', '不断', '不停', '不住', '一旁', '旁边', '身旁', '身边', '身后',
  '身前', '面前', '眼前', '跟前', '周围', '四周', '远方', '前方', '后方', '里面', '外面',
  '中间', '中央', '中心', '地方', '位置', '方向', '角落', '尽头', '深处', '高处', '低处',
  '声音', '语气', '口吻', '话语', '消息', '信息', '回答', '答案', '问题', '疑问', '疑惑',
  '想法', '念头', '心思', '心情', '情绪', '感情', '感觉', '感受', '气氛', '氛围', '表情',
  '神色', '神情', '眼神', '目光', '笑容', '笑意', '笑声', '哭声', '叹息', '呼吸', '心跳',
  '脸色', '面色', '神态', '姿态', '态度', '时间', '时候', '时刻', '之前', '之后', '以前',
  '以后', '如今', '现在', '目前', '当前', '当时', '那时', '这时', '此刻', '此时', '刚才',
  '方才', '早已', '曾经', '从来', '向来', '历来', '素来', '一向', '原来', '本来', '其实',
  '竟然', '居然', '果然', '显然', '当然', '自然', '依然', '依旧', '还是', '接着', '随后',
  '跟着', '说完', '看向', '望向', '走向', '走出', '走进', '跑去', '来到', '看到', '见到',
  '听到', '闻到', '感到', '想到', '说到', '做到', '找到', '得到', '落到', '陷入', '露出',
  '带着', '拿着', '抓着', '握着', '盯着', '望着', '看着', '说着', '笑着', '哭着', '喊着',
  '叫着', '吼着', '喘着', '顶着', '冒着', '扛着', '背着', '抱着', '扶着', '拉着', '推着',
  '拖着', '挤着', '站着', '坐着', '躺着', '蹲着', '跪着', '趴着', '走着', '跑着', '跳着',
  '开着', '关着', '锁着', '绑着', '捆着', '罩着', '裹着', '蒙着', '遮着', '挡着', '护着',
  '守着', '等着', '盼着', '转身', '抬头', '低头', '摇头', '点头', '皱眉', '蹙眉', '挑眉',
  '瞪眼', '眨眼', '闭眼', '睁眼', '张嘴', '闭嘴', '撇嘴', '咧嘴', '开口', '闭口', '失声',
  '出声', '出言', '回话', '答话', '说话', '传话', '搭话', '接话', '插话', '打断', '沉吟',
  '迟疑', '犹豫', '思考', '思索', '思量', '考虑', '琢磨', '寻思', '暗想', '暗道', '心想',
  '心中', '心底', '脑海', '脑中', '耳边', '周身', '全身', '身体', '体内', '体外', '面孔',
  '面容', '容颜', '容貌', '眉宇', '眉间', '双眸', '眼眸', '眸子', '瞳孔', '嘴角', '唇边',
  '下巴', '脸颊', '脸庞', '脖子', '肩膀', '双肩', '手臂', '双手', '手掌', '手心', '手指',
  '指尖', '拳头', '胸膛', '胸口', '后背', '脊背', '腰间', '双腿', '脚步', '脚下', '足下',
  '骨骼', '皮肤', '肌肤', '身影', '背影', '身形', '体形', '轮廓', '众人', '有人', '无人',
  '一人', '两人', '三人', '数人', '几人', '对方', '敌人', '别人', '他人', '旁人', '自己',
  '所有', '一切', '东西', '事情', '事物', '现象', '状态', '模样', '样子', '一番', '一阵',
  '一声', '一句', '一步', '一片', '一股', '一道', '一抹', '一丝', '一缕', '一瞬', '一切',
  // —— 实测观测补充（2026-09-12 语料 2-gram lift 通过名单里的非专名项；分两侧）——
  // 玄幻侧高频叙述词（白石语料 top：出现/强大/像是/生灵/可怕……均为通用词，非专名）
  '出现', '强大', '像是', '生灵', '可怕', '金色', '化成', '出手', '无比', '如此', '恐怖',
  '发出', '多人', '若是', '根本', '难以', '许多', '空中', '发生', '浑身', '些人', '黄金',
  '真正', '进入', '人物', '如同', '留下', '无法', '力量', '消失', '当年', '惊人', '同时',
  '大战', '生命', '各种', '巨大', '黑色', '白色', '红色', '发光', '神秘', '即便', '岁月',
  '手中', '黑暗', '落下', '下子', '震动', '无敌', '无上', '全部', '快速', '彻底', '平静',
  '璀璨', '传来', '吃惊', '人心', '晶莹', '震撼', '躯体', '想象', '中有', '修行', '如何',
  '今日', '镇压', '当中', '波动', '震惊', '爆发', '闪电', '闪烁', '绝世', '光芒', '古老',
  '进行', '长生', '散发', '自身', '有大', '鲜血', '兵器', '无论', '浮现', '充满', '头颅',
  '天空', '拥有', '滔天', '是天', '传说', '狮子', '战场', '危险', '眼中', '人可', '唯有',
  '轻人', '群人', '等人', '攻击', '诸多', '天神', '圣人', '皇子', '仙王', '大圣', '星域',
  '圣体', '气息', '滚滚', '滔滔', '森然', '凛然', '骇然', '悚然', '悄然', '骤然', '恍然',
  '冲天', '惊天', '动地', '翻滚', '弥漫', '扩散', '笼罩', '蔓延', '吞噬', '湮灭', '崩碎',
  '粉碎', '撕裂', '撕碎', '震碎', '崩塌', '坍塌', '毁灭', '陨落', '殒落', '杀气', '煞气',
  '年轻人', '便是', '究竟', '动用', '绽放', '出世', '自语', '来自', '开启', '精气', '迹象',
  '大地', '地上', '其中', '之后', '之内', '之上', '一下', '一声', '之地', '之时', '之名',
  // —— 第二轮观测（中频 2-gram lift 通过名单中的叙述词，36~200 名区段）——
  '手段', '神力', '阻挡', '成仙', '昔日', '暗中', '神光', '手持', '守护', '心头', '通体',
  '事实', '少人', '人大', '大手', '冷漠', '击杀', '模糊', '灿烂', '战力', '景象', '轰隆',
  '祭坛', '变色', '无边', '坠落', '沸腾', '故此', '神药', '金光', '燃烧', '战斗', '外界',
  '速度', '祭出', '眉心', '上界', '下界', '秘境', '施展', '封印', '法力', '强势', '引发',
  '神灵', '是否', '压制', '隆隆', '生出', '接近', '作响', '感应', '冲击', '盖世', '光华',
  '竟是', '飞出', '传出', '天人', '催动', '注定', '颤抖', '诡异', '缭绕', '大眼', '雪白',
  '神圣', '此人', '光辉', '剧烈', '寻找', '迅速', '听闻', '无疑', '当场', '宁静', '毁掉',
  '摇动', '白衣', '死去', '突破', '射出', '圣子', '暗淡', '号称', '挡住', '惊世', '寻到',
  '激烈', '必然', '银色', '并非', '原始', '失去', '尸体', '无穷', '诅咒', '各族', '日后',
  '奇异', '有无', '承受', '霞光', '极速', '碰撞', '至强', '交织', '足够', '复苏', '空间',
  '下方', '眸光', '成片', '忌惮', '纵然', '骨头', '人形', '遭遇', '绝代', '炽盛', '古星',
  '纪元', '猴子', '真龙', '荒古', '排斥', '驾驭', '驾驭', '浮现', '惊疑', '吸走', '斩杀',
  // —— 第三轮观测（top44 残余垃圾）——
  '仙气', '越发', '盘坐', '整片', '生物', '成功', '血液', '宛若', '古圣', '古教', '气息',
  // —— 第四轮观测（中频池 45~220 名区段的叙述词）——
  '传承', '洞天', '足以', '逆天', '区域', '血肉', '倒退', '相当', '演化', '冰冷', '终究',
  '形成', '烙印', '道仙', '海中', '永恒', '颤栗', '口中', '距离', '阵阵', '蕴含', '若非',
  '神威', '势力', '宝具', '威势', '气机', '慑人', '光泽', '炼化', '澎湃', '汹涌', '记载',
  '流动', '凶兽', '月票', '既然', '浩瀚', '古族', '印记', '家族', '符号', '美丽', '飞舞',
  '流转', '大教', '降临', '敌手', '流淌', '辉煌', '议论', '大势', '金属', '漫天', '疯狂',
  '石头', '山峰', '洒落', '毫无', '威力', '金翅', '光闪', '始终', '大成', '冲霄', '本源',
  '铸成', '要知', '说中', '魔神', '神明', '道身', '诸天', '庞大', '显化', '血色', '缕缕',
  '紫色', '剧震', '发呆', '咆哮', '价值', '俯视', '遭受', '仙光', '极致', '星河', '无数',
  '早先', '雾霭', '火光', '恐怕', '渡劫', '吓人', '光彩', '垂落', '深渊', '无情', '磨灭',
  '爆碎', '战车', '何等', '气势', '仙路', '汪洋', '光雨', '轰鸣', '无双', '躲避', '光束',
  '碎片', '击穿', '险些', '领域', '大山', '镇杀', '闭关', '艰难', '化作', '思议', '追杀',
  '超越', '横扫', '天穹', '发丝', '达到', '观看', '知晓', '横渡', '各大', '血脉', '冲起',
  '至今', '秘密', '公主', '准帝', '天尊', '世家', '净土', '帝族', '古矿', '渡过', '蛰伏',
  // —— 第五轮观测（碎片与残余）——
  '大长', '人敢', '道神', '运转', '族圣', '天大', '条路', '沌气', '活下', '片天', '传音',
  '圣子', '圣女峰', '问话', '回话', '开口',
  // —— 第六轮观测（155 词条名单里的叙述词；「X大/X冷/X怒」类碎片由前缀碎片规则处理）——
  '许多人', '人震', '诸圣', '此同', '该族', '龟裂', '亲自', '喀嚓', '洁白', '蜕变', '宙中',
  '性命', '座山', '座古', '融合', '神魔', '头大', '行动', '横飞', '肌体', '人无', '天宇',
  '刺目', '横空', '纹络', '山河', '绚烂', '甲胄', '茫茫', '重创', '道光', '当世', '轻语',
  '咬牙', '喃喃', '古树', '魔女', '物母气', '无量',
  // —— 第七轮观测（154 词条名单残余叙述词）——
  '迈步', '极大', '道纹', '赤红', '族长', '平日', '寂静', '朦胧', '飞仙', '失败', '大神',
  '到极', '子中', '古王', '波澜', '乌光', '清晰', '年人', '抖动', '降落', '修炼', '挥动',
  '族中', '道统', '无惧', '无匹', '剑气', '人发', '族大', '恐惧', '物母', '母气', '派网',
  // —— 第八轮（验收②误掩清除 + 模式提取噪声防护）——
  // 阵类（BLOCK 46「〔功法〕崩开了」= 古阵/杀阵被误收）
  '大阵', '古阵', '杀阵', '战阵', '剑阵', '幻阵', '迷阵', '困阵', '阵纹', '阵眼',
  // 兽/狮类（BLOCK 36「紫〔人名〕等异兽」）
  '金狮', '紫金', '银狮', '异兽', '猛兽', '妖兽',
  // 通用词（BLOCK 37 远〔人名〕阵一类）
  '席卷', '金狮', '世人', '大道',
  // 功法模式高频噪声（「XX法/XX术/XX书」）
  '办法', '想法', '方法', '说法', '做法', '看法', '手法', '用法', '书法', '艺术', '战术',
  '学术', '魔术', '幻术', '法术', '剑术', '刀术', '拳术', '秘书', '文书', '天书', '兵书',
  '秘书', '古书', '新书', '看书', '念书', '读书', '上书', '下书', '家书', '情书', '回书',
  // 势力模式高频噪声（「XX门/XX族/XX宗/XX府」）
  '大门', '房门', '宗门', '正宗', '祖宗', '种族', '贵族', '王府', '官府', '政府', '学府',
  '教主',
  // 称谓类（TITLE 后缀单独出现时）
  '老祖', '姥姥', '道人', '老道', '仙子', '明王', '神女', '天女', '大圣', '天君', '道君',
  '神君', '圣君', '妖王', '魔王', '神皇', '圣王', '人皇',
  // 强后缀单独出现时（模式不会收单字词根，防 n-gram 误收）
  '神术', '大法', '真解', '真诀', '天经', '心经', '宝典', '真经', '秘籍',
  '想办法', '没办法', '有办法', '好办法',
  // 言情侧高频叙述词（晚棠未开语料 top：出来/喜欢/看看/有点/会儿……）
  '出来', '喜欢', '看看', '有点', '会儿', '头看', '回去', '准备', '继续', '天天', '刚刚',
  '反正', '家里', '要是', '口气', '是个', '生活', '心里', '发上', '床上', '打开', '当初',
  '好好', '吃饭', '子上', '出门', '晚上', '今天', '女孩', '个月', '门口', '意思', '人家',
  '正常', '赶紧', '起身', '重新', '肚子', '上去', '女人', '动作', '手里', '想起', '伸手',
  '确实', '到时', '男人', '有个', '身子', '招呼', '做什', '想想', '随便', '拿出', '开心',
  '子里', '小时', '认识', '变成', '吃完', '脑袋', '放到', '点点', '放下', '好看', '关系',
  '舒服', '现代', '转头', '下午', '嘿嘿', '容易', '学习', '明天', '打算', '手上', '嘴里',
  '回家', '桌上', '上次', '睡觉', '坐到', '日子', '偶尔', '偷偷', '站起', '努力', '看见',
  '习惯', '左右', '块儿', '好吃', '看电', '女朋', '何妨', '打赏', '女朋友', '男朋友',
];

const STOP_WORDS = new Set([...FUNC_BIGRAMS, ...TOPIC_WORDS]);

// 作者专属停用词（STOP 清单的人工批次）已外置：见 tools/distill/wordlists/<作者>.json 的
// stopWords 字段，经 buildDict 的 stopWords 选项传入（默认空=只用下面的通用词层）。
// 原 9 批共 636 条的逐条核对记录见该文件 note 与 02-实施报告 §1；此处不再内嵌任何作者词条，
// 否则换作者时会被静默套用（跨作者污染，2026-09-12 核查实测）。

// —— 2 字 n-gram 候选的「专名证据」闸门（验收③第五轮，2026-09-12）——
// 背景：2 字候选池 count≥100 的有 2966 个（多数是通用词：残酷/盯住/涅槃…），按 count
// 排序时永远排在真名前、把预算吃光并产生海量误掩（实测教训：清单式清理是死循环——
// 清掉 500+ 档后立刻浮出 480+ 档的 110 个通用词）。改为证据制，2 字候选必须满足其一：
//   ① 人工确证白名单（作者词表 confirmedTwoChar / confirmed3Plus，见下）或
//   ② 出现在对话提示语位置（「XX道：」——会说话的基本是人物）或
//   ③ 命中强地名/势力尾字（异域/仙域/楚家/帝关…）或
//   ④ 是已确认专名（对话/模式/include 来源）的 2 字子串（金乌←金乌道人、鲲鹏←鲲鹏宝术）。
// 3+ 字候选不在此闸门内（仍走统计门槛 + STOP 词表）；include 强制入典不受影响。
// 两张证据白名单已外置到 tools/distill/wordlists/<作者>.json（默认空，不内置任何作者）。

// 强地名/势力尾字（真名率高、通用词少；「星/月/海/河/林/峰」等通用尾字故意不收）
const EVIDENCE_TAILS = new Set('域庭殿宫阁院府斋村族家宗门教派帮盟会国界洲岭荒'.split(''));

// —— 证据⑤：姓氏起头（验收②第六轮，2026-09-12）——
// 背景：四轮人工核对共确证 ~120 个漏收，其中大头是「姓+名」式中低频配角（徐恒/徐天雄/
// 金赤霄/王静/李飞/管承…，出现 5~500 次）：无对话位置、无强尾字、无已证子串，四条证据
// 全不满足——但「首字是中文姓氏 + 全汉字 + 过停用表 + 对照 lift」合起来是很强的人名证据。
// 误收防线：STOP_WORDS（马上/黄河类常用词）+ liftPass（对照作者语料出现过的组合不收）
// + hasBadChar/hasForbiddenSub/hasNumQuant + 碎片剪枝照常生效。
const SURNAMES = new Set((
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜' +
  '叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史' +
  '陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤').split('').reduce((set, ch) => { set.add(ch); return set; }, new Set()));
function surnameEvidence(name, stop = STOP_WORDS) {
  if ((name.length === 2 || name.length === 3) && SURNAMES.has(name[0])) {
    if (stop.has(name)) return false;
    if (hasBadChar(name) || hasForbiddenSub(name) || hasNumQuant(name)) return false;
    if (DIGIT_CHARS.has(name[name.length - 1])) return false; // 「王三」「李十」类数量组合
    return true;
  }
  return false;
}

// 词内禁片段（验收③）：「人根本无法」「定要想办法」「踩神秘步法」——出现即拒（任何来源、
// 任何位置）。「一道」不进表——「成一道人」「玄一道人」是真称号，靠下面的词首数词规则区分。
const FORBIDDEN_SUBS = [
  '无法', '办法', '方法', '神秘', '一些', '什么', '怎么', '这些', '那些', '手中', '手持',
  '身上', '身体', '动用', '大教', '所有', '任何', '一本', '一个', '两个', '几个',
  '我们', '他们', '你们', '自己', '此时', '此刻', '知道', '觉得', '盖世',
  // 碎片链通用片段（验收③第三批）：清掉长词后其 n-1 碎片会浮出（「认真请教」「无以伦比」）
  '请教', '无以', '伦比',
];
// 词内禁用单字：语气/代词/指示/量词字——真专名不含（实测语料「诸」5770 次全部是
// 「诸多/诸位」类描述用法，无「诸葛」；「哪」4286 次无「哪吒」；「些/级」同理）。
const FORBIDDEN_CHARS_ANY = new Set('诸么嘿唉哦呀吧呢吗们您啥哪谁些级'.split(''));

/** 词内禁片段/禁字检查（isExcludedName / dialogCandidateOK / patternRootOK 三处共用）。 */
function hasForbiddenSub(name) {
  for (const s of FORBIDDEN_SUBS) if (name.includes(s)) return true;
  for (let i = 0; i < name.length; i++) if (FORBIDDEN_CHARS_ANY.has(name[i])) return true;
  return false;
}

// 数词/量词组合（验收③）：「一名四极秘」「一页神灵古经」「四大天女」「九大祖乌法」。
// 只查词首两字（「成一道人」的「一道」在词内，不能误杀）+ 词内「数词+大」
// （「大」紧跟数词时必是量词短语；「大帝/大圣」的「大」前是名字字如「恒宇大帝」，不受影响）。
const NUM_CHARS_C = new Set('一二三四五六七八九十百千万两半几数众'.split(''));
const QUANT_CHARS_C = new Set('个大名页道种些点座封件只条片块群把柄尊位本卷篇章回次场轮张颗粒缕丝器'.split(''));
const RE_NUM_DA = /[一二三四五六七八九十百千万两半几数]大/;
function hasNumQuant(name) {
  if (NUM_CHARS_C.has(name[0]) && QUANT_CHARS_C.has(name[1])) return true;
  return RE_NUM_DA.test(name);
}

// 前缀虚词剥离（验收③）：「如广寒仙子」「自荒古禁地」「信苍始大帝」——首字是纯功能字、
// 去掉后主体是池中候选的是跨词粘连碎片。只对 ≥4 字生效（3 字词无此形态，
// 「平乱诀」「自补天」不受影响）。
const CONTEXT_HEADS = new Set(
  '如若同跟与以自离连非信随代年被把向从在对给让使按照而且但因于之乎者也都已经未不曾更最就才只仅皆尽所请令叫将些诸各某该此彼页'.split(''));

// 称号词根里的通用类属/描述词（验收③）：「人族大帝」「妖族大帝」「远古大帝」「棕发大圣」
// 是描述短语不是称号；与「玄穹大帝」「恒宇大帝」的区别在于后者词根是专名用字组合。
// 注意：「白衣神王」（真称号、在人工清单里）的词根「白衣」不在此表内，不受影响。
const TITLE_ROOT_STOP = new Set([
  '人族', '妖族', '神族', '魔族', '古族', '异族', '万族', '百族', '种族', '大族', '王族',
  '远古', '上古', '太古', '荒古', '中古', '近古', '当代', '历代', '所有', '任何', '无数',
  '众多', '诸位', '盖世', '绝代', '棕发', '白发', '黑发', '金发', '长发', '红衣', '黑衣',
]);

/** 通用类属词根 + 称号后缀（验收③）：「人族大帝」「绝代神王」必须在这里也拦一道——
 *  否则 pattern 路径拒了、n-gram 路径（同样 count 达标）又把它收回来（两条路都走
 *  isExcludedName）。TITLE_SUFFIXES 定义在下方（模式段），运行时已初始化。 */
function hasGenericTitleRoot(name) {
  for (const t of TITLE_SUFFIXES) {
    if (!name.endsWith(t)) continue;
    const root = name.slice(0, -t.length);
    if (root.length >= 2 && TITLE_ROOT_STOP.has(root)) return true;
  }
  return false;
}

// 称谓/代词（对话提示语信号的高频噪声；既做精确匹配也做子串匹配，见下）。
const APPELLATIONS = [
  '他', '她', '它', '你', '我', '您', '咱们', '大家', '众人', '众修', '群修', '诸人', '诸修',
  '老者', '老人', '老头', '老妪', '老妇', '老魔', '老怪', '少年', '少女', '少妇', '青年',
  '女子', '男子', '大汉', '壮汉', '汉子', '孩子', '小孩', '孩童', '婴儿', '妇人', '美妇',
  '中年', '白发', '修士', '长老', '弟子', '门人', '族人', '对方', '仇人', '亲人', '家人',
  '兄弟', '姐妹', '夫妻', '情侣', '朋友', '友人', '客人', '主人', '仆人', '下人', '侍女',
  '侍从', '随从', '护卫', '高手', '道人', '和尚', '道士', '尼姑', '书生', '公子', '小姐',
  '王爷', '陛下', '皇上', '皇帝', '城主', '谷主', '岛主', '教主', '掌门', '首座', '首领',
  '头领', '前辈', '晚辈', '小辈', '长辈', '先辈', '祖先', '古人', '死人', '凡人', '常人', '大长老',
  '一行', '来人', '声音', '心中', '一旁', '旁边', '对面', '身后', '身前', '面前', '闻言',
  '众女', '各家', '各派', '双方', '此女', '此子', '那人', '这人', '对手', '一伙', '一众',
];
const APPELLATION_SET = new Set(APPELLATIONS);

// 对话捕获首字排除：代词/指示词/量词开头的基本都是「他冷笑道」式误捕或称谓。
const PRONOUN_HEADS = new Set('他她它你我您这那其老少众谁几此'.split(''));

// 软功能字：既是副词/虚词（太快/再见/都是）又是名字字（太虚/再生/帝都）——
// 只在首字判为功能字，其他位置豁免（「先天太虚罡气」「凰劫再生术」「花都」）。
const SOFT_FUNC_CHARS = new Set(['太', '再', '都']);

// 对话捕获中不应出现的词片段（副词/动作/接语——「淡淡说道」「闻言道」的捕获组里会带上它们）。
const BAD_DIALOG_SUBS = [
  '淡淡', '冷冷', '幽幽', '轻轻', '缓缓', '忽然', '突然', '闻言', '听闻', '听到', '听了',
  '大声', '低声', '沉声', '厉声', '喝声', '冷笑', '大笑', '苦笑', '失笑', '轻笑', '嘿然',
  '哑然', '调侃', '催促', '反驳', '询问', '回答', '解释', '招呼', '随口', '顺口', '半晌',
  '沉吟', '迟疑', '犹豫', '抬头', '低头', '摇头', '点头', '拱手', '行礼', '施礼', '颔首',
  '挥手', '摆手', '翻身', '纵身', '起身', '站起', '坐下', '走来', '走出', '走进', '冲进',
  '闯进', '推门', '开口', '闭口', '张口', '撇嘴', '咧嘴', '眯眼', '眨眼', '蹙眉', '皱眉',
  '挑眉', '随即', '旋即', '当即', '接着', '顿了', '应声', '对了', '然后', '这次', '此次',
  '这话', '此话', '此言', '什么', '怎么', '为什么', '传音', '调侃', '嘀咕', '自语',
  '回头', '好奇', '狐疑', '补充', '转口', '试探', '提议', '含糊', '嘱咐', '认真',
  '嘿嘿', '哈哈', '呵呵', '许多', '嗤笑', '哂笑', '失笑',
];

// 言说动词（对话信号用；多字在前避免「说」吃掉「说道」）。
// 末尾单字集合同时用于两条排除：捕获组含言说动词单字的丢弃、n-gram 候选以言说动词单字结尾的丢弃
// （否则「沈觉道」「沈觉说」这类「人名+动词」碎片会入典，掩码时吃掉动词字）。
const SPEAK_VERB_MULTI = [
  '低声道', '沉声道', '冷声道', '厉声道', '大笑道', '苦笑道', '冷笑道', '淡淡道', '幽幽道',
  '接口道', '开口道', '回应道', '解释道', '喃喃道', '嘀咕道', '咕哝道', '传音道', '高声道',
  '大声道', '高声喊', '大声喊', '淡淡说', '冷冷说', '低声说', '大声说', '沉声说', '调侃道',
  '催促道', '反问道', '询问道', '回答道', '说道', '问道', '答道', '喊道', '叫道', '笑道',
  '叹道', '骂道', '喝道', '怒道', '吼道', '惊道', '喃道', '低语', '冷哼', '咕哝', '嘀咕',
  '说道', '说着',
];
const SPEAK_VERB_SINGLE = '道说问喊叫答叹骂笑吼喝';
const SPEAK_VERB_CHARS = new Set(SPEAK_VERB_SINGLE.split(''));
// 言说动词组是超高频通用词（「说道」9157 次/lift 也能过），同样不得入典
for (const w of SPEAK_VERB_MULTI) STOP_WORDS.add(w);

const VERB_ALT = [...new Set(SPEAK_VERB_MULTI)]
  .sort((a, b) => b.length - a.length)
  .concat([...SPEAK_VERB_CHARS])
  .join('|');

// 对话提示语两条高频模式（实测《蔽霄(1-500章)》后置式 ~1053 命中、前置式 ~1222 命中）：
//   后置：“……”沈觉道，/ “……”他冷笑道：    → [”」] 后紧邻 2~4 字 + 言说动词 + 标点
//   前置：沈觉道：“……                      → 2~4 字 + 言说动词 + ： + 开引号
const RE_DIALOG_AFTER = new RegExp(
  `[”」]([^”」“「”：:，。！？…·\\r\\n]{2,4})(?:${VERB_ALT})[：:，,。；！]`, 'g');
const RE_DIALOG_BEFORE = new RegExp(
  `([^：:”」“「」，。！？…·\\r\\n]{2,4})(?:${VERB_ALT})[：:][“「]`, 'g');
// 书名号（含盗版清洗变体：内部单字强调的『』、错配右界如「』太皇经》」——实测
// 蔽霄 1001-1500 章文件把『』当单字强调用（『色』『露』），单字会被长度与排除表滤掉）
const RE_BOOK_TITLE = /[《『「]([\u4e00-\u9fff]{2,6})[》』」]/g;

const ALL_HAN_RE = /^[\u4e00-\u9fff]+$/;
const isAllHan = (s) => ALL_HAN_RE.test(s);
const isHanCode = (c) => { const x = c.charCodeAt(0); return x >= 0x4e00 && x <= 0x9fff; };

/** n-gram 候选的通用排除（对话/书名号候选另有专门过滤，但也走这里兜底）。
 *  虚词字（的了着…）与跨词碎片字（是在上…）任何位置都不该出现——但「X圣地/X禁地」后缀
 *  豁免「地」字（FUNC 的「地」是副词标记，而这里是名词尾字；不豁免会整体误杀
 *  「凛霄圣地」「澜水圣地」这类真势力名）；数字字只查首尾——
 *  「许十安」（真名中间含「十」）不丢，「十大禁地」「沈觉三」（碎片）丢。 */
function isExcludedName(name, stop = STOP_WORDS) {
  if (!isAllHan(name) || name.length < 2) return true;
  if (stop.has(name) || APPELLATION_SET.has(name)) return true;
  if (hasForbiddenSub(name) || hasNumQuant(name) || hasGenericTitleRoot(name)) return true;
  if (hasBadChar(name)) return true;
  if (DIGIT_CHARS.has(name[0]) || DIGIT_CHARS.has(name[name.length - 1])) return true;
  return false;
}

/** 字级功能/碎片检查（isExcludedName / dialogCandidateOK / patternRootOK 三处共用）。
 *  - FRAG 碎片字任何位置拒；
 *  - FUNC 功能字任何位置拒，例外：
 *    「地」在「X圣地/X禁地」后缀时豁免（那里是名词尾字，不是副词标记）；
 *    软功能字（太/再/都）在「非首字」或「词长 ≥3」时豁免——它们是副词（太快/再见/都是，
 *    2 字组合仍拒）但也是名字字（太虚/再生/帝都/太皇经，实测「太皇经」被首字规则误杀过）。 */
function hasBadChar(name) {
  const sectSuffix = RE_SUFFIX_SECT2.test(name);
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (FRAG_CHARS.has(ch)) return true;
    if (!FUNC_CHARS.has(ch)) continue;
    if (SOFT_FUNC_CHARS.has(ch) && (i > 0 || name.length >= 3)) continue;
    if (ch === '地' && sectSuffix) continue;
    return true;
  }
  return false;
}

// 「专名 + 叙述词」碎片的尾巴黑名单（「沈觉突然」「沈觉走出」「沈觉心」一类）。
// 注意与题材后缀区分：「大帝/圣地/古路/宝术」等题材词收尾是**真专名形态**（苍始大帝/凛霄圣地），
// 绝不能放进本表（首版就犯过这个错，把「苍始大帝」当碎片丢了）。
const BAD_TAIL_WORDS = new Set([
  '突然', '忽然', '竟然', '居然', '果然', '显然', '当然', '依然', '仍然', '顿时', '刹那',
  '瞬间', '片刻', '旋即', '当即', '立刻', '马上', '赶忙', '连忙', '急忙', '慌忙', '纷纷',
  '陆续', '不断', '不停', '不住', '说道', '问道', '笑道', '喝道', '答道', '叫道', '喊道',
  '叹道', '骂道', '怒道', '低声', '大声', '沉声', '厉声', '看着', '望着', '盯着', '想着',
  '说着', '转身', '抬头', '低头', '摇头', '点头', '开口', '皱眉', '蹙眉', '眨眼', '瞪眼',
  '出手', '出现', '消失', '开始', '继续', '已经', '正在', '正要', '想要', '感到', '感觉',
  '知道', '觉得', '似乎', '仿佛', '越发', '正是', '足以', '几乎', '也许', '看来', '想起',
  '看到', '听到', '闻到', '走出', '走进', '冲出', '飞出', '射出', '跳出', '站起', '坐下',
  '起身', '上前', '近前', '回应', '喃喃', '冷哼', '嘿嘿', '大笑',
]);

/** n-gram 候选的结构性排除：以言说动词字结尾（「沈觉道」）或叙述词尾巴（「沈觉突然」）。
 *  「X圣地/X禁地」后缀豁免——那是分类规则要的势力形态。 */
function hasBadTail(name) {
  if (SPEAK_VERB_CHARS.has(name[name.length - 1])) return true;
  if (RE_SUFFIX_SECT2.test(name)) return false; // 凛霄圣地/荒古禁地：真专名形态，豁免
  if (name.length >= 4 && BAD_TAIL_WORDS.has(name.slice(-2))) return true;
  return false;
}

// ---------- 类别判定 ----------
// 优先级：人工指定 > 书名号 → skill；对话提示语/称号 → person；模式信号 → 其类别；
// 其余按后缀规则；person 兜底。
// 「圣地/禁地」结尾 → sect（「凛霄圣地」是势力；单独的「圣地」「禁地」已被 STOP_WORDS 排除）。
// 帝兵/法宝（恒宇炉/吞天魔罐/太皇剑/虚空镜/成仙鼎/太初命石……）归 skill（占位符〔功法〕，
// 这是验收②对四类契约的扩展解释：器物类无独立占位符，归入最接近的〔功法〕）。
const RE_SUFFIX_SECT2 = /(?:圣地|禁地)$/;
const RE_SUFFIX_PLACE = /[山城海域州岛渊谷林湖峰星关]$/;
const RE_SUFFIX_SECT1 = /[教派门宗族盟会殿阁宫楼家朝庄]$/;
const RE_SUFFIX_SKILL = /[经诀术法功印阵典卷篇书秘]$/;
const RE_SUFFIX_ARTIFACT = /[炉罐盖铃镜鼎壶钟塔幡弓珠环杖扇剑刀枪戟锤斧石]$/;
function classifyName(name, source) {
  if (source === 'book') return 'skill';
  if (source === 'dialog' || source === 'title') return 'person';
  if (source === 'sectpat') return 'sect';
  if (source === 'skillpat') return 'skill';
  if (RE_SUFFIX_SECT2.test(name)) return 'sect';
  if (RE_SUFFIX_PLACE.test(name)) return 'place';
  if (RE_SUFFIX_SECT1.test(name)) return 'sect';
  if (RE_SUFFIX_SKILL.test(name)) return 'skill';
  if (RE_SUFFIX_ARTIFACT.test(name)) return 'skill';
  return 'person';
}

// ---------- n-gram 频率统计 ----------
// 2-gram 分段压缩：局部窗口内计数 < keepLocal 的直接丢弃。数学保证不漏：
// 若全局计数 ≥ minNgramCount(30) 且窗口数 w 满足 (keepLocal)×w < 30，
// 则必有某窗口计数 ≥ keepLocal → 进入全局表。实测语料（白石 10.5M 字 → 6 窗口、晚棠未开 2.4M → 2 窗口）满足。
// 计数值为下近似（每窗口至多少记 keepLocal-1 次），只影响排序不影响正确性。
function count2grams(texts, { window = 2_000_000, keepLocal = 3 } = {}) {
  const global = new Map();
  let local = new Map();
  let inWindow = 0;
  let windows = 0;
  const flush = () => {
    for (const [k, v] of local) if (v >= keepLocal) global.set(k, (global.get(k) || 0) + v);
    local = new Map();
    inWindow = 0;
    windows++;
  };
  for (const t of texts) {
    for (let i = 0; i + 1 < t.length; i++) {
      const a = t.charCodeAt(i), b = t.charCodeAt(i + 1);
      if (a < 0x4e00 || a > 0x9fff || b < 0x4e00 || b > 0x9fff) continue;
      const key = t[i] + t[i + 1];
      local.set(key, (local.get(key) || 0) + 1);
      if (++inWindow >= window) flush();
    }
  }
  if (inWindow) flush();
  if (windows * keepLocal >= 30) {
    // 保守提示：本窗口参数下可能有全局 ≥30 的词未进表（当前语料规模不会触发）
    console.warn(`[mask] 2-gram 窗口数 ${windows} × keepLocal ${keepLocal} ≥ 30，存在漏计风险`);
  }
  return global;
}

/** 3-gram：只统计前 2 字命中 prefix2 的位置（二次扫描，避免全量 3-gram 的内存开销）。 */
function count3grams(texts, prefix2) {
  const m = new Map();
  for (const t of texts) {
    for (let i = 0; i + 2 < t.length; i++) {
      const a = t.charCodeAt(i), b = t.charCodeAt(i + 1), c = t.charCodeAt(i + 2);
      if (a < 0x4e00 || a > 0x9fff || b < 0x4e00 || b > 0x9fff || c < 0x4e00 || c > 0x9fff) continue;
      const head = t[i] + t[i + 1];
      if (!prefix2.has(head)) continue;
      const key = head + t[i + 2];
      m.set(key, (m.get(key) || 0) + 1);
    }
  }
  return m;
}

/** 4-gram：先查前 2 字命中 prefix2，再查前 3 字命中 prefix3。 */
function count4grams(texts, prefix2, prefix3) {
  const m = new Map();
  for (const t of texts) {
    for (let i = 0; i + 3 < t.length; i++) {
      const a = t.charCodeAt(i), b = t.charCodeAt(i + 1);
      if (a < 0x4e00 || a > 0x9fff || b < 0x4e00 || b > 0x9fff) continue;
      if (!prefix2.has(t[i] + t[i + 1])) continue;
      const c = t.charCodeAt(i + 2), d = t.charCodeAt(i + 3);
      if (c < 0x4e00 || c > 0x9fff || d < 0x4e00 || d > 0x9fff) continue;
      const head3 = t.slice(i, i + 3);
      if (!prefix3.has(head3)) continue;
      const key = head3 + t[i + 3];
      m.set(key, (m.get(key) || 0) + 1);
    }
  }
  return m;
}

function pickCandidates(gramMap, minCount, stop = STOP_WORDS) {
  const out = [];
  for (const [name, count] of gramMap) {
    if (count < minCount) continue;
    if (isExcludedName(name, stop) || hasBadTail(name)) continue;
    out.push([name, count]);
  }
  return out;
}

// ---------- 对话提示语人名（最可靠信号） ----------
function dialogCandidateOK(raw, stop = STOP_WORDS) {
  if (!raw || !isAllHan(raw)) return false;
  if (PRONOUN_HEADS.has(raw[0])) return false;
  if (stop.has(raw) || APPELLATION_SET.has(raw)) return false;
  if (hasForbiddenSub(raw) || hasNumQuant(raw)) return false;
  for (const w of APPELLATIONS) if (w.length >= 2 && raw.includes(w)) return false;
  for (const w of BAD_DIALOG_SUBS) if (raw.includes(w)) return false;
  if (hasBadChar(raw)) return false;
  for (const ch of raw) if (SPEAK_VERB_CHARS.has(ch)) return false;
  // 数字字只查首尾（同 isExcludedName：允许「许十安」，拒绝「三兄弟」「沈觉三」）
  if (DIGIT_CHARS.has(raw[0]) || DIGIT_CHARS.has(raw[raw.length - 1])) return false;
  return true;
}

function extractDialogNames(texts, minCount, stop = STOP_WORDS) {
  const counts = new Map();
  const bump = (raw) => { if (dialogCandidateOK(raw, stop)) counts.set(raw, (counts.get(raw) || 0) + 1); };
  for (const t of texts) {
    for (const m of t.matchAll(RE_DIALOG_AFTER)) bump(m[1]);
    for (const m of t.matchAll(RE_DIALOG_BEFORE)) bump(m[1]);
  }
  const out = [];
  for (const [name, count] of counts) if (count >= minCount) out.push({ name, count });
  return out;
}

// ---------- 书名号（功法/经书名高发） ----------
function extractBookNames(texts, minCount, stop = STOP_WORDS) {
  const counts = new Map();
  for (const t of texts) {
    for (const m of t.matchAll(RE_BOOK_TITLE)) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  const out = [];
  for (const [name, count] of counts) {
    if (count < minCount) continue;
    if (isExcludedName(name, stop) || hasBadTail(name)) continue;
    out.push({ name, count });
  }
  return out;
}

// ---------- 信号 d：称号 / 势力 / 功法后缀模式（验收②新增，2026-09-12） ----------
// 为什么需要独立信号：长专名（≥5 字，如「九龙圣铜印」「先天太虚罡气」）超出 n-gram 统计窗口；
// 低频专名（count < 30，如「万初圣地」「天鳞族」）达不到 n-gram 门槛；而后缀模式本身
// 是「这是专名」的强证据，故单独扫描、低阈值收录（minPatternCount 默认 5）。
const TITLE_SUFFIXES = [
  '大帝', '天尊', '神王', '圣皇', '圣尊', '圣主', '圣使', '道人', '老道', '老祖', '姥姥', '圣子', '圣女',
  '皇叔', '明王', '神女', '仙子', '天帝', '天女', '大圣', '天君', '道君', '神君', '圣君',
  '妖王', '魔王', '神皇', '圣王', '人皇', '老祖宗', '古王',
];
const SECT_SUFFIXES = [
  '圣地', '禁地', '王朝', '世家', '山庄', '皇朝', '古教', '神教', '圣教', '大教',
  '教', '派', '门', '宗', '族', '府', '殿', '阁', '会', '帮', '盟', '楼', '宫',
  // 注：不含单字「道」——「沈觉道：“」的「道」是言说动词，会把「主角名+道」误收为势力名；
  // 真正的「XX道」势力（人欲道）走 include 强制入典
];
const SKILL_SUFFIXES = [
  '宝典', '真经', '古经', '天经', '道经', '秘术', '神术', '大法', '罡气', '真解', '真诀',
  '宝术', '天书', '心经', '诀', '秘', '术', '法', '经', '书', '篇', '典',
];
const altOf = (list) => [...new Set(list)].sort((a, b) => b.length - a.length).join('|');

/** 模式词根检查：必须全汉字、不得含功能/碎片字、不得以代词开头、不得是限定词。
 *  数字字只拒「纯数字词根」（「十大禁地」），数字开头的名字字保留（「万初圣地」的「万」）。
 *  不做 STOP 检查——「玄穹大帝」「阴阳教」的词根在题材词表里但整体是真专名（实测教训）。 */
function patternRootOK(root, kind) {
  if (!root || root.length < 2 || !isAllHan(root)) return false;
  if (PRONOUN_HEADS.has(root[0]) || QUANT_ROOTS.has(root)) return false;
  if (hasBadChar(root) || hasForbiddenSub(root) || hasNumQuant(root)) return false;
  if ([...root].every((ch) => DIGIT_CHARS.has(ch))) return false;
  if (kind === 'title' && (APPELLATION_SET.has(root) || TITLE_ROOT_STOP.has(root))) return false;
  return true;
}

// 限定词词根（模式专用）：数量/指示词 + 后缀的跨词组合不是专名
// （「一些大教」「一部古经」「各大圣地」「任何办法」）。
const QUANT_ROOTS = new Set([
  '一些', '一部', '一大', '一群', '一位', '一名', '一个个', '各大', '任何', '所有', '许多',
  '不少', '大量', '无数', '全部', '整个', '那些', '这些', '几个', '两个', '三人', '众人',
]);

// 动词性首字（模式词根专用）：处理「动词+专名」粘连——「修成兵字诀」这条链上
// 「修」「成」都是动词字，清洗规则逐级丢长词，最终保留「兵字诀」。
// 已剔除名字常用字（云曦青白黑金紫石龙雷风雨雪玉文武华建国军民志强伟勇明啸晓…）。
const VERB_HEADS = new Set(
  ('修炼学得悟参习掌握持施展催动祭运转化变凝聚融吞吸斩杀打击攻守护救逃追赶劈刺挥舞扔抛射喷吐' +
   '吼怒狂笑哭叫喊喝问答说道听看望见闻碰撞踢踩踏跃跳翻滚爬走跑站坐躺卧醒睡起立停止进退躲藏寻找' +
   '搜扶拉推扯拽拖抬举扛背抱搂牵捧端拿提搬移放置挂贴使用唤召出成到想知认做好给找吃喝收换丢捡敲' +
   '砸割砍削剪补洗擦扫挪撕绕绑捆锁关闭弹压按拍抽拔插挖埋填堵塞破断灭毁受遇逢忍拼斗争抢夺偷骗骂' +
   '夸赞批吵嚷吟诵读写算询答话聊叙谈述论议评讲告懂记忘念虑思考谋划较衡量').split('')
);

// 弱后缀：日常词也常用（厨房门/肯定会/想办法/一本书），其 ≤4 字组合必须被 n-gram 信号
// 命中才收（且 n-gram 的链式稀缺会因词根被 STOP 拒而自然断链，例如「厨房」在题材词表
// 里 →「厨房门」的 3-gram 无计数 → 挡）。强后缀（圣地/大帝/道人/教/宝典/罡气…）专名性
// 极强、日常几乎不产出 3+ 字组合，自由收录（「阴阳教」「万初圣地」的词根被 STOP/DIGIT 拒，
// 走不通 n-gram 链，只能靠模式信号）。
const WEAK_SUFFIXES = new Set([
  '门', '会', '楼', '宫', '殿', '阁', '府', '族', '帮', '盟', '派', '宗',
  '法', '术', '书', '经', '秘', '典', '篇', '诀',
]);
// 跨词组合防御（sect 专用）：词根不得以另一个势力后缀字结尾——
// 「万初圣地会盟」会让后缀「会」的位置产出「初圣地会」（word1 后缀 + word2 后缀 拼接）。
const ROOT_TAIL_SECTISH = /[地门族教派宗会盟楼宫殿阁府]$/;

/** 强后缀：不在弱后缀表里的都算强（双字后缀「圣地」「大帝」「宝典」等专名性极强；
 *  单字里只有「教」按强处理——3+ 字的日常「X教」词罕见（天主教/基督教都是专名）。） */
const isStrongSuffix = (suffix) => !WEAK_SUFFIXES.has(suffix);

// 「教」的右边界防御：右邻字是「教育/教导/教学/教训/教师/教室…」的后续字，或代词/名词
// （「教他」「教人」——「教」是动词）时，「教」是词内字不是后缀。
const TEACH_RIGHT = new Set('育导学训师室堂授材案鞭务练程他她你我人子生们它');

/** 弱后缀右边界防御（sect/skill 通用）：后缀右邻字若把整个组合拉回日常词，则拒。 */
function badRightBoundary(suffix, rightChar) {
  if (!rightChar) return false;
  if (suffix === '教') return TEACH_RIGHT.has(rightChar);
  return false;
}

/**
 * 后缀模式提取：称号（person）/ 势力（sect）/ 功法（skill）。
 * 不用「词根+后缀」整体正则做非重叠匹配——贪婪会吃掉相邻专名（「与玄穹大帝」的匹配
 * 让「玄穹大帝」失去独立匹配机会）且动词粘连（「修成兵字诀」）。改为：只扫后缀出现位置，
 * 每个位置把 [minRoot, maxRoot] 全部合法词根都计为候选，再做两步清洗：
 *   ①动词首字清洗（丢长）：X 首字是动词字且 X.slice(1) 也在候选名单 → 丢 X
 *     （「修成兵字诀」→「成兵字诀」→ 二者皆丢，保留「兵字诀」）；
 *   ②后缀吞没清洗（丢短）：X 是 Y 的后缀且 count(Y) ≥ 0.8×count(X) → 丢 X
 *     （切链「再生术」「劫再生术」被「凰劫再生术」吞）。
 *
 * 收录门槛（验收②第二轮收紧，教训：「会」「门」「法」是宽后缀，词根+后缀的自由组合
 * 会产「肯定会」「厨房门」「想办法」这类垃圾；模式信号只负责它的独有价值）：
 *   - 长度 ≥5 字：超出 n-gram 的 4 字窗口，只能靠模式收（如「先天太虚罡气」「九龙圣铜印」）；
 *   - 强后缀（专名性极强）：自由收（「阴阳教」「万初圣地」）；
 *   - 弱后缀：≤4 字必须同时被 n-gram 信号命中（ngramSet）——统计门槛兜住宽后缀噪声。
 *
 * @param {Set<string>} ngramSet 已通过频率+lift 门槛的 n-gram 候选名集合
 */
function extractPatternNames(texts, minCount, ngramSet, stop = STOP_WORDS) {
  const out = [];
  const kinds = [
    { type: 'person', source: 'title', kind: 'title', suffixes: TITLE_SUFFIXES, minRoot: 2, maxRoot: 3 },
    { type: 'sect', source: 'sectpat', kind: 'sect', suffixes: SECT_SUFFIXES, minRoot: 2, maxRoot: 3 },
    { type: 'skill', source: 'skillpat', kind: 'skill', suffixes: SKILL_SUFFIXES, minRoot: 2, maxRoot: 4 },
  ];
  for (const k of kinds) {
    const re = new RegExp(`(?:${altOf(k.suffixes)})`, 'g');
    const counts = new Map();
    for (const t of texts) {
      for (const m of t.matchAll(re)) {
        const idx = m.index;
        for (let L = k.minRoot; L <= k.maxRoot; L++) {
          if (idx - L < 0) continue;
          const root = t.slice(idx - L, idx);
          if (!patternRootOK(root, k.kind)) continue;
          if (k.kind === 'sect' && ROOT_TAIL_SECTISH.test(root)) continue;
          const whole = root + m[0];
          if (stop.has(whole) || APPELLATION_SET.has(whole)) continue;
          if (hasForbiddenSub(whole) || hasNumQuant(whole)) continue;
          if (DIGIT_CHARS.has(whole[whole.length - 1])) continue;
          if (badRightBoundary(m[0], t[idx + m[0].length])) continue;
          if (whole.length < 5 && !isStrongSuffix(m[0]) && !(ngramSet && ngramSet.has(whole))) continue;
          counts.set(whole, (counts.get(whole) || 0) + 1);
        }
      }
    }
    const list = [...counts.entries()].filter(([, c]) => c >= minCount);
    const nameSet = new Set(list.map(([n]) => n));
    // ① 动词首字清洗（用清洗前名单判定 slice(1) 存在性）
    const afterVerb = list.filter(([n]) => {
      if (VERB_HEADS.has(n[0]) && nameSet.has(n.slice(1))) return false;
      // 「脚踩行字诀」：前 2 字含动词字且去掉前 2 字是完整候选（≥5 字才有此形态）
      if (n.length >= 5 && (VERB_HEADS.has(n[0]) || VERB_HEADS.has(n[1])) && nameSet.has(n.slice(2))) return false;
      return true;
    });
    // ② 后缀吞没清洗
    const droppedSlice = new Set();
    for (const [x, xc] of afterVerb) {
      for (const [y, yc] of afterVerb) {
        if (y.length > x.length && y.endsWith(x) && yc >= xc * 0.8) { droppedSlice.add(x); break; }
      }
    }
    for (const [name, count] of afterVerb) {
      if (!droppedSlice.has(name)) out.push({ name, count, type: k.type, source: k.source });
    }
    // 词根提取（验收③第三轮，title 专用）：「凛霄圣主」这类型号在原文里常以词根「凛霄」
    // 单独指代（实测「凛霄圣主」105 次 + 大量独立「凛霄」漏掩）。词根须通过同样的词根
    // 过滤，且自身有频次证据（ngramSet 命中 = 独立出现 ≥ minNgramCount），避免「可怕」类噪声。
    if (k.kind === 'title') {
      const rootSeen = new Set();
      for (const [name] of afterVerb) {
        for (const suf of TITLE_SUFFIXES) {
          if (!name.endsWith(suf)) continue;
          const root = name.slice(0, -suf.length);
          if (root.length < 2 || rootSeen.has(root)) continue;
          if (!patternRootOK(root, 'title')) continue;
          if (stop.has(root) || APPELLATION_SET.has(root)) continue;
          if (!(ngramSet && ngramSet.has(root))) continue;
          rootSeen.add(root);
          out.push({ name: root, count: 0, type: 'person', source: 'rootpat' });
        }
      }
    }
  }
  return out;
}

// ---------- 掩码核心 ----------
/** 词条排序：长度降序（最长优先），等长按 name 升序——maskText 与 maskTextByRanges 共用，
 *  保证两种实现对等长部分重叠（如 ABC 中 AB/BC）的取舍一致。 */
const byLenDescNameAsc = (a, b) =>
  (b.name.length - a.name.length) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function dictEntries(dict) {
  const list = Array.isArray(dict) ? dict : (dict && dict.entries) || [];
  return list.filter((e) => e && e.name && isAllHan(e.name));
}

/** 词条守卫（构建装配期，2026-09-12 核查补）：返回剔除原因，null=通过。
 *  ① 与占位符同形（「人名」「地名」…）：maskText 在累计结果上 split/join，会把已产出的
 *     〔人名〕再掩成〔〔人名〕〕，而 maskTextByRanges 只在原文上匹配 → 两实现分叉，
 *     且 verifySegments 会把 maskText 的产物判失败（潜伏缺陷，现网词典不含此类词条）。
 *  ② 含〔〕：原文自带占位符字样会被二次掩码成〔〔…〕〕。
 *  ③ 非纯汉字：掩码时被 dictEntries 静默丢弃（含外文/数字的专名整词漏掩且无告警）。
 *  一律在装配处剔除并记入 meta.droppedEntries，不静默。 */
function entryGuardReason(name) {
  const s = String(name == null ? '' : name);
  if (!s) return 'empty';
  if (/[\u3014\u3015]/.test(s)) return 'placeholder_bracket';
  if (Object.values(PLACEHOLDERS).some((p) => p.includes(s))) return 'placeholder_like';
  if (!isAllHan(s)) return 'not_han';
  return null;
}

/** 契约实现：逐名 split/join，词条最长优先。 */
function maskText(text, dict) {
  const src = String(text == null ? '' : text);
  const ordered = [...dictEntries(dict)].sort(byLenDescNameAsc);
  let r = src;
  for (const e of ordered) {
    if (r.includes(e.name)) r = r.split(e.name).join(placeholderFor(e.type));
  }
  return r;
}

/** 区间式实现：找所有命中区间、重叠时贪心取最长，再重建字符串。
 *  与 maskText 逐字节一致（同一排序契约 + 最长优先消重叠）。 */
function maskTextByRanges(text, dict) {
  const src = String(text == null ? '' : text);
  const ordered = [...dictEntries(dict)].sort(byLenDescNameAsc);
  const all = [];
  for (const e of ordered) {
    const nm = e.name;
    let idx = src.indexOf(nm);
    while (idx !== -1) {
      all.push({ start: idx, end: idx + nm.length, name: nm, type: e.type });
      idx = src.indexOf(nm, idx + nm.length);
    }
  }
  // 贪心最长优先消重叠：长度降序、等长按 name 升序（与词条排序 maskText 的替换顺序一致——
  // 否则等长词条部分重叠时（如「许多人的」中的「许多」/「多人」）两实现会做出不同取舍）
  all.sort((a, b) =>
    ((b.end - b.start) - (a.end - a.start)) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    (a.start - b.start));
  const occ = new Uint8Array(src.length);
  const kept = [];
  for (const r of all) {
    let free = true;
    for (let i = r.start; i < r.end; i++) { if (occ[i]) { free = false; break; } }
    if (!free) continue;
    for (let i = r.start; i < r.end; i++) occ[i] = 1;
    kept.push(r);
  }
  kept.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of kept) {
    out += src.slice(pos, r.start) + placeholderFor(r.type);
    pos = r.end;
  }
  out += src.slice(pos);
  return { masked: out, ranges: kept };
}

/** 在 text 上按 dict 掩码后被掩的字符数（词条纯汉字 → 区间长度即汉字数）。 */
function maskCoverage(text, entriesLike) {
  const { ranges } = maskTextByRanges(text, { entries: entriesLike });
  let n = 0;
  for (const r of ranges) n += r.end - r.start;
  return n;
}

/** 词典统计：maskRatio 口径 = 被掩专名汉字数 / 原文汉字数（与实测 2.13% 同口径）。 */
function dictStats(dict, text) {
  const src = String(text == null ? '' : text);
  const entries = dictEntries(dict);
  const { masked, ranges } = maskTextByRanges(src, { entries });
  let maskedChars = 0;
  for (const r of ranges) maskedChars += han(src.slice(r.start, r.end));
  const totalHan = han(src);
  return {
    entries: entries.length,
    distinctNames: new Set(entries.map((e) => e.name)).size,
    maskedChars,
    maskRatio: totalHan ? maskedChars / totalHan : 0,
    expansion: src.length ? masked.length / src.length : 1,
  };
}

// ---------- 验收①逐段差分 ----------
// 简单 LCG（Numerical Recipes 常数，乘积 < 2^53 无精度丢失），固定种子保证可复现。
function lcgSampleIndices(popSize, k) {
  if (k >= popSize) return Array.from({ length: popSize }, (_, i) => i);
  let seed = 20260912;
  const chosen = new Set();
  while (chosen.size < k) {
    seed = (seed * 1664525 + 1013904223) % 2147483648;
    chosen.add(Math.floor((seed / 2147483648) * popSize));
  }
  return [...chosen].sort((a, b) => a - b);
}

const clipSeg = (s, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * 验收①：掩码后文本可由原文仅通过专名区间替换精确构造（其余字符逐字节相同）。
 * before/after 各自按 \r?\n 切段（段落数必须相等），随机抽 sampleSize 段（LCG 可复现），
 * 对每段用 maskTextByRanges 重放并断言与 after 对应段全等。
 */
function verifySegments(beforeText, afterText, dict, sampleSize = 100) {
  const before = paragraphsOf(beforeText);
  const after = paragraphsOf(afterText);
  if (before.length !== after.length) {
    return {
      segmentsCompared: 0,
      segmentsPassed: 0,
      failures: [{ reason: '段落数不等', beforeSegs: before.length, afterSegs: after.length }],
    };
  }
  const nonEmpty = [];
  for (let i = 0; i < before.length; i++) if (before[i].trim()) nonEmpty.push(i);
  const picks = lcgSampleIndices(nonEmpty.length, Math.min(sampleSize, nonEmpty.length));
  let passed = 0;
  const failures = [];
  for (const p of picks) {
    const i = nonEmpty[p];
    const replay = maskTextByRanges(before[i], dict).masked;
    if (replay === after[i]) passed++;
    else if (failures.length < 10) {
      failures.push({ segment: i, before: clipSeg(before[i]), expected: clipSeg(replay), actual: clipSeg(after[i]) });
    }
  }
  return { segmentsCompared: picks.length, segmentsPassed: passed, failures };
}

// ---------- 词典持久化 ----------
const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** 词典路径（相对仓库根）。 */
function maskDictPath(author) { return `data/corpus/dict/${author}/mask-dict.json`; }

// JSON 往返 Infinity 会变 null（opts.measureLimit 默认全量 = Infinity），用哨兵字符串保真
const JSON_INF = '__Infinity__';
function saveDict(author, dict, baseDir = REPO_ROOT) {
  const p = path.join(baseDir, maskDictPath(author));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(dict, (k, v) => (v === Infinity ? JSON_INF : v), 2) + '\n',
    'utf8'
  );
  return p;
}

function loadDict(author, baseDir = REPO_ROOT) {
  return JSON.parse(
    fs.readFileSync(path.join(baseDir, maskDictPath(author)), 'utf8'),
    (k, v) => (v === JSON_INF ? Infinity : v)
  );
}

// ---------- 人工确证清单（include） ----------
// 作者词表统一入口 loadWordlists（见下）：include / confirmedTwoChar / confirmed3Plus /
// stopWords 四通道同出一个 JSON。历史路径 loadInclude（data/corpus/dict/include-<author>.json）
// 保留为兜底：loadWordlists 未命中时仍可用（兼容未迁移的作者）。

/** 合并 include 清单（作者词表 / 调用方参数 / 兼容旧路径的外部文件），同名词条以靠后者为准。 */
function mergeInclude(...lists) {
  const m = new Map();
  for (const list of lists) {
    for (const e of list || []) {
      if (!e || !e.name) continue;
      const prev = m.get(e.name);
      m.set(e.name, { name: e.name, type: e.type || (prev && prev.type) || 'person' });
    }
  }
  return [...m.values()];
}

/** 解析两种 include 形态为 [{name,type}]：{ "person": ["刘云志", …] } 或 [{ name, type }]。 */
function parseTypedNames(raw) {
  const out = [];
  if (Array.isArray(raw)) {
    for (const e of raw) if (e && e.name) out.push({ name: e.name, type: e.type || 'person' });
  } else if (raw && typeof raw === 'object') {
    for (const [type, names] of Object.entries(raw)) {
      if (!Array.isArray(names)) continue;
      for (const n of names) if (typeof n === 'string') out.push({ name: n, type });
    }
  }
  return out;
}

/** 外部补录文件（验收③，历史路径）：data/corpus/dict/include-<author>.json（首选）或
 *  data/corpus/dict/<author>/include.json（备用，与词典同目录）。
 *  文件不存在返回 []。新作者请改用 tools/distill/wordlists/<author>.json（loadWordlists）。 */
function loadInclude(author, baseDir = REPO_ROOT) {
  const cands = [
    path.join(baseDir, `data/corpus/dict/include-${author}.json`),
    path.join(baseDir, `data/corpus/dict/${author}/include.json`),
  ];
  for (const f of cands) {
    if (!fs.existsSync(f)) continue;
    return parseTypedNames(JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  return [];
}

/** 作者词表（唯一作者数据入口，随仓库版本管理）：tools/distill/wordlists/<author>.json
 *  形态：{ include: {person:[…],…} | [{name,type}], confirmedTwoChar:[…], confirmed3Plus:[…], stopWords:[…],
 *          modelAdjudicated: {person:[…],…}（机器裁决的专名，可选）,
 *          adjudicatedJunk: [ … ]（机器裁决的通用词/碎片，可选）, maxRatio: 0.08（可选） }
 *  返回 { include, humanInclude, machineInclude, confirmedTwoChar, confirmed3Plus, stopWords, maxRatio, source }；
 *  文件不存在 → { include: null, source: null }，调用方可回落到 loadInclude（历史路径）。
 *  为什么外置：内嵌在代码里会被无条件套用到任何作者（跨作者污染，2026-09-12 核查实测），
 *  且这些词表是人工核对产物、CLI 不可再生——必须可 review、可版本管理、丢不了。
 *  maxRatio 与词条同放数据文件：掩码强度是「每作者决策」，写在这里才可 diff、可追溯
 *  （代码里的 0.045 只是未声明时的事实默认，不是权威口径）。
 *  include 与 modelAdjudicated 分开存放、合并时人工优先：机器裁决（2026-09-13 全池逐条判定）
 *  是可复现但可能出错的产物，出问题时必须能一眼看出哪些词来自机器、并单独重跑它。 */
function loadWordlists(author, baseDir = REPO_ROOT) {
  const f = path.join(baseDir, 'tools/distill/wordlists', `${author}.json`);
  if (!fs.existsSync(f)) {
    return {
      include: null, humanInclude: [], machineInclude: [],
      confirmedTwoChar: [], confirmed3Plus: [], stopWords: [], maxRatio: null, source: null,
    };
  }
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const humanInclude = parseTypedNames(raw.include);
  const machineInclude = parseTypedNames(raw.modelAdjudicated);
  return {
    // 人工 include 优先（同名以人工类型为准）——mergeInclude 靠后者覆盖
    include: mergeInclude(machineInclude, humanInclude),
    humanInclude,
    machineInclude,
    confirmedTwoChar: strs(raw.confirmedTwoChar),
    confirmed3Plus: strs(raw.confirmed3Plus),
    // 机器裁决的通用词/碎片并入停用词层：它们不仅自己不掩，还会压掉同前缀的更长候选
    // （前缀耦合，有意保留）——这正是「碎片不再从重建里回来」所需要的
    stopWords: strs(raw.stopWords).concat(strs(raw.adjudicatedJunk)),
    maxRatio: (typeof raw.maxRatio === 'number' && raw.maxRatio > 0) ? raw.maxRatio : null,
    source: f,
  };
}

// ---------- 词典构建 ----------
/**
 * 多信号合成构建专名词典。
 *
 * @param {string[]} targetTexts  目标作者全部文本（内部会剔除章标题行）
 * @param {string[]} contrastTexts 对照作者全部文本（可为空数组：无对照时 lift 失效，仅按频率+排除表收）
 * @param {object} [opts]
 *   minDialogCount=10   对话提示语信号最低出现次数
 *   bookMinCount=10     书名号信号最低出现次数
 *   minNgramCount=30    n-gram 候选最低出现次数
 *   lift=3              对照 lift 阈值（目标每万字频率 ÷ 对照每万字频率）
 *   minPatternCount=5   称号/势力/功法后缀模式信号最低出现次数
 *   targetRatio=0.02    规模控制参考下限（不足不强收，仅记录）
 *   maxRatio=0.045      规模控制上限（验收②放宽：容纳称号与功法类扩展解释）
 *                       每作者可覆盖（词表 JSON 的 maxRatio 字段 / CLI --max-ratio）——
 *                       2026-09-13 委托方裁决：白石/青崖的真专名规模本身超过 4.5%，
 *                       n-gram 通道被整层挤空 → 统一抬到 8%（见 09 报告口径 A）。
 *   measureLimit=Infinity 规模控制实测的每文件抽样字符数（默认全量——开篇抽样会
 *                         系统性低估中后段人名密度，实测 3% 抽样 → 全量 4.7%）
 *   include=[{name,type}] 人工确证强制入典（绕过全部过滤与预算；来自作者词表 loadWordlists）
 *   confirmedTwoChar=[] 2 字候选的证据白名单（作者词表；空 → 仅靠对话/后缀/子串证据）
 *   confirmed3Plus=[]   3+ 字候选的证据白名单（同上）
 *   stopWords=[]        作者专属停用词（人工核对批次；与通用词层 STOP_WORDS 取并集）
 *   excludeNames=[]     强制不掩清单（与常用词同形的组织名/现实宗教地理名等）
 * @returns {{version:string, entries:{name:string,type:string,count:number}[], meta:object}}
 */
function buildDict(targetTexts, contrastTexts, opts = {}) {
  const defaults = {
    minDialogCount: 10,
    bookMinCount: 10,
    minNgramCount: 30,
    minPatternCount: 5,
    lift: 3,
    targetRatio: 0.02,
    maxRatio: 0.045,
    measureLimit: Infinity,
    include: null, // 作者词表 include；null/[] → 无人工确证词条（不再内置任何作者的专名）
    confirmedTwoChar: [],
    confirmed3Plus: [],
    stopWords: [],
    excludeNames: [],
  };
  // 显式 undefined 视为「未提供」：CLI 在「词表与命令行都没声明上限」时会传 maxRatio: undefined，
  // 若直接 spread 就会把默认值覆盖成 undefined（budget = NaN，静默产出空/异常词典）。
  const provided = {};
  for (const [k, v] of Object.entries(opts || {})) if (v !== undefined) provided[k] = v;
  const o = { ...defaults, ...provided };
  const includeList = mergeInclude(o.include);
  // 通用词层（功能/题材词，全作者共用）× 作者专属停用词（数据文件；默认空）
  const STOP = (o.stopWords && o.stopWords.length)
    ? new Set([...STOP_WORDS, ...o.stopWords])
    : STOP_WORDS;
  const CONFIRMED_TWO = new Set(o.confirmedTwoChar || []);
  const CONFIRMED_3PLUS_SET = new Set(o.confirmed3Plus || []);
  const EXCLUDED = new Set(o.excludeNames || []);
  // 不掩清单的「保护半径」（实测教训 v4：拦下「须弥山」后，它的 2 字碎片「须弥」「弥山」
  // 仍从 ngram 进来，掩码时把「须弥山」切成两半掩掉——保护必须同时覆盖超串与子串：
  //   候选 === 不掩词（本身）、候选 ⊃ 不掩词（须弥山巅）、候选 ⊂ 不掩词（须弥/弥山）。
  const isProtected = (name) => {
    for (const ex of EXCLUDED) {
      if (name === ex) return true;
      if (name.includes(ex)) return true;
      if (ex.includes(name)) return true;
    }
    return false;
  };
  const texts = (targetTexts || []).map((t) => stripChapterTitles(String(t)));
  const ctr = (contrastTexts || []).map((t) => stripChapterTitles(String(t)));
  const tHan = texts.reduce((s, t) => s + han(t), 0);
  const cHan = ctr.reduce((s, t) => s + han(t), 0);

  // —— 信号 b：高频 n-gram + 对照 lift ——
  const g2 = count2grams(texts);
  const cand2 = pickCandidates(g2, o.minNgramCount, STOP);
  // 前缀闸门用「过滤后的 2/3 字候选集」：这条耦合是有意的（2026-09-12 复核实测），
  // 效果 = 停用词里的词不仅自己不掩，还压掉同前缀的更长候选。它是 9 批验收③停用词
  // 累积生效的基础——放开后（改用不过滤的前缀集重算）白石一次性涌入 28 条组合碎片
  // （金色血/施展秘/许多古族/天神书），因为 金色/许多 等被停用的 2 字词重新成为生成前缀。
  // 代价：真专名若以被停用词为前缀会被连带压掉（实测 孔雀→孔雀王；该例中「孔雀王」是
  // 太古神鸟，压掉恰是想要的）。补救手段是显式的：把真专名写进 include（绕过全部剪枝）。
  const cand2set = new Set(cand2.map(([n]) => n));
  const g3 = count3grams(texts, cand2set);
  const cand3 = pickCandidates(g3, o.minNgramCount, STOP);
  const cand3set = new Set(cand3.map(([n]) => n));
  const g4 = count4grams(texts, cand2set, cand3set);
  const cand4 = pickCandidates(g4, o.minNgramCount, STOP);

  // 对照侧计数（复用同一候选前缀集，省一次全量统计；与目标侧同一口径 → lift 两侧对称）
  const g2c = count2grams(ctr);
  const g3c = count3grams(ctr, cand2set);
  const g4c = count4grams(ctr, cand2set, cand3set);
  const gramCountC = (name) =>
    (name.length === 2 ? g2c : name.length === 3 ? g3c : g4c).get(name) || 0;
  // lift 口径：目标每万字频率 ÷ 对照每万字频率；对照计数为 0（压缩窗口下=几乎不出现）直接收。
  // 注：对照计数是窗口压缩下近似（真实 1~2 次的词查表得 0），只影响边缘词条，量级可忽略。
  const liftPass = (name, count) => {
    if (!cHan) return true;
    const cc = gramCountC(name);
    if (cc === 0) return true;
    return (count / tHan) / (cc / cHan) >= o.lift;
  };

  // —— 信号 a（对话提示语）、c（书名号）、d（后缀模式）——
  // 模式提取需要 n-gram 候选集合：≤4 字的模式候选必须也被 n-gram 信号命中（统计门槛兜噪声）
  const ngramNameSet = new Set();
  for (const [name, count] of [...cand2, ...cand3, ...cand4]) {
    if (!ngramNameSet.has(name) && liftPass(name, count)) ngramNameSet.add(name);
  }
  const dialogs = extractDialogNames(texts, o.minDialogCount, STOP);
  const books = extractBookNames(texts, o.bookMinCount, STOP);
  const patterns = extractPatternNames(texts, o.minPatternCount, ngramNameSet, STOP);

  // 2 字候选的专名证据集（见作者词表 confirmedTwoChar）：低门槛对话集 + 已证专名的 2 字子串
  const dialogLowSet = new Set(extractDialogNames(texts, 3, STOP).map((x) => x.name));
  const provenSubs = new Set();
  // 证据来源只用「人工确证集合」（2 字白名单/对话/include 词）——不放 pattern 候选
  // （pattern 含宽后缀自由组合「骷髅族」，其子串当证据会把碎片放进来，实测 v12），
  // 也不取白名单长词的**内部**片段（「紫府圣子」的「府圣」会放行碎片，实测 v13）——
  // 长词只作为整体参与「候选包含它」的判定（「仙殿传人」⊃「仙殿」）。
  for (const n of dialogLowSet) provenSubs.add(n);
  for (const n of CONFIRMED_TWO) provenSubs.add(n);
  for (const e of includeList) provenSubs.add(e.name);
  const provenMembers = [...provenSubs].sort((a, b) => b.length - a.length);
  const hasProvenMember = (name) => provenMembers.some((p) => name.includes(p));
  const twoCharEvidence = (name) =>
    CONFIRMED_TWO.has(name) ||
    dialogLowSet.has(name) ||
    EVIDENCE_TAILS.has(name[name.length - 1]) ||
    provenSubs.has(name) ||
    surnameEvidence(name, STOP); // 证据⑤：姓氏起头（中低频配角名的兜底信号）
  // 3+ 字候选的证据：白名单 / 对话位置 / 后缀形态 / 含已证专名的 2 字子串（且首字非虚词动词）
  const SUFFIX_ALT = new RegExp(`(?:${altOf([...TITLE_SUFFIXES, ...SECT_SUFFIXES, ...SKILL_SUFFIXES])})$`);
  const manyCharEvidence = (name) => {
    if (CONFIRMED_3PLUS_SET.has(name)) return true;
    if (dialogLowSet.has(name)) return true;
    if (SUFFIX_ALT.test(name)) return true;
    if (RE_SUFFIX_PLACE.test(name) || RE_SUFFIX_SECT1.test(name) || RE_SUFFIX_SECT2.test(name) ||
        RE_SUFFIX_SKILL.test(name) || RE_SUFFIX_ARTIFACT.test(name)) return true;
    if (EVIDENCE_TAILS.has(name[name.length - 1]) && name.length === 3) return true;
    if (name.length === 3 && surnameEvidence(name, STOP)) return true; // 证据⑤：3 字「姓+双字名」（徐天雄/金赤霄）
    // 含已证专名成分（「仙殿传人」←「仙殿」），但动词/虚词起头的粘连碎片除外（「杀岳苍」「跟岳苍」）
    if (VERB_HEADS.has(name[0]) || CONTEXT_HEADS.has(name[0])) return false;
    return hasProvenMember(name);
  };

  // —— 合并候选池：source 优先级 dialog > book > 模式 > ngram；count 取各信号最大值 ——
  // （不取 max 的后果实测过：沈觉的 dialog 命中只有几百次，而 ngram 计数 ~3.8 万，
  //   排序会把它排到风格词后面，最终词典被垃圾词占满。）
  const pool = new Map(); // name → { count, source, type? }
  const excludedHit = new Set(); // 不掩清单实际拦下的候选（各来源命中并集）
  const putWith = (name, count, source, type) => {
    if (isProtected(name)) { excludedHit.add(name); return; }
    const cur = pool.get(name);
    if (!cur) pool.set(name, { count, source, type });
    else {
      cur.count = Math.max(cur.count, count);
      if (!cur.type && type) cur.type = type;
    }
  };
  for (const { name, count } of dialogs) putWith(name, count, 'dialog', 'person');
  for (const { name, count } of books) putWith(name, count, 'book', 'skill');
  for (const p of patterns) putWith(p.name, p.count, p.source, p.type);
  for (const [name, count] of [...cand2, ...cand3, ...cand4]) {
    // 不掩清单硬拦（实测教训：ngram 直通路径不走 putWith，v2 时「须弥山」因预算释放
    // 被收进词典——excludeNames 必须在**每条**来源路径上拦，含 include）。
    if (isProtected(name)) { excludedHit.add(name); continue; }
    if (pool.has(name)) { pool.get(name).count = Math.max(pool.get(name).count, count); continue; }
    // 2 字证据闸门（只拦「新进池」的 ngram 候选；已在池的对话/模式/include 词不受影响）
    if (name.length === 2 ? !twoCharEvidence(name) : !manyCharEvidence(name)) continue;
    if (!liftPass(name, count)) continue;
    pool.set(name, { count, source: 'ngram' });
  }
  // 人工确证强制入典（最高优先级，绕过全部过滤与预算；但不掩清单优先于它——两者冲突时
  // 以不掩为准，并在 meta 里如实记录）
  for (const e of includeList) {
    if (isProtected(e.name)) { excludedHit.add(e.name); continue; }
    const cur = pool.get(e.name);
    if (cur) { cur.type = e.type || cur.type; cur.source = 'manual'; }
    else pool.set(e.name, { count: e.count || 0, source: 'manual', type: e.type || 'person' });
  }

  // —— 碎片剪枝（仅 ngram 来源；dialog/book 信号可靠不动）——
  // 若 X 的前缀扩展（或后缀扩展）候选的 count **合计** ≥ COVER×count(X)，说明 X 的出现
  // 大头都被更长词覆盖、几乎不独立出现 → 丢 X 保长。按合计而非单个判定（实测教训：
  // 「凛霄圣」1080 次 =「凛霄圣子」717 +「凛霄圣地」363，单个都不到 80% 但合计 99.6%）。
  //   「秦广」被「秦广林」吞（丢碎片、保全名）✓  「澜水」不被吞（独立使用多）✓
  const COVER = 0.8;
  const allNames = [...pool.keys()];
  const byHead = new Map(); // 首字 → 同首字候选（前缀扩展只可能发生在同首字之间）
  const byTail = new Map();
  for (const n of allNames) {
    if (!byHead.has(n[0])) byHead.set(n[0], []);
    byHead.get(n[0]).push(n);
    if (!byTail.has(n[n.length - 1])) byTail.set(n[n.length - 1], []);
    byTail.get(n[n.length - 1]).push(n);
  }
  const dropped = new Set();
  for (const x of allNames) {
    if (pool.get(x).source === 'manual') continue; // 人工确证不受任何剪枝
    const xc = pool.get(x).count;
    // 前缀虚词剥离（验收③，对全部非 manual 来源生效）：「如广寒仙子」「自荒古禁地」
    // 「信苍始大帝」——首字是纯功能字、去掉后主体是池中候选 → 跨词粘连碎片。
    if (x.length >= 4 && CONTEXT_HEADS.has(x[0]) && (pool.has(x.slice(1)) || pool.has(x.slice(2)))) {
      dropped.add(x);
      continue;
    }
    // 「专名+动词首字」碎片（对全部来源生效——「岳苍大」也能从对话信号混进来：
    // 「岳苍大道：」的贪婪捕获）：X 去尾字后是池中候选 P，且 count(X) ≤ 30%×count(P)。
    // 真扩展名不满足（「圣皇子」83%、「秦广林」~100%、「黄金狮子」~100%）。
    {
      const p = x.slice(0, -1);
      const pc = pool.get(p);
      if (pc && xc <= pc.count * 0.3) { dropped.add(x); continue; }
    }
    if (pool.get(x).source !== 'ngram') continue;
    let headSum = 0;
    for (const y of byHead.get(x[0]) || []) {
      if (y.length > x.length && y.startsWith(x)) headSum += pool.get(y).count;
    }
    if (headSum >= xc * COVER) { dropped.add(x); continue; }
    let tailSum = 0;
    for (const y of byTail.get(x[x.length - 1]) || []) {
      if (y.length > x.length && y.endsWith(x)) tailSum += pool.get(y).count;
    }
    if (tailSum >= xc * COVER) dropped.add(x);
  }

  // —— 规模控制：measure 上一次性实测每词条的独立掩码贡献，按 count 降序取最大前缀
  // 使占比 ≤ maxRatio。不做「累计到 2% 即停」（实测教训：头部主角专名一个就占 0.7%，
  // 提前停会把长尾次要专名全部漏掉——而次要人名正是去专名闸门要拦的泄漏源）；
  // 也不做多轮剪尾（一步砍过头没有回补，预算用不满）。dialog/book 是核心信号强制保留，
  // 小语料/高密度场景宁可如实超比例也不丢真专名（meta.measureRatio 如实记录）。
  const finalPool = [...pool.entries()]
    .filter(([n]) => !dropped.has(n) && !isProtected(n)) // EXCLUDED 兜底（各来源都已拦，多一道防回归）
    .map(([name, v]) => ({ name, count: v.count, source: v.source, type: v.type }))
    .sort((a, b) => b.count - a.count);
  const measure = texts.map((t) => t.slice(0, o.measureLimit)).join('\n');
  const measureHan = han(measure) || 1;
  const budget = o.maxRatio * measureHan;
  // 收录策略（实测校准的两段式）：
  //  ① dialog / book / pattern / manual 是核心信号，全部入典（模式信号数量大但每个贡献小；
  //     「宁可如实超比例也不丢真专名」，主代理点名的低频专名就靠这一层）；
  //  ② n-gram 长尾用「总预算 − 核心贡献」的剩余预算做二分截断（真实掩码占比 ≤ maxRatio）。
  // 不做「全池贪心后剪尾」：那会让低频 dialog/pattern 词条把整个池子拉满或反过来被截断。
  const core = finalPool.filter((e) => e.source !== 'ngram');
  const ng = finalPool.filter((e) => e.source === 'ngram');
  const coverageOf = (list) => maskCoverage(measure, list);
  let lo = 0;
  let hi = ng.length;
  if (ng.length) {
    // gram 近似（Σ len×count，重叠导致高估）放大 2 倍定位上界，避免首轮扫全池
    let approxAcc = 0;
    for (let i = 0; i < ng.length; i++) {
      approxAcc += ng[i].name.length * ng[i].count;
      if (approxAcc >= budget * 2) { hi = Math.min(ng.length, (i + 1) * 2); break; }
    }
    if (coverageOf(core.concat(ng.slice(0, hi))) <= budget) {
      lo = hi;
      if (lo < ng.length && coverageOf(core.concat(ng)) <= budget) lo = ng.length;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (coverageOf(core.concat(ng.slice(0, mid))) <= budget) lo = mid;
      else hi = mid - 1;
    }
  }
  const selected = core.concat(ng.slice(0, lo));
  const real = coverageOf(selected) / measureHan;
  // 预算分层的可审计量：core（include/dialog/book/pattern）不受预算约束，一旦它单独就顶到
  // maxRatio，n-gram 通道的剩余预算为负 → lo=0 整层出局。词条集变化因此是静默的，
  // 只在下面两个字段（与 CLI 告警）里看得见——消费方须按「空词表基线差集」逐个裁决。
  const coreCoverage = coverageOf(core) / measureHan;

  // 词条守卫（与占位符同形/含〔〕/非纯汉字 → 剔除并记入 meta，见 entryGuardReason）
  const droppedEntries = [];
  const entries = selected
    .map((e) => ({ name: e.name, type: e.type || classifyName(e.name, e.source), count: e.count }))
    .filter((e) => {
      const reason = entryGuardReason(e.name);
      if (reason) { droppedEntries.push({ name: e.name, reason }); return false; }
      return true;
    })
    .sort((a, b) => b.count - a.count);
  // version：对规范化内容（按 name 排序的 [name,type] 对）取 sha256 前 12 位
  const canon = entries
    .slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => [e.name, e.type]);
  const version = 'v1-' + sha256(JSON.stringify(canon)).slice(0, 12);
  return {
    version,
    entries,
    meta: {
      targetHan: tHan,
      contrastHan: cHan,
      poolSize: finalPool.length,
      selectedCount: entries.length,
      dialogCandidates: dialogs.length,
      bookCandidates: books.length,
      patternCandidates: patterns.length,
      includedCount: includeList.length,
      exclude: [...EXCLUDED],
      excludedHitCount: excludedHit.size,
      ngramCandidates: cand2.length + cand3.length + cand4.length,
      ngramPool: ng.length,
      ngramKept: lo,
      ngramDropped: ng.length - lo,
      coreCoverage,
      droppedFragments: dropped.size,
      droppedEntries,
      measureRatio: real,
      poolTop: finalPool.slice(0, 400).map((e) => [e.name, e.count, e.source]),
      opts: { ...o },
    },
  };
}

module.exports = {
  PLACEHOLDERS, loadInclude, loadWordlists, parseTypedNames,
  buildDict, dictStats,
  maskText, maskTextByRanges, verifySegments,
  maskDictPath, saveDict, loadDict,
  // 供测试/复核暴露的内部件（非契约 API）
  _internal: {
    isExcludedName, hasBadTail, classifyName, dialogCandidateOK, lcgSampleIndices, byLenDescNameAsc,
    count2grams, count3grams, count4grams, pickCandidates,
    extractDialogNames, extractBookNames, extractPatternNames, patternRootOK,
    STOP_WORDS, BAD_TAIL_WORDS, FRAG_CHARS, FUNC_CHARS, DIGIT_CHARS, APPELLATION_SET,
    TITLE_SUFFIXES, SECT_SUFFIXES, SKILL_SUFFIXES, VERB_HEADS,
    hasForbiddenSub, hasNumQuant, hasGenericTitleRoot, FORBIDDEN_SUBS, FORBIDDEN_CHARS_ANY,
    CONTEXT_HEADS, TITLE_ROOT_STOP, RE_NUM_DA, EVIDENCE_TAILS,
    entryGuardReason, mergeInclude,
  },
};
