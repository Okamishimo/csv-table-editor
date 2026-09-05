"use strict";

const MAX_SAMPLE_BYTES = 256 * 1024;

const LEGACY_ENCODINGS = [
  "shiftjis",
  "eucjp",
  "gbk",
  "big5",
  "euckr",
  "windows1258",
  "windows1252",
  "latin1",
];

const JAPANESE_COMMON = new Set(
  "日本年月日時分秒人名住所電話番号会社商品価格数量合計備考東京都大阪市区町村山川田中大小上下左右新古男女先生学校学生社員担当注文売買円"
);
const SIMPLIFIED_COMMON = new Set(
  "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工能下过子说产种面而方后多定行学法所民得经进着等部度家电力里如水化高自理起小物现实加量都两体制机当使点从业本去把性好应开合还因由其些然前外天政日社义事平形相全表间样与关各重新线内数正心明看原利比或但质气第向道命变条结解问意建月公系军情者最立代想已通并提直题程展果料象员位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别手角期根论运农指区强放决西被干做必战先回则任取据处理世车价教务编码文件字段数据测试总计名称城市电话联系"
);
const TRADITIONAL_COMMON = new Set(
  "的一是在不了有和人這中大為上個國我以要他時來用們生到作地於出就分對成會可主發年動同工能下過子說產種面而方後多定行學法所民得經進著等部度家電力裡如水化高自理起小物現實加量都兩體制機當使點從業本去把性好應開合還因由其些然前外天政日社義事平形相全表間樣與關各重新線內數正心明看原利比或但質氣第向道命變條結解問意建月公系軍情者最立代想已通並提直題程展果料象員位入常文總次品式活設及管特件長求老頭基資邊流路級少圖山統接知較將組見計別手角期根論運農指區強放決西被幹做必戰先回則任取據處理世車價教務編碼檔案欄位資料測試總計名稱城市電話聯絡臺灣"
);
const SMART_PUNCTUATION = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const VIETNAMESE_MARKERS = new Set("ĂăÂâĐđÊêÔôƠơƯư₫");
const KOREAN_COMMON = new Set(
  "가나다라마바사아자차카타파하의이그저것수있없되한사람우리때년월일시분초이름주소전화번호회사상품가격수량합계비고서울부산한국대한민국자료데이터파일인코딩테스트고객주문판매구매총계담당도시"
);

/**
 * Views the bytes as a Buffer without copying them. Detection only ever reads,
 * and `Buffer.from` would duplicate the whole file: for a 64 MiB CSV that is
 * 64 MiB of allocation and memcpy per call, on the extension host's only thread.
 */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return Buffer.from(input);
}

function detectEncoding(input, codec) {
  const bytes = toBuffer(input);
  const bom = detectBom(bytes);
  if (bom) return bom;
  if (bytes.length === 0 || isAscii(bytes)) return "utf8";

  const utf16 = detectUtf16WithoutBom(bytes);
  if (utf16) return utf16;
  if (isValidUtf8(bytes)) return "utf8";

  const selectedCodec = codec || require("iconv-lite");
  return rankLegacyEncodings(bytes, selectedCodec)[0].encoding;
}

function detectBom(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf8-bom";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le-bom";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be-bom";
  return null;
}

function isAscii(bytes) {
  // Indexed, not `for...of`: this scans every byte of the file, and the
  // iterator protocol costs about nine times as much for the same answer.
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (byte >= 0x80 || byte === 0) return false;
  }
  return true;
}

function detectUtf16WithoutBom(bytes) {
  const length = Math.min(bytes.length, MAX_SAMPLE_BYTES);
  const evenLength = length - (length % 2);
  if (evenLength < 4) return null;

  let evenNuls = 0;
  let oddNuls = 0;
  let leStructure = 0;
  let beStructure = 0;
  const structuralAscii = new Set([0x09, 0x0a, 0x0d, 0x22, 0x2c, 0x3b, 0x7c]);

  for (let index = 0; index < evenLength; index += 2) {
    const even = bytes[index];
    const odd = bytes[index + 1];
    if (even === 0) evenNuls++;
    if (odd === 0) oddNuls++;
    if (odd === 0 && structuralAscii.has(even)) leStructure++;
    if (even === 0 && structuralAscii.has(odd)) beStructure++;
  }

  const pairs = evenLength / 2;
  const totalNuls = evenNuls + oddNuls;
  if (totalNuls < 2) return null;

  const leDominance = oddNuls / totalNuls;
  const beDominance = evenNuls / totalNuls;
  const enoughLeEvidence = oddNuls / pairs >= 0.12 || leStructure >= 2;
  const enoughBeEvidence = evenNuls / pairs >= 0.12 || beStructure >= 2;

  if (leDominance >= 0.85 && enoughLeEvidence) return "utf16le";
  if (beDominance >= 0.85 && enoughBeEvidence) return "utf16be";
  return null;
}

function isValidUtf8(bytes) {
  for (let index = 0; index < bytes.length; index++) {
    const first = bytes[index];
    if (first <= 0x7f) continue;

    if (first >= 0xc2 && first <= 0xdf) {
      if (!isContinuation(bytes[index + 1])) return false;
      index += 1;
      continue;
    }

    if (first >= 0xe0 && first <= 0xef) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      if (!isContinuation(third)) return false;
      if (first === 0xe0 ? second < 0xa0 || second > 0xbf :
        first === 0xed ? second < 0x80 || second > 0x9f : !isContinuation(second)) {
        return false;
      }
      index += 2;
      continue;
    }

    if (first >= 0xf0 && first <= 0xf4) {
      const second = bytes[index + 1];
      if (!isContinuation(bytes[index + 2]) || !isContinuation(bytes[index + 3])) return false;
      if (first === 0xf0 ? second < 0x90 || second > 0xbf :
        first === 0xf4 ? second < 0x80 || second > 0x8f : !isContinuation(second)) {
        return false;
      }
      index += 3;
      continue;
    }

    return false;
  }
  return true;
}

function isContinuation(byte) {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function rankLegacyEncodings(input, codec) {
  // Sample first: only the sample is ever decoded, so copying the whole file
  // here would allocate megabytes to immediately discard 99% of them.
  const bytes = sampleBytes(toBuffer(input));
  return LEGACY_ENCODINGS
    .map((encoding) => scoreCandidate(bytes, encoding, codec))
    .sort((left, right) => right.score - left.score);
}

function sampleBytes(bytes) {
  if (bytes.length <= MAX_SAMPLE_BYTES) return bytes;
  return bytes.subarray(0, MAX_SAMPLE_BYTES);
}

function scoreCandidate(bytes, encoding, codec) {
  let text;
  try {
    text = codec.decode(bytes, encoding);
  } catch {
    return { encoding, score: Number.NEGATIVE_INFINITY };
  }

  const stats = analyzeText(text);
  const byteStats = analyzeByteSequences(bytes, encoding);
  let score = 0;

  score -= stats.replacements * 180;
  score -= stats.nuls * 240;
  score -= stats.controls * 55;
  score -= stats.privateUse * 20;
  score += csvStructureScore(text);

  if (byteStats.highBytes > 0) {
    const validRatio = byteStats.validHighBytes / byteStats.highBytes;
    score += validRatio * 120 - (1 - validRatio) * 260;
  }
  score += Math.min(byteStats.multibyteUnits, 10) * 2;

  try {
    const encoded = Buffer.from(codec.encode(text, encoding));
    const mismatchRate = byteMismatchRate(bytes, encoded);
    score += mismatchRate === 0 ? 70 : 20 - mismatchRate * 320;
  } catch {
    score -= 100;
  }

  score += languageScore(encoding, stats);
  score += encodingPrior(encoding);

  return { encoding, score, text, stats, byteStats };
}

function analyzeText(text) {
  const stats = {
    length: 0,
    nonAscii: 0,
    replacements: 0,
    nuls: 0,
    controls: 0,
    privateUse: 0,
    han: 0,
    kana: 0,
    hangul: 0,
    latin: 0,
    vietnamese: 0,
    japaneseCommon: 0,
    simplifiedCommon: 0,
    traditionalCommon: 0,
    koreanCommon: 0,
    smartPunctuation: 0,
  };

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    stats.length++;
    if (codePoint > 0x7f) stats.nonAscii++;
    if (character === "\ufffd") stats.replacements++;
    if (codePoint === 0) stats.nuls++;
    if ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)) stats.controls++;
    if ((codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
      (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
      (codePoint >= 0x100000 && codePoint <= 0x10fffd)) stats.privateUse++;
    if (isHan(codePoint)) stats.han++;
    if (isKana(codePoint)) stats.kana++;
    if (isHangul(codePoint)) stats.hangul++;
    if (isLatin(codePoint)) stats.latin++;
    if (isVietnamese(character, codePoint)) stats.vietnamese++;
    if (JAPANESE_COMMON.has(character)) stats.japaneseCommon++;
    if (SIMPLIFIED_COMMON.has(character)) stats.simplifiedCommon++;
    if (TRADITIONAL_COMMON.has(character)) stats.traditionalCommon++;
    if (KOREAN_COMMON.has(character)) stats.koreanCommon++;
    if (SMART_PUNCTUATION.has(character)) stats.smartPunctuation++;
  }
  return stats;
}

function isHan(codePoint) {
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3134f);
}

function isKana(codePoint) {
  return (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0xff65 && codePoint <= 0xff9f);
}

function isHangul(codePoint) {
  return (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af);
}

function isLatin(codePoint) {
  return (codePoint >= 0x0041 && codePoint <= 0x007a) ||
    (codePoint >= 0x00c0 && codePoint <= 0x024f) ||
    (codePoint >= 0x1e00 && codePoint <= 0x1eff);
}

function isVietnamese(character, codePoint) {
  if (VIETNAMESE_MARKERS.has(character)) return true;
  if (codePoint >= 0x1ea0 && codePoint <= 0x1ef9) return true;
  return codePoint === 0x0300 || codePoint === 0x0301 || codePoint === 0x0303 ||
    codePoint === 0x0309 || codePoint === 0x0323;
}

function languageScore(encoding, stats) {
  const nonAscii = Math.max(stats.nonAscii, 1);
  const hanOrKana = Math.max(stats.han + stats.kana, 1);

  switch (encoding) {
    case "shiftjis":
    case "eucjp":
      return stats.kana / nonAscii * 210 + stats.han / nonAscii * 55 +
        stats.japaneseCommon / hanOrKana * 150 + (stats.kana > 0 ? 35 : 0);
    case "gbk":
      return stats.han / nonAscii * 125 + stats.simplifiedCommon / Math.max(stats.han, 1) * 170;
    case "big5":
      return stats.han / nonAscii * 125 + stats.traditionalCommon / Math.max(stats.han, 1) * 170;
    case "euckr":
      return stats.hangul / nonAscii * 130 +
        stats.koreanCommon / Math.max(stats.hangul, 1) * 220 +
        (stats.koreanCommon > 0 ? 30 : -35);
    case "windows1258":
      return stats.vietnamese / nonAscii * 280 + (stats.vietnamese > 0 ? 35 : -25) +
        stats.latin / Math.max(stats.length, 1) * 35;
    case "windows1252":
      return stats.latin / Math.max(stats.length, 1) * 70 + stats.smartPunctuation * 3;
    case "latin1":
      return stats.latin / Math.max(stats.length, 1) * 65;
    default:
      return 0;
  }
}

function encodingPrior(encoding) {
  switch (encoding) {
    case "windows1252": return 18;
    case "latin1": return 2;
    case "windows1258": return -4;
    case "shiftjis": return 3;
    case "gbk":
    case "big5": return 1;
    default: return 0;
  }
}

function csvStructureScore(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0).slice(0, 40);
  if (lines.length === 0) return 0;

  let best = 0;
  for (const delimiter of [",", "\t", ";", "|"]) {
    const counts = lines.map((line) => countDelimiter(line, delimiter));
    const positive = counts.filter((count) => count > 0);
    if (positive.length === 0) continue;
    const frequencies = new Map();
    for (const count of positive) frequencies.set(count, (frequencies.get(count) || 0) + 1);
    const modeFrequency = Math.max(...frequencies.values());
    best = Math.max(best, modeFrequency / lines.length * 12);
  }
  return best;
}

function countDelimiter(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && line[index] === delimiter) {
      count++;
    }
  }
  return count;
}

function analyzeByteSequences(bytes, encoding) {
  if (encoding === "windows1252" || encoding === "windows1258" || encoding === "latin1") {
    let highBytes = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] >= 0x80) highBytes++;
    }
    return { highBytes, validHighBytes: highBytes, multibyteUnits: 0 };
  }

  let highBytes = 0;
  let validHighBytes = 0;
  let multibyteUnits = 0;
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index];
    if (byte < 0x80) {
      index++;
      continue;
    }
    highBytes++;

    let consumed = 0;
    if (encoding === "shiftjis") consumed = shiftJisSequenceLength(bytes, index);
    else if (encoding === "eucjp") consumed = eucJpSequenceLength(bytes, index);
    else if (encoding === "gbk") consumed = gbkSequenceLength(bytes, index);
    else if (encoding === "big5") consumed = big5SequenceLength(bytes, index);
    else if (encoding === "euckr") consumed = eucKrSequenceLength(bytes, index);

    if (consumed > 0) {
      validHighBytes += consumed;
      highBytes += consumed - 1;
      if (consumed > 1) multibyteUnits++;
      index += consumed;
    } else {
      index++;
    }
  }
  return { highBytes, validHighBytes, multibyteUnits };
}

function shiftJisSequenceLength(bytes, index) {
  const lead = bytes[index];
  if (lead >= 0xa1 && lead <= 0xdf) return 1;
  if (!((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc))) return 0;
  const trail = bytes[index + 1];
  return trail !== undefined && ((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfc)) ? 2 : 0;
}

function eucJpSequenceLength(bytes, index) {
  const lead = bytes[index];
  if (lead === 0x8e) return inRange(bytes[index + 1], 0xa1, 0xdf) ? 2 : 0;
  if (lead === 0x8f) {
    return inRange(bytes[index + 1], 0xa1, 0xfe) && inRange(bytes[index + 2], 0xa1, 0xfe) ? 3 : 0;
  }
  return inRange(lead, 0xa1, 0xfe) && inRange(bytes[index + 1], 0xa1, 0xfe) ? 2 : 0;
}

function gbkSequenceLength(bytes, index) {
  const lead = bytes[index];
  if (lead === 0x80) return 1;
  const trail = bytes[index + 1];
  return inRange(lead, 0x81, 0xfe) && trail !== undefined &&
    ((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfe)) ? 2 : 0;
}

function big5SequenceLength(bytes, index) {
  const lead = bytes[index];
  const trail = bytes[index + 1];
  return inRange(lead, 0x81, 0xfe) && trail !== undefined &&
    ((trail >= 0x40 && trail <= 0x7e) || (trail >= 0xa1 && trail <= 0xfe)) ? 2 : 0;
}

function eucKrSequenceLength(bytes, index) {
  return inRange(bytes[index], 0xa1, 0xfe) && inRange(bytes[index + 1], 0xa1, 0xfe) ? 2 : 0;
}

function inRange(value, minimum, maximum) {
  return value !== undefined && value >= minimum && value <= maximum;
}

function byteMismatchRate(left, right) {
  const maximum = Math.max(left.length, right.length, 1);
  let mismatches = Math.abs(left.length - right.length);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) mismatches++;
  }
  return mismatches / maximum;
}

module.exports = {
  detectEncoding,
  toBuffer,
  detectBom,
  detectUtf16WithoutBom,
  isValidUtf8,
  rankLegacyEncodings,
};
