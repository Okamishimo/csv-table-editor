"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const iconv = require("iconv-lite");
const {
  detectEncoding,
  detectUtf16WithoutBom,
  isValidUtf8,
} = require("../src/encoding-detector");

const CSV_SAMPLES = {
  shiftjis: "名前,都市,備考\r\n山田太郎,東京,日本語のテスト\r\n佐藤花子,大阪,株式会社サンプル\r\n",
  eucjp: "商品,価格,数量\nりんご,120,3\nみかん,80,5\n日本語データ,200,1\n",
  gbk: "姓名,城市,备注\r\n王小明,北京,简体中文测试\r\n李华,上海,编码数据\r\n",
  big5: "姓名,城市,備註\r\n王小明,臺北,繁體中文測試\r\n李美麗,高雄,編碼資料\r\n",
  euckr: "이름,도시,비고\r\n김민수,서울,한국어 테스트\r\n이서연,부산,인코딩 자료\r\n",
  windows1258: "Tên,Thành phố,Ghi chú\r\nNguyễn Văn An,Hà Nội,Dữ liệu tiếng Việt\r\nTrần Thị Mai,Đà Nẵng,Kiểm tra mã hóa\r\n",
  windows1252: "Name,City,Note\r\nAndré,Montréal,Café — résumé\r\nChloë,Zürich,Crème brûlée\r\n",
};

test("detects BOMs before applying heuristics", () => {
  assert.equal(detectEncoding(iconv.encode("a,b\n1,2", "utf8", { addBOM: true }), iconv), "utf8-bom");
  assert.equal(detectEncoding(iconv.encode("a,b\n1,2", "utf16le", { addBOM: true }), iconv), "utf16le-bom");
  assert.equal(detectEncoding(iconv.encode("a,b\n1,2", "utf16be", { addBOM: true }), iconv), "utf16be-bom");
});

test("detects empty and ASCII-only CSV as UTF-8", () => {
  assert.equal(detectEncoding(Buffer.alloc(0), iconv), "utf8");
  assert.equal(detectEncoding(Buffer.from("name,age\r\nAlice,30\r\n", "ascii"), iconv), "utf8");
});

test("strictly validates UTF-8", () => {
  assert.equal(isValidUtf8(Buffer.from("繁體中文、日本語、한국어", "utf8")), true);
  assert.equal(isValidUtf8(Buffer.from([0xc0, 0xaf])), false, "rejects overlong sequences");
  assert.equal(isValidUtf8(Buffer.from([0xed, 0xa0, 0x80])), false, "rejects surrogate code points");
  assert.equal(isValidUtf8(Buffer.from([0xf4, 0x90, 0x80, 0x80])), false, "rejects values above U+10FFFF");
});

test("detects UTF-8 without a BOM", () => {
  const bytes = Buffer.from("姓名,城市\n王小明,臺北\n山田太郎,東京\n", "utf8");
  assert.equal(detectEncoding(bytes, iconv), "utf8");
});

test("detects UTF-16 LE and BE without a BOM", () => {
  const text = "姓名,城市,備註\r\n王小明,臺北,測試資料\r\n";
  const littleEndian = iconv.encode(text, "utf16le");
  const bigEndian = iconv.encode(text, "utf16be");
  assert.equal(detectUtf16WithoutBom(littleEndian), "utf16le");
  assert.equal(detectUtf16WithoutBom(bigEndian), "utf16be");
  assert.equal(detectEncoding(littleEndian, iconv), "utf16le");
  assert.equal(detectEncoding(bigEndian, iconv), "utf16be");
});

for (const [encoding, text] of Object.entries(CSV_SAMPLES)) {
  test(`detects ${encoding}`, () => {
    const bytes = iconv.encode(text, encoding);
    assert.equal(detectEncoding(bytes, iconv), encoding);
  });
}

test("distinguishes short Kanji-only EUC-JP from EUC-KR", () => {
  const bytes = iconv.encode("氏名,住所\n山田太郎,東京都\n", "eucjp");
  assert.equal(detectEncoding(bytes, iconv), "eucjp");
});
